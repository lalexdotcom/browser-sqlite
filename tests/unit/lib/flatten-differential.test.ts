import { describe, expect, it } from 'vitest';
import { flatten } from '../../../src/flatten';
import { raceAbort } from '../../../src/queries';

/**
 * Today the consumer holds `layer(rowsOf(chunks))`; with `flatten` it holds
 * `flatten(layer(chunks))`. `layer` stands for what sits between the consumer
 * and the chunk source (`streamWithRetry`, `releasing`): a `for await` over its
 * input inside `try`/`catch`/`finally`. The two shapes run the same consumer
 * script over the same chunk source and are compared channel by channel, never
 * on the relative timing between channels.
 */

type Delay = 0 | 1 | 2 | 'timer';
type Variant = 'rethrow' | 'swallow' | 'wrap';
type Shape = 'today' | 'flatten';

type Op =
  | { op: 'next' } // awaited
  | { op: 'nextNA' } // not awaited
  | { op: 'two' } // two next() issued together, then both awaited
  | { op: 'drain' } // next() until done or an error
  | { op: 'return'; value?: number; promise?: 'resolve' | 'reject' }
  | { op: 'returnNA'; value?: number; promise?: 'resolve' | 'reject' }
  | { op: 'throw' }
  | { op: 'throwNA' }
  | { op: 'break' } // for await over the iterator, break at the first row
  | { op: 'bodyThrow' } // for await over the iterator, the body throws
  | { op: 'tick'; turns: number }
  // Waits for the previous call to settle and issues this one (not awaited)
  // from a `then` callback of that call.
  | { op: 'chain'; call: 'next' | 'return' | 'throw' }
  // The statement's own signal fires (savepointed scenarios). With
  // `settleBeforeAbort` set the op waits that many microtasks first, unless
  // `sync`: then it runs in the same synchronous run as the op before it.
  | { op: 'abort'; sync?: boolean };

/**
 * What the real layers do besides the loop: `releasing` waits (`queueWait`),
 * awaits `worker.quiesce()` in its `finally`, which may throw, and calls
 * `source.return()` once more there; `streamWithRetry` re-iterates a fresh
 * source once after a BUSY error that came before any value.
 */
interface LayerOptions {
  /** Microtask turns awaited before the loop, inside the `try`. */
  tryTurns?: number;
  /** Microtask turns awaited after each value, before it is yielded. */
  valueTurns?: number;
  /** Microtask turns awaited in the `finally`. */
  finallyTurns?: number;
  finallyThrows?: boolean;
  extraReturn?: boolean;
  /** The first source fails with BUSY before any chunk; the second is real. */
  retry?: boolean;
}

/** Chunk k holds `size` rows valued k * 100 + j. */
interface Scenario {
  chunks: { size: number; delay: Delay }[];
  errorAt: number | null;
  ops: Op[];
  layer?: LayerOptions;
  /**
   * The layer is `releasing`'s savepointed branch, racing a signal the
   * scenario's `abort` op fires; `layer` options and the variant do not apply.
   */
  savepointed?: boolean;
  /**
   * Microtask turns an `abort` op waits first (unless `sync`). An abort run in
   * the same synchronous run as a next() is deterministic and compared; one
   * issued from a microtask after a next() is a race: who wins depends on how
   * deep each shape's promise chain for that row is, and nobody can rely on it
   * (real aborts come from timers and events, which are macrotasks). So the
   * random space aborts at offset 0 or after the calls have settled.
   */
  settleBeforeAbort?: number;
}

/** One ordered list per channel; nothing orders one list against another. */
interface Trace {
  /** Each consumer call's settlement, in call order. */
  results: string[];
  /** The order in which the consumer's calls settled (call indexes). */
  order: number[];
  /** The calls made on the chunk source. */
  source: string[];
  /** What happened inside the chunk source. */
  sourceBody: string[];
  /** What reached `layer`, with a row or its chunk counted as one value. */
  layer: string[];
  /** How the abandoned source was drained (savepointed scenarios only). */
  drain?: string[];
}

const VARIANTS: Variant[] = ['rethrow', 'swallow', 'wrap'];

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const show = (result: IteratorResult<number, unknown>) =>
  `${result.done ? 'done' : 'value'} ${String(result.value)}`;

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const turns = async (count = 0) => {
  for (let i = 0; i < count; i++) await null;
};

const pause = async (delay: Delay) => {
  if (delay === 'timer') {
    await turn();
    return;
  }
  for (let i = 0; i < delay; i++) await null;
};

/**
 * The chunk source: real async generators behind a recording wrapper. `open()`
 * hands out one source per attempt; with `retry` the first one fails with BUSY.
 */
const makeSource = (scenario: Scenario) => {
  const source: string[] = [];
  const sourceBody: string[] = [];
  // biome-ignore lint/correctness/useYield: it fails before its first chunk
  async function* busy(): AsyncGenerator<number[], void, unknown> {
    try {
      await pause(scenario.chunks[0]?.delay ?? 0);
      sourceBody.push('error busy');
      throw new Error('busy');
    } finally {
      sourceBody.push('finally');
    }
  }
  async function* chunks(): AsyncGenerator<number[], void, unknown> {
    try {
      for (let k = 0; k <= scenario.chunks.length; k++) {
        const chunk = scenario.chunks[k];
        await pause(chunk?.delay ?? 0);
        if (scenario.errorAt === k) {
          sourceBody.push(`error ${k}`);
          throw new Error('source failed');
        }
        if (chunk === undefined) return;
        sourceBody.push(`yield ${k}`);
        yield Array.from({ length: chunk.size }, (_, j) => k * 100 + j);
      }
    } finally {
      sourceBody.push('finally');
    }
  }
  // Each call with whether it ended the generator (done, or an error). A
  // generator answers calls in order, so every call after the first that ended
  // it is a no-op: `live()` is the calls up to and including that one.
  const entries: { call: string; ended: boolean }[] = [];
  const live = () => {
    const calls: string[] = [];
    for (const entry of entries) {
      calls.push(entry.call);
      if (entry.ended) break;
    }
    return calls;
  };
  const record = (generator: AsyncGenerator<number[], void, unknown>) => {
    const log = (
      call: string,
      result: Promise<IteratorResult<number[], void>>,
    ) => {
      source.push(call);
      const entry = { call, ended: false };
      entries.push(entry);
      result.then(
        (step) => {
          entry.ended = step.done === true;
        },
        () => {
          entry.ended = true;
        },
      );
      return result;
    };
    const wrapped: AsyncGenerator<number[], void, unknown> = {
      next: (...args) => log('next', generator.next(...args)),
      return: (value) => log('return', generator.return(value)),
      throw: (error) => log('throw', generator.throw(error)),
      [Symbol.asyncIterator]: () => wrapped,
      [Symbol.asyncDispose]: () => generator[Symbol.asyncDispose](),
    };
    return wrapped;
  };
  let attempts = 0;
  const open = () =>
    record(scenario.layer?.retry && attempts++ === 0 ? busy() : chunks());
  return { open, source, live, sourceBody };
};

