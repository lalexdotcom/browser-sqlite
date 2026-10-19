import { describe, expect, it } from 'vitest';
import { flatten } from '../../../src/flatten';

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
  | { op: 'tick'; turns: number };

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
  const record = (generator: AsyncGenerator<number[], void, unknown>) => {
    const wrapped: AsyncGenerator<number[], void, unknown> = {
      next: (...args) => {
        source.push('next');
        return generator.next(...args);
      },
      return: (value) => {
        source.push('return');
        return generator.return(value);
      },
      throw: (error) => {
        source.push('throw');
        return generator.throw(error);
      },
      [Symbol.asyncIterator]: () => wrapped,
      [Symbol.asyncDispose]: () => generator[Symbol.asyncDispose](),
    };
    return wrapped;
  };
  let attempts = 0;
  const open = () =>
    record(scenario.layer?.retry && attempts++ === 0 ? busy() : chunks());
  return { open, source, sourceBody };
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
      await turns(options.tryTurns);
      try {
        for await (const value of input) {
          delivered = true;
          const chunk = mark(value);
          if (chunk !== null) events.push(`value ${chunk}`);
          await turns(options.valueTurns);
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
      await turns(options.finallyTurns);
      // biome-ignore lint/correctness/noUnsafeFinally: `releasing`'s finally can throw (dieIfConnectionLeft)
      if (options.finallyThrows) throw new Error('finally failed');
    }
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
    return promise.then(
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
  };
  const quiet = (promise: Promise<unknown>) => promise.then(noop, noop);
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
    }
  }
  await Promise.all(outstanding);
  // Whatever a settled call left running (a `finally`) gets time to finish.
  for (let i = 0; i < 20; i++) await null;
  return { results, order, overlap };
};

const run = async (scenario: Scenario, variant: Variant, shape: Shape) => {
  const { open, source, sourceBody } = makeSource(scenario);
  const events: string[] = [];
  const options = scenario.layer ?? {};
  const iterator =
    shape === 'today'
      ? layer(() => rowsOf(open()), events, chunkOfRow, variant, options)
      : flatten(layer(open, events, chunkOfChunk, variant, options));
  const { results, order, overlap } = await consume(iterator, scenario.ops);
  const trace: Trace = {
    results,
    order,
    // `releasing` closes its input once more in its `finally`. Today that
    // input is `rowsOf`, already finished, so the chunk source is not called
    // again; with `flatten` the input is the chunk source itself, and the extra
    // return() lands on the recording wrapper (a no-op on a real generator).
    // That one entry is the only difference, so this channel is left out when
    // the layer does it.
    source: options.extraReturn ? [] : source,
    sourceBody,
    layer: collapse(events),
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

  it('matches over a seeded random comparison', async () => {
    const CASES = 6000;
    const BASE_SEED = 20261019;

    // mulberry32
    const prng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

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
        return { op: 'tick', turns: int(4) };
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
      if (today.results.some((r) => r.startsWith('error'))) seen.errors++;
      if (today.layer.includes('catch source failed')) seen.sourceErrors++;
      if (today.source.includes('return')) seen.sourceClosed++;
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
    }
    // The space is exercised, not just compared: every kind of outcome occurs.
    expect(seen.values).toBeGreaterThan(CASES / 4);
    expect(seen.errors).toBeGreaterThan(CASES / 20);
    expect(seen.sourceErrors).toBeGreaterThan(CASES / 50);
    expect(seen.sourceClosed).toBeGreaterThan(CASES / 5);
    expect(seen.ended).toBeGreaterThan(CASES / 5);
    expect(seen.nextWhileNextPending).toBeGreaterThan(CASES / 20);
    expect(seen.closeWhileNextPending).toBeGreaterThan(CASES / 20);
    expect(seen.retried).toBeGreaterThan(CASES / 100);
    expect(seen.finallyFailed).toBeGreaterThan(CASES / 100);
    expect(seen.extraReturn).toBeGreaterThan(CASES / 10);
    expect(seen.waited).toBeGreaterThan(CASES / 4);
  });
});