/** The row-flattening generator `flatten` replaces. */
async function* rowsOf(
  source: AsyncGenerator<number[], void, unknown>,
): AsyncGenerator<number, void, unknown> {
  for await (const chunk of source) for (const row of chunk) yield row;
}

/**
 * The layer between consumer and chunk source. `mark` names the chunk a value
 * belongs to, or null for a value that holds no row.
 */
async function* layer<V>(
  open: () => AsyncGenerator<V, void, unknown>,
  events: string[],
  mark: (value: V) => number | null,
  variant: Variant,
  options: LayerOptions,
): AsyncGenerator<V, void, unknown> {
  for (let attempt = 1; ; attempt++) {
    let delivered = false;
    const input = open();
    try {
      if (options.tryTurns) await turns(options.tryTurns);
      try {
        for await (const value of input) {
          delivered = true;
          const chunk = mark(value);
          if (chunk !== null) events.push(`value ${chunk}`);
          if (options.valueTurns) await turns(options.valueTurns);
          yield value;
        }
      } finally {
        if (options.extraReturn) await input.return(undefined);
      }
      return;
    } catch (error) {
      events.push(`catch ${message(error)}`);
      if (
        options.retry &&
        !delivered &&
        attempt === 1 &&
        message(error) === 'busy'
      ) {
        continue;
      }
      if (variant === 'rethrow') throw error;
      if (variant === 'wrap') throw new Error(`wrapped ${message(error)}`);
      return;
    } finally {
      events.push('finally');
      if (options.finallyTurns) await turns(options.finallyTurns);
      // biome-ignore lint/correctness/noUnsafeFinally: `releasing`'s finally can throw (dieIfConnectionLeft)
      if (options.finallyThrows) throw new Error('finally failed');
    }
  }
}

/**
 * `releasing`'s savepointed branch (src/transaction.ts): the signal is checked
 * at the start and raced against each `source.next()`; an abort that reaches
 * the loop marks the statement left, drains the rest of the source in the
 * background (`drainToEnd`) and rethrows; otherwise the `finally` closes the
 * source. `drain` records how that background drain ended.
 */
async function* savepointedLayer<V>(
  source: AsyncGenerator<V, void, unknown>,
  events: string[],
  mark: (value: V) => number | null,
  signal: AbortSignal,
  drain: string[],
  drains: Promise<void>[],
): AsyncGenerator<V, void, unknown> {
  const drainToEnd = async () => {
    try {
      for (;;) {
        if ((await source.next()).done) break;
      }
      drain.push('drained');
    } catch (error) {
      drain.push(`drain failed ${message(error)}`);
    }
  };
  let left = false;
  try {
    signal.throwIfAborted();
    try {
      for (;;) {
        const next = await raceAbort(signal, source.next());
        if (next.done) return;
        const chunk = mark(next.value);
        if (chunk !== null) events.push(`value ${chunk}`);
        yield next.value;
      }
    } catch (error) {
      if (error === signal.reason) {
        left = true;
        events.push('abandon');
        drains.push(drainToEnd());
      }
      throw error;
    } finally {
      if (!left) await source.return(undefined);
    }
  } catch (error) {
    events.push(`catch ${message(error)}`);
    throw error;
  } finally {
    events.push('finally');
  }
}

/** Consecutive rows of one chunk are one value; a chunk is one value. */
const collapse = (events: string[]) =>
  events.filter(
    (event, i) => !(event.startsWith('value ') && events[i - 1] === event),
  );

const chunkOfRow = (row: number) => Math.floor(row / 100);
const chunkOfChunk = (chunk: number[]) =>
  chunk.length > 0 ? chunkOfRow(chunk[0] as number) : null;

const consume = async (
  iterator: AsyncGenerator<number, void, unknown>,
  ops: Op[],
  abort: () => void,
  settleBeforeAbort = 0,
) => {
  const results: string[] = [];
  const order: number[] = [];
  const outstanding: Promise<unknown>[] = [];
  // How often a next() or a return()/throw() was issued while a next() result
  // was still pending.
  const overlap = { nextNext: 0, closeDuringNext: 0 };
  let pendingNext = 0;
  const track = (
    kind: 'next' | 'close',
    promise: Promise<IteratorResult<number, void>>,
  ) => {
    const index = results.length;
    results.push('pending');
    if (pendingNext > 0) {
      overlap[kind === 'next' ? 'nextNext' : 'closeDuringNext']++;
    }
    if (kind === 'next') pendingNext++;
    const settled = () => {
      order.push(index);
      if (kind === 'next') pendingNext--;
    };
    const tracked = promise.then(
      (result) => {
        results[index] = show(result);
        settled();
        return result;
      },
      (error: unknown) => {
        results[index] = `error ${message(error)}`;
        settled();
        throw error;
      },
    );
    lastTracked = tracked;
    return tracked;
  };
  let lastTracked: Promise<unknown> | undefined;
  const quiet = (promise: Promise<unknown>) => promise.then(noop, noop);
  const issue = (call: 'next' | 'return' | 'throw') =>
    quiet(
      call === 'next'
        ? track('next', iterator.next())
        : track(
            'close',
            call === 'return' ? iterator.return() : iterator.throw(failure()),
          ),
    );
  const noop = () => undefined;
  const failure = () => new Error(`thrown ${results.length}`);
  // What a JavaScript caller may hand to return(): nothing, a value, or a
  // promise of one that resolves or rejects (`error value n`).
  const returnArgument = (step: {
    value?: number;
    promise?: 'resolve' | 'reject';
  }): never => {
    if (step.promise === 'resolve') {
      return Promise.resolve(step.value) as never;
    }
    if (step.promise === 'reject') {
      const rejected = Promise.reject(new Error(`value ${step.value}`));
      // Handled here so a layer that never awaits it is not an unhandled error.
      rejected.catch(noop);
      return rejected as never;
    }
    return step.value as never;
  };
  const probe: AsyncIterable<number> = {
    [Symbol.asyncIterator]: () => ({
      next: () => track('next', iterator.next()),
      return: (value?: unknown) =>
        track('close', iterator.return(value as never)),
    }),
  };

  for (const step of ops) {
    switch (step.op) {
      case 'next':
        await quiet(track('next', iterator.next()));
        break;
      case 'nextNA':
        outstanding.push(quiet(track('next', iterator.next())));
        break;
      case 'two':
        await Promise.all([
          quiet(track('next', iterator.next())),
          quiet(track('next', iterator.next())),
        ]);
        break;
      case 'drain':
        for (;;) {
          try {
            if ((await track('next', iterator.next())).done) break;
          } catch {
            break;
          }
        }
        break;
      case 'return':
        await quiet(track('close', iterator.return(returnArgument(step))));
        break;
      case 'returnNA':
        outstanding.push(
          quiet(track('close', iterator.return(returnArgument(step)))),
        );
        break;
      case 'throw':
        await quiet(track('close', iterator.throw(failure())));
        break;
      case 'throwNA':
        outstanding.push(quiet(track('close', iterator.throw(failure()))));
        break;
      case 'break':
        try {
          for await (const _row of probe) break;
        } catch {}
        break;
      case 'bodyThrow':
        try {
          for await (const _row of probe) throw new Error('body failed');
        } catch {}
        break;
      case 'tick':
        for (let i = 0; i < step.turns; i++) await null;
        break;
      case 'chain': {
        // The script waits for the call to be issued, so the order of the
        // calls does not depend on how long each shape takes to settle one.
        const previous = lastTracked;
        await new Promise<void>((resolve) => {
          const go = () => {
            outstanding.push(issue(step.call));
            resolve();
          };
          if (previous) previous.then(go, go);
          else go();
        });
        break;
      }
      case 'abort':
        if (settleBeforeAbort > 0 && !step.sync) await turns(settleBeforeAbort);
        abort();
        break;
    }
  }
  await Promise.all(outstanding);
  // Whatever a settled call left running (a `finally`) gets time to finish.
  for (let i = 0; i < 20; i++) await null;
  return { results, order, overlap };
};

const run = async (scenario: Scenario, variant: Variant, shape: Shape) => {
  const { open, source, live, sourceBody } = makeSource(scenario);
  const events: string[] = [];
  const options = scenario.layer ?? {};
  const controller = new AbortController();
  const { signal } = controller;
  const drain: string[] = [];
  const drains: Promise<void>[] = [];
  const iterator = scenario.savepointed
    ? shape === 'today'
      ? savepointedLayer(
          rowsOf(open()),
          events,
          chunkOfRow,
          signal,
          drain,
          drains,
        )
      : flatten(
          savepointedLayer(open(), events, chunkOfChunk, signal, drain, drains),
          { signal },
        )
    : shape === 'today'
      ? layer(() => rowsOf(open()), events, chunkOfRow, variant, options)
      : flatten(layer(open, events, chunkOfChunk, variant, options));
  const { results, order, overlap } = await consume(
    iterator,
    scenario.ops,
    () => controller.abort(new Error('aborted')),
    scenario.settleBeforeAbort,
  );
  await Promise.all(drains);
  const trace: Trace = {
    results,
    order,
    // `releasing` closes its input once more in its `finally`, and the
    // savepointed branch drains its input after an abort. Today that input is
    // `rowsOf`, already finished, so the chunk source is not called again; with
    // `flatten` the input is the chunk source itself, and the extra call lands
    // on the recording wrapper, a no-op on a real generator that has finished.
    // When the layer does this, the channel keeps the calls up to the one that
    // ended the generator (see `live`).
    source: options.extraReturn || scenario.savepointed ? live() : source,
    sourceBody,
    layer: collapse(events),
    ...(scenario.savepointed ? { drain } : {}),
  };
  return { trace, overlap };
};

const both = async (scenario: Scenario, variant: Variant) => {
  const today = await run(scenario, variant, 'today');
  const flattened = await run(scenario, variant, 'flatten');
  return {
    today: today.trace,
    flattened: flattened.trace,
    overlap: today.overlap,
  };
};

/** Runs the scenario in every layer variant and requires equal traces. */
const sameInEveryVariant = async (scenario: Scenario) => {
  const traces: Record<Variant, Trace> = {} as Record<Variant, Trace>;
  for (const variant of VARIANTS) {
    const { today, flattened } = await both(scenario, variant);
    expect(flattened, variant).toEqual(today);
    traces[variant] = today;
  }
  return traces;
};

/** mulberry32 */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The consumer's calls settled in the order they were made. */
const inCallOrder = (order: number[]) =>
  order.every((index, i) => i === 0 || (order[i - 1] as number) < index);

/** Runs a savepointed scenario and requires equal traces. */
const sameSavepointed = async (scenario: Omit<Scenario, 'savepointed'>) => {
  const { today, flattened } = await both(
    { ...scenario, savepointed: true },
    'rethrow',
  );
  expect(flattened).toEqual(today);
  return today;
};

const sizes = (...list: number[]) =>
  list.map((size) => ({ size, delay: 0 as const }));

describe('flatten against the generator chain it replaces', () => {
  it('reads 2 rows of one chunk then breaks', async () => {
    const traces = await sameInEveryVariant({
      chunks: sizes(3),
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'break' }],
    });
    expect(traces.rethrow).toEqual({
      results: ['value 0', 'value 1', 'done undefined'],
      order: [0, 1, 2],
      source: ['next', 'return'],
      sourceBody: ['yield 0', 'finally'],
      layer: ['value 0', 'finally'],
    });
  });

  it('returns in the middle of a chunk', async () => {
    const traces = await sameInEveryVariant({
      chunks: sizes(3, 2),
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'return' }, { op: 'next' }],
    });
    expect(traces.rethrow).toEqual({
      results: ['value 0', 'done undefined', 'done undefined'],
      order: [0, 1, 2],
      source: ['next', 'return'],
      sourceBody: ['yield 0', 'finally'],
      layer: ['value 0', 'finally'],
    });
  });

  it('throws in the middle of a chunk', async () => {
    const traces = await sameInEveryVariant({
      chunks: sizes(3, 2),
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'throw' }, { op: 'next' }],
    });
    expect(traces.rethrow).toEqual({
      results: ['value 0', 'error thrown 1', 'done undefined'],
      order: [0, 1, 2],
      source: ['next', 'return'],
      sourceBody: ['yield 0', 'finally'],
      layer: ['value 0', 'catch thrown 1', 'finally'],
    });
    expect(traces.swallow.results).toEqual([
      'value 0',
      'done undefined',
      'done undefined',
    ]);
    expect(traces.wrap.results[1]).toBe('error wrapped thrown 1');
  });

  it('fails at the second chunk', async () => {
    const traces = await sameInEveryVariant({
      chunks: sizes(2, 2, 2),
      errorAt: 1,
      ops: [{ op: 'next' }, { op: 'next' }, { op: 'next' }, { op: 'next' }],
    });
    expect(traces.rethrow).toEqual({
      results: ['value 0', 'value 1', 'error source failed', 'done undefined'],
      order: [0, 1, 2, 3],
      source: ['next', 'next'],
      sourceBody: ['yield 0', 'error 1', 'finally'],
      layer: ['value 0', 'catch source failed', 'finally'],
    });
    expect(traces.swallow.results).toEqual([
      'value 0',
      'value 1',
      'done undefined',
      'done undefined',
    ]);
  });

  it('throws in the consumer loop body after row 2', async () => {
    const traces = await sameInEveryVariant({
      chunks: sizes(3),
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'bodyThrow' }],
    });
    expect(traces.rethrow).toEqual({
      results: ['value 0', 'value 1', 'done undefined'],
      order: [0, 1, 2],
      source: ['next', 'return'],
      sourceBody: ['yield 0', 'finally'],
      layer: ['value 0', 'finally'],
    });
  });

  it('reads to the end over chunks with empty ones', async () => {
    const traces = await sameInEveryVariant({
      chunks: sizes(1, 2, 0, 1),
      errorAt: null,
      ops: [{ op: 'drain' }],
    });
    expect(traces.rethrow).toEqual({
      results: [
        'value 0',
        'value 100',
        'value 101',
        'value 300',
        'done undefined',
      ],
      order: [0, 1, 2, 3, 4],
      source: ['next', 'next', 'next', 'next', 'next'],
      sourceBody: ['yield 0', 'yield 1', 'yield 2', 'yield 3', 'finally'],
      layer: ['value 0', 'value 1', 'value 3', 'finally'],
    });
  });

  it('returns or throws before the first next()', async () => {
    const returned = await sameInEveryVariant({
      chunks: sizes(2),
      errorAt: null,
      ops: [{ op: 'return' }, { op: 'next' }],
    });
    expect(returned.rethrow).toEqual({
      results: ['done undefined', 'done undefined'],
      order: [0, 1],
      source: [],
      sourceBody: [],
      layer: [],
    });
    const thrown = await sameInEveryVariant({
      chunks: sizes(2),
      errorAt: null,
      ops: [{ op: 'throw' }, { op: 'next' }],
    });
    expect(thrown.rethrow).toEqual({
      results: ['error thrown 0', 'done undefined'],
      order: [0, 1],
      source: [],
      sourceBody: [],
      layer: [],
    });
  });

  it('answers next() after done without touching the source again', async () => {
    const traces = await sameInEveryVariant({
      chunks: sizes(1),
      errorAt: null,
      ops: [{ op: 'drain' }, { op: 'next' }, { op: 'next' }],
    });
    expect(traces.rethrow.results).toEqual([
      'value 0',
      'done undefined',
      'done undefined',
      'done undefined',
    ]);
    expect(traces.rethrow.source).toEqual(['next', 'next']);
  });

  it('answers return(v) on an ended iterator with v and no source call', async () => {
    const ended = await sameInEveryVariant({
      chunks: sizes(1),
      errorAt: null,
      ops: [{ op: 'drain' }, { op: 'return', value: 7 }],
    });
    expect(ended.rethrow.results).toEqual([
      'value 0',
      'done undefined',
      'done 7',
    ]);
    expect(ended.rethrow.source).toEqual(['next', 'next']);
    const failed = await sameInEveryVariant({
      chunks: sizes(1, 1),
      errorAt: 1,
      ops: [{ op: 'drain' }, { op: 'return', value: 8 }],
    });
    expect(failed.rethrow.results[2]).toBe('done 8');
    expect(failed.rethrow.source).toEqual(['next', 'next']);
    const returned = await sameInEveryVariant({
      chunks: sizes(2),
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'return' }, { op: 'return', value: 9 }],
    });
    expect(returned.rethrow.results).toEqual([
      'value 0',
      'done undefined',
      'done 9',
    ]);
    expect(returned.rethrow.source).toEqual(['next', 'return']);
  });

  it('answers return(v) before the first next() and on an open iterator', async () => {
    const unstarted = await sameInEveryVariant({
      chunks: sizes(2),
      errorAt: null,
      ops: [{ op: 'return', value: 5 }, { op: 'next' }],
    });
    expect(unstarted.rethrow.results).toEqual(['done 5', 'done undefined']);
    expect(unstarted.rethrow.source).toEqual([]);
    const open = await sameInEveryVariant({
      chunks: sizes(2),
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'return', value: 6 }],
    });
    expect(open.rethrow.results).toEqual(['value 0', 'done 6']);
    expect(open.rethrow.source).toEqual(['next', 'return']);
  });

  it('throws a rejecting return(v) into the layer of an open iterator', async () => {
    const traces = await sameInEveryVariant({
      chunks: sizes(3, 2),
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'return', value: 5, promise: 'reject' }],
    });
    expect(traces.rethrow).toEqual({
      results: ['value 0', 'error value 5'],
      order: [0, 1],
      source: ['next', 'return'],
      sourceBody: ['yield 0', 'finally'],
      layer: ['value 0', 'catch value 5', 'finally'],
    });
    expect(traces.swallow.results).toEqual(['value 0', 'done undefined']);
    expect(traces.swallow.layer).toEqual([
      'value 0',
      'catch value 5',
      'finally',
    ]);
    expect(traces.wrap.results).toEqual(['value 0', 'error wrapped value 5']);
    const resolved = await sameInEveryVariant({
      chunks: sizes(3),
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'return', value: 6, promise: 'resolve' }],
    });
    expect(resolved.rethrow.results).toEqual(['value 0', 'done 6']);
    // Idle and ended: the rejection never reaches the layer.
    const idle = await sameInEveryVariant({
      chunks: sizes(3),
      errorAt: null,
      ops: [{ op: 'return', value: 7, promise: 'reject' }],
    });
    expect(idle.rethrow).toEqual({
      results: ['error value 7'],
      order: [0],
      source: [],
      sourceBody: [],
      layer: [],
    });
    const ended = await sameInEveryVariant({
      chunks: sizes(1),
      errorAt: null,
      ops: [{ op: 'drain' }, { op: 'return', value: 8, promise: 'reject' }],
    });
    expect(ended.rethrow.results[2]).toBe('error value 8');
    expect(ended.rethrow.layer).toEqual(['value 0', 'finally']);
  });

  it('serves two next() not awaited, with a slow chunk', async () => {
    const traces = await sameInEveryVariant({
      chunks: [
        { size: 1, delay: 'timer' },
        { size: 2, delay: 2 },
      ],
      errorAt: null,
      ops: [{ op: 'two' }, { op: 'next' }, { op: 'next' }],
    });
    expect(traces.rethrow.results).toEqual([
      'value 0',
      'value 100',
      'value 101',
      'done undefined',
    ]);
    expect(traces.rethrow.source).toEqual(['next', 'next', 'next']);
  });

  it('closes after a pending next() when return() is issued meanwhile', async () => {
    const traces = await sameInEveryVariant({
      chunks: [{ size: 3, delay: 'timer' }],
      errorAt: null,
      ops: [{ op: 'nextNA' }, { op: 'returnNA', value: 3 }, { op: 'next' }],
    });
    expect(traces.rethrow).toEqual({
      results: ['value 0', 'done 3', 'done undefined'],
      order: [0, 1, 2],
      source: ['next', 'return'],
      sourceBody: ['yield 0', 'finally'],
      layer: ['value 0', 'finally'],
    });
  });

  it('delivers throw() issued while a next() is pending after that next()', async () => {
    const traces = await sameInEveryVariant({
      chunks: [{ size: 3, delay: 'timer' }],
      errorAt: null,
      ops: [{ op: 'nextNA' }, { op: 'throwNA' }, { op: 'next' }],
    });
    expect(traces.rethrow).toEqual({
      results: ['value 0', 'error thrown 1', 'done undefined'],
      order: [0, 1, 2],
      source: ['next', 'return'],
      sourceBody: ['yield 0', 'finally'],
      layer: ['value 0', 'catch thrown 1', 'finally'],
    });
  });

  it('rejects a savepointed stream with the abort before a buffered row', async () => {
    const trace = await sameSavepointed({
      chunks: sizes(3, 2),
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'abort' }, { op: 'next' }, { op: 'next' }],
    });
    expect(trace).toEqual({
      results: ['value 0', 'error aborted', 'done undefined'],
      order: [0, 1, 2],
      source: ['next', 'next', 'next'],
      sourceBody: ['yield 0', 'yield 1', 'finally'],
      layer: ['value 0', 'abandon', 'catch aborted', 'finally'],
      drain: ['drained'],
    });
  });

  it('rejects a savepointed stream with the abort at a chunk boundary', async () => {
    const trace = await sameSavepointed({
      chunks: sizes(2, 2),
      errorAt: null,
      ops: [
        { op: 'next' },
        { op: 'next' },
        { op: 'abort' },
        { op: 'next' },
        { op: 'next' },
      ],
    });
    expect(trace).toEqual({
      results: ['value 0', 'value 1', 'error aborted', 'done undefined'],
      order: [0, 1, 2, 3],
      source: ['next', 'next', 'next'],
      sourceBody: ['yield 0', 'yield 1', 'finally'],
      layer: ['value 0', 'abandon', 'catch aborted', 'finally'],
      drain: ['drained'],
    });
  });

  it('rejects two pending next() with the abort and drains the source', async () => {
    const trace = await sameSavepointed({
      chunks: [
        { size: 1, delay: 0 },
        { size: 2, delay: 'timer' },
        { size: 1, delay: 0 },
      ],
      errorAt: null,
      ops: [
        { op: 'next' },
        { op: 'nextNA' },
        { op: 'nextNA' },
        { op: 'abort' },
        { op: 'next' },
      ],
    });
    expect(trace).toEqual({
      results: ['value 0', 'error aborted', 'done undefined', 'done undefined'],
      order: [0, 1, 2, 3],
      source: ['next', 'next', 'next', 'next'],
      sourceBody: ['yield 0', 'yield 1', 'yield 2', 'finally'],
      layer: ['value 0', 'abandon', 'catch aborted', 'finally'],
      drain: ['drained'],
    });
  });

  it('rejects the first next() with an abort run in the same synchronous run', async () => {
    // The layer starts inside next(), so the source is already asked for a
    // chunk when the signal fires: abandoned and drained, not never started.
    const trace = await sameSavepointed({
      chunks: [
        { size: 2, delay: 'timer' },
        { size: 2, delay: 0 },
      ],
      errorAt: null,
      ops: [{ op: 'nextNA' }, { op: 'abort' }, { op: 'next' }],
    });
    expect(trace).toEqual({
      results: ['error aborted', 'done undefined'],
      order: [0, 1],
      source: ['next', 'next', 'next'],
      sourceBody: ['yield 0', 'yield 1', 'finally'],
      layer: ['abandon', 'catch aborted', 'finally'],
      drain: ['drained'],
    });
  });

  it('rejects a buffered row with an abort run in the same synchronous run as its next()', async () => {
    // The row is in the buffer when next() is called; the abort still wins.
    const trace = await sameSavepointed({
      chunks: sizes(4, 4),
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'nextNA' }, { op: 'abort' }, { op: 'next' }],
    });
    expect(trace).toEqual({
      results: ['value 0', 'error aborted', 'done undefined'],
      order: [0, 1, 2],
      source: ['next', 'next', 'next'],
      sourceBody: ['yield 0', 'yield 1', 'finally'],
      layer: ['value 0', 'abandon', 'catch aborted', 'finally'],
      drain: ['drained'],
    });
  });

  it('rejects an empty-buffer next() with an abort run in the same synchronous run', async () => {
    const trace = await sameSavepointed({
      chunks: [
        { size: 1, delay: 0 },
        { size: 2, delay: 'timer' },
        { size: 1, delay: 0 },
      ],
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'nextNA' }, { op: 'abort' }, { op: 'next' }],
    });
    expect(trace).toEqual({
      results: ['value 0', 'error aborted', 'done undefined'],
      order: [0, 1, 2],
      source: ['next', 'next', 'next', 'next'],
      sourceBody: ['yield 0', 'yield 1', 'yield 2', 'finally'],
      layer: ['value 0', 'abandon', 'catch aborted', 'finally'],
      drain: ['drained'],
    });
  });

  it('closes the source when return() follows an abort nobody saw yet', async () => {
    const closed = {
      results: ['value 0', 'done undefined', 'done undefined'],
      order: [0, 1, 2],
      source: ['next', 'return'],
      sourceBody: ['yield 0', 'finally'],
      layer: ['value 0', 'finally'],
      drain: [],
    };
    expect(
      await sameSavepointed({
        chunks: sizes(3, 2),
        errorAt: null,
        ops: [
          { op: 'next' },
          { op: 'abort' },
          { op: 'return' },
          { op: 'next' },
        ],
      }),
    ).toEqual(closed);
    // A return() queued before the abort lands is settled the same way.
    expect(
      await sameSavepointed({
        chunks: sizes(3, 2),
        errorAt: null,
        ops: [
          { op: 'next' },
          { op: 'returnNA' },
          { op: 'abort' },
          { op: 'next' },
        ],
      }),
    ).toEqual(closed);
  });

  it('closes the source on a throw(e) that is not the abort reason', async () => {
    const trace = await sameSavepointed({
      chunks: sizes(3, 2),
      errorAt: null,
      ops: [{ op: 'next' }, { op: 'throw' }, { op: 'next' }],
    });
    expect(trace).toEqual({
      results: ['value 0', 'error thrown 1', 'done undefined'],
      order: [0, 1, 2],
      source: ['next', 'return'],
      sourceBody: ['yield 0', 'finally'],
      layer: ['value 0', 'catch thrown 1', 'finally'],
      drain: [],
    });
  });

  it('rejects with the abort before the first next() and never touches the source', async () => {
    const trace = await sameSavepointed({
      chunks: sizes(3, 2),
      errorAt: null,
      ops: [{ op: 'abort' }, { op: 'next' }, { op: 'next' }],
    });
    expect(trace).toEqual({
      results: ['error aborted', 'done undefined'],
      order: [0, 1],
      source: [],
      sourceBody: [],
      layer: ['catch aborted', 'finally'],
      drain: [],
    });
  });

  it('reports a source error met while draining an abandoned stream', async () => {
    const trace = await sameSavepointed({
      chunks: sizes(2, 2),
      errorAt: 1,
      ops: [{ op: 'next' }, { op: 'abort' }, { op: 'next' }],
    });
    expect(trace).toEqual({
      results: ['value 0', 'error aborted'],
      order: [0, 1],
      source: ['next', 'next'],
      sourceBody: ['yield 0', 'error 1', 'finally'],
      layer: ['value 0', 'abandon', 'catch aborted', 'finally'],
      drain: ['drain failed source failed'],
    });
  });

  it('matches over a seeded random comparison with a signal', async () => {
    const CASES = 4000;
    const BASE_SEED = 20271019;

    const generate = (seed: number): Scenario => {
      const random = prng(seed);
      const int = (n: number) => Math.floor(random() * n);
      const delay = (): Delay => {
        const r = random();
        if (r < 0.4) return 0;
        if (r < 0.65) return 1;
        if (r < 0.95) return 2;
        return 'timer';
      };
      const chunks = Array.from({ length: 1 + int(8) }, () => ({
        size: int(5),
        delay: delay(),
      }));
      const errorAt = random() < 0.25 ? int(chunks.length + 1) : null;
      const call = () =>
        (['next', 'return', 'throw'] as const)[int(3)] ?? 'next';
      // A fetch the abort abandons spans the empty chunks today (`rowsOf`
      // skips them) but only one chunk with `flatten`, so a source error right
      // after an empty chunk is swallowed by that fetch today and met by the
      // drain with `flatten`. Empty chunks do not precede an error in practice;
      // the random space keeps a row there.
      if (errorAt !== null && errorAt > 0 && chunks[errorAt - 1]?.size === 0) {
        (chunks[errorAt - 1] as { size: number }).size = 1;
      }
      const op = (): Op => {
        const r = random() * 100;
        if (r < 28) return { op: 'next' };
        if (r < 40) return { op: 'nextNA' };
        if (r < 48) return { op: 'two' };
        if (r < 54) return { op: 'drain' };
        if (r < 61) return { op: 'return' };
        if (r < 66) return { op: 'returnNA' };
        if (r < 72) return { op: 'throw' };
        if (r < 76) return { op: 'throwNA' };
        if (r < 79) return { op: 'break' };
        if (r < 81) return { op: 'bodyThrow' };
        if (r < 88) return { op: 'tick', turns: int(8) };
        if (r < 95) return { op: 'chain', call: call() };
        return { op: 'abort' };
      };
      const ops = Array.from({ length: 1 + int(8) }, op);
      // Every case aborts once, at a random point between the consumer's ops:
      // half of them settled, half in the same synchronous run as an
      // unawaited next() (offset 0, with a buffered row or without).
      if (random() < 0.5) {
        ops.splice(int(ops.length + 1), 0, { op: 'abort' });
      } else {
        ops.splice(
          int(ops.length + 1),
          0,
          // Earlier unawaited calls settle first: they would sit at an offset.
          { op: 'tick', turns: 30 },
          { op: 'nextNA' },
          { op: 'abort', sync: true },
        );
      }
      return { chunks, errorAt, ops, savepointed: true, settleBeforeAbort: 30 };
    };

    const seen = {
      abandoned: 0,
      drained: 0,
      drainFailed: 0,
      abortedBeforeStart: 0,
      closedAfterAbort: 0,
      errors: 0,
      values: 0,
      nextWhileNextPending: 0,
      closeWhileNextPending: 0,
      syncAbort: 0,
      syncAbortAbandoned: 0,
      chained: 0,
      longTick: 0,
    };
    for (let i = 0; i < CASES; i++) {
      const seed = BASE_SEED + i;
      const scenario = generate(seed);
      const { today, flattened, overlap } = await both(scenario, 'rethrow');
      if (JSON.stringify(flattened) !== JSON.stringify(today)) {
        expect(flattened, `seed ${seed}, ${JSON.stringify(scenario)}`).toEqual(
          today,
        );
      }
      if (!inCallOrder(flattened.order) || !inCallOrder(today.order)) {
        expect.fail(
          `seed ${seed}: calls settled out of order ${flattened.order} (flatten), ${today.order} (reference), ${JSON.stringify(scenario)}`,
        );
      }
      if (today.layer.includes('abandon')) seen.abandoned++;
      if (today.drain?.includes('drained')) seen.drained++;
      if (today.drain?.some((e) => e.startsWith('drain failed'))) {
        seen.drainFailed++;
      }
      if (today.layer[0] === 'catch aborted') seen.abortedBeforeStart++;
      if (
        today.layer.includes('catch aborted') === false &&
        today.source.includes('return') &&
        scenario.ops.some((o) => o.op === 'abort')
      ) {
        seen.closedAfterAbort++;
      }
      if (today.results.some((r) => r.startsWith('error'))) seen.errors++;
      if (today.results.some((r) => r.startsWith('value'))) seen.values++;
      if (overlap.nextNext > 0) seen.nextWhileNextPending++;
      if (overlap.closeDuringNext > 0) seen.closeWhileNextPending++;
      if (scenario.ops.some((o) => o.op === 'chain')) seen.chained++;
      if (scenario.ops.some((o) => o.op === 'tick' && o.turns >= 5)) {
        seen.longTick++;
      }
      const syncAt = scenario.ops.findIndex(
        (o) => o.op === 'abort' && o.sync === true,
      );
      if (syncAt >= 0) {
        seen.syncAbort++;
        if (today.layer.includes('abandon')) seen.syncAbortAbandoned++;
      }
    }
    // The abort lands in every state: before the start, between rows, on a
    // pending fetch; the abandoned source is drained, to its end or to an error.
    expect(seen.abandoned).toBeGreaterThan(CASES / 20);
    expect(seen.drained).toBeGreaterThan(CASES / 20);
    expect(seen.drainFailed).toBeGreaterThan(CASES / 200);
    expect(seen.abortedBeforeStart).toBeGreaterThan(CASES / 50);
    expect(seen.closedAfterAbort).toBeGreaterThan(CASES / 10);
    expect(seen.errors).toBeGreaterThan(CASES / 4);
    expect(seen.values).toBeGreaterThan(CASES / 4);
    expect(seen.nextWhileNextPending).toBeGreaterThan(CASES / 10);
    expect(seen.closeWhileNextPending).toBeGreaterThan(CASES / 20);
    expect(seen.syncAbort).toBeGreaterThan(CASES / 5);
    expect(seen.syncAbortAbandoned).toBeGreaterThan(CASES / 10);
    // Calls chained from a then callback, and delays of 5 to 7 turns between
    // calls: the class of call-order settlement bugs lives there.
    expect(seen.chained).toBeGreaterThan(CASES / 10);
    expect(seen.longTick).toBeGreaterThan(CASES / 10);
  });

  it('matches over a seeded random comparison', async () => {
    const CASES = 6000;
    const BASE_SEED = 20261019;

    const generate = (
      seed: number,
    ): { scenario: Scenario; variant: Variant } => {
      const random = prng(seed);
      const int = (n: number) => Math.floor(random() * n);
      const delay = (): Delay => {
        const r = random();
        if (r < 0.4) return 0;
        if (r < 0.65) return 1;
        if (r < 0.95) return 2;
        return 'timer';
      };
      const chunks = Array.from({ length: int(9) }, () => ({
        size: int(5),
        delay: delay(),
      }));
      const errorAt = random() < 0.4 ? int(chunks.length + 1) : null;
      const call = () =>
        (['next', 'return', 'throw'] as const)[int(3)] ?? 'next';
      const optionalValue = (): Pick<
        Op & { op: 'return' },
        'value' | 'promise'
      > => {
        if (random() >= 0.4) return {};
        const value = 1000 + int(9);
        const kind = int(3);
        if (kind === 0) return { value };
        return { value, promise: kind === 1 ? 'resolve' : 'reject' };
      };
      const op = (): Op => {
        const r = random() * 100;
        if (r < 26) return { op: 'next' };
        if (r < 36) return { op: 'nextNA' };
        if (r < 44) return { op: 'two' };
        if (r < 52) return { op: 'drain' };
        if (r < 60) return { op: 'return', ...optionalValue() };
        if (r < 66) return { op: 'returnNA', ...optionalValue() };
        if (r < 72) return { op: 'throw' };
        if (r < 78) return { op: 'throwNA' };
        if (r < 82) return { op: 'break' };
        if (r < 85) return { op: 'bodyThrow' };
        if (r < 94) return { op: 'tick', turns: int(8) };
        return { op: 'chain', call: call() };
      };
      const ops = Array.from({ length: 1 + int(10) }, op);
      const variant = VARIANTS[int(VARIANTS.length)] as Variant;
      const layerOptions = (): LayerOptions => {
        const options: LayerOptions = {};
        if (random() < 0.4) options.tryTurns = 1 + int(3);
        if (random() < 0.3) options.valueTurns = 1 + int(2);
        if (random() < 0.4) options.finallyTurns = 1 + int(3);
        if (random() < 0.12) options.finallyThrows = true;
        if (random() < 0.25) options.extraReturn = true;
        if (random() < 0.25) options.retry = true;
        return options;
      };
      return {
        scenario: { chunks, errorAt, ops, layer: layerOptions() },
        variant,
      };
    };

    const seen = {
      errors: 0,
      sourceErrors: 0,
      sourceClosed: 0,
      ended: 0,
      values: 0,
      nextWhileNextPending: 0,
      closeWhileNextPending: 0,
      retried: 0,
      finallyFailed: 0,
      extraReturn: 0,
      waited: 0,
      zeroAwait: 0,
    };
    for (let i = 0; i < CASES; i++) {
      const seed = BASE_SEED + i;
      const { scenario, variant } = generate(seed);
      const { today, flattened, overlap } = await both(scenario, variant);
      if (JSON.stringify(flattened) !== JSON.stringify(today)) {
        expect(
          flattened,
          `seed ${seed}, variant ${variant}, ${JSON.stringify(scenario)}`,
        ).toEqual(today);
      }
      if (!inCallOrder(flattened.order) || !inCallOrder(today.order)) {
        expect.fail(
          `seed ${seed}: calls settled out of order ${flattened.order} (flatten), ${today.order} (reference), ${JSON.stringify(scenario)}`,
        );
      }
      if (today.results.some((r) => r.startsWith('error'))) seen.errors++;
      if (today.layer.includes('catch source failed')) seen.sourceErrors++;
      // `source` is not compared (so is empty) when the layer closes it twice.
      if (!scenario.layer?.extraReturn && today.source.includes('return')) {
        seen.sourceClosed++;
      }
      if (today.results.some((r) => r.startsWith('done'))) seen.ended++;
      if (today.results.some((r) => r.startsWith('value'))) seen.values++;
      if (overlap.nextNext > 0) seen.nextWhileNextPending++;
      if (overlap.closeDuringNext > 0) seen.closeWhileNextPending++;
      // The BUSY source failed, the layer caught it, and the real source ran.
      if (
        today.layer.includes('catch busy') &&
        today.sourceBody.filter((event) => event === 'finally').length >= 2
      ) {
        seen.retried++;
      }
      if (today.results.includes('error finally failed')) seen.finallyFailed++;
      if (scenario.layer?.extraReturn) seen.extraReturn++;
      if (scenario.layer?.tryTurns || scenario.layer?.finallyTurns) {
        seen.waited++;
      }
      // The original layer: no option set, so no await beyond the loop's own.
      if (Object.keys(scenario.layer ?? {}).length === 0) seen.zeroAwait++;
    }
    // The space is exercised, not just compared: every kind of outcome occurs.
    expect(seen.values).toBeGreaterThan(CASES / 4);
    expect(seen.errors).toBeGreaterThan(CASES / 20);
    expect(seen.sourceErrors).toBeGreaterThan(CASES / 50);
    expect(seen.sourceClosed).toBeGreaterThan(CASES / 10);
    expect(seen.ended).toBeGreaterThan(CASES / 5);
    expect(seen.nextWhileNextPending).toBeGreaterThan(CASES / 20);
    expect(seen.closeWhileNextPending).toBeGreaterThan(CASES / 20);
    expect(seen.retried).toBeGreaterThan(CASES / 100);
    expect(seen.finallyFailed).toBeGreaterThan(CASES / 100);
    expect(seen.extraReturn).toBeGreaterThan(CASES / 10);
    expect(seen.waited).toBeGreaterThan(CASES / 4);
    expect(seen.zeroAwait).toBeGreaterThan(CASES / 20);
  });
});
