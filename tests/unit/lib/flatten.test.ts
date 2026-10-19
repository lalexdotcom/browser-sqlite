import { describe, expect, it } from 'vitest';
import { flatten } from '../../../src/flatten';

/**
 * What a scripted source serves, one step per `next()`: a chunk, an error to
 * reject with, or a promise of a chunk (a fetch that stays pending until the
 * test settles it). Past the last step the source is done.
 */
type Step = number[] | Error | Promise<number[]>;

const deferred = <V>() => {
  let resolve!: (value: V) => void;
  const promise = new Promise<V>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Lets every promise reaction already queued run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A hand-written source that records every call made on it. `throw()` rejects
 * with the error it is given unless `onThrow` says otherwise.
 */
const scripted = (
  steps: Step[],
  onThrow: (error: unknown) => Promise<IteratorResult<number[], void>> = (
    error,
  ) => Promise.reject(error),
  onReturn: () => Promise<IteratorResult<number[], void>> = async () => ({
    value: undefined,
    done: true,
  }),
) => {
  const calls: string[] = [];
  const thrown: unknown[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const source: AsyncGenerator<number[], void, unknown> = {
    async next() {
      calls.push('next');
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const step = steps.shift();
        if (step === undefined) return { value: undefined, done: true };
        if (step instanceof Error) throw step;
        return { value: await step, done: false };
      } finally {
        inFlight--;
      }
    },
    return() {
      calls.push('return');
      return onReturn();
    },
    throw(error: unknown) {
      calls.push('throw');
      thrown.push(error);
      return onThrow(error);
    },
    [Symbol.asyncIterator]() {
      return source;
    },
    async [Symbol.asyncDispose]() {
      await source.return();
    },
  };
  return { source, calls, thrown, maxInFlight: () => maxInFlight };
};

const rowsOf = async (iterator: AsyncIterable<number>) => {
  const rows: number[] = [];
  for await (const row of iterator) rows.push(row);
  return rows;
};

describe('flatten', () => {
  it('touches the source only at the first next()', async () => {
    const { source, calls } = scripted([[1]]);
    const iterator = flatten(source);
    await settle();
    // Falsifiability: call `source.next()` in the factory and this is ['next'].
    expect(calls).toEqual([]);
    await iterator.next();
    expect(calls).toEqual(['next']);
  });

  it('serves the rows of every chunk in order, skipping empty chunks', async () => {
    const { source, calls } = scripted([[1, 2], [], [3]]);
    const iterator = flatten(source);
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    expect(await iterator.next()).toEqual({ value: 2, done: false });
    // Falsifiability: serve `step.value[0]` of the empty chunk without the
    // length test and this is undefined, not 3.
    expect(await iterator.next()).toEqual({ value: 3, done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'next', 'next', 'next']);
  });

  it('does not call the source again once it has ended', async () => {
    const { source, calls } = scripted([[1]]);
    const iterator = flatten(source);
    await iterator.next();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    // Falsifiability: leave the status open at the source's end and the next
    // call asks the source a third time.
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'next']);
  });

  it('serves a buffered row in one promise turn', async () => {
    const { source } = scripted([[1, 2]]);
    const iterator = flatten(source);
    await iterator.next();
    let served = false;
    void iterator.next().then(() => {
      served = true;
    });
    await Promise.resolve();
    // Falsifiability: route every next() through the queue and the row needs
    // several more turns: served is still false.
    expect(served).toBe(true);
  });

  it('serves buffered rows without calling the source', async () => {
    const { source, calls } = scripted([[1, 2, 3]]);
    const iterator = flatten(source);
    await iterator.next();
    expect(calls).toEqual(['next']);
    expect(await iterator.next()).toEqual({ value: 2, done: false });
    // Falsifiability: fetch a chunk on every next() and the log grows.
    expect(await iterator.next()).toEqual({ value: 3, done: false });
    expect(calls).toEqual(['next']);
  });

  it('fetches one chunk for two next() not awaited', async () => {
    const { source, calls, maxInFlight } = scripted([[1], [2]]);
    const iterator = flatten(source);
    const results = await Promise.all([iterator.next(), iterator.next()]);
    expect(results).toEqual([
      { value: 1, done: false },
      { value: 2, done: false },
    ]);
    // Falsifiability: call the source straight from next() and the two fetches
    // overlap: maxInFlight is 2.
    expect(maxInFlight()).toBe(1);
    expect(calls).toEqual(['next', 'next']);
  });

  it('waits for a pending fetch before return() closes the source', async () => {
    const gate = deferred<number[]>();
    const { source, calls } = scripted([gate.promise]);
    const iterator = flatten(source);
    const first = iterator.next();
    await settle();
    const closing = iterator.return();
    await settle();
    // Falsifiability: close the source without queueing behind the fetch and
    // this is ['next', 'return'].
    expect(calls).toEqual(['next']);
    gate.resolve([1, 2]);
    expect(await first).toEqual({ value: 1, done: false });
    expect(await closing).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'return']);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'return']);
  });

  it('closes the source once for two return()', async () => {
    const { source, calls } = scripted([[1, 2]]);
    const iterator = flatten(source);
    await iterator.next();
    await iterator.return();
    expect(await iterator.return()).toEqual({ value: undefined, done: true });
    // Falsifiability: drop the status test in return() and this has two.
    expect(calls).toEqual(['next', 'return']);
  });

  it('closes the source once on a break in for await', async () => {
    const { source, calls } = scripted([[1, 2, 3]]);
    for await (const row of flatten(source)) {
      expect(row).toBe(1);
      break;
    }
    // Falsifiability: skip the source's return() and the log is ['next'].
    expect(calls).toEqual(['next', 'return']);
  });

  it('forwards throw() to the source and ends', async () => {
    const failure = new Error('stop');
    const { source, calls, thrown } = scripted([[1, 2]]);
    const iterator = flatten(source);
    await iterator.next();
    // Falsifiability: call the source's return() instead and `thrown` is empty.
    await expect(iterator.throw(failure)).rejects.toBe(failure);
    expect(thrown).toEqual([failure]);
    expect(calls).toEqual(['next', 'throw']);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'throw']);
  });

  it('rejects throw() with what the source rejects with', async () => {
    const failure = new Error('stop');
    const other = new Error('cleanup failed');
    const { source } = scripted([[1, 2]], () => Promise.reject(other));
    const iterator = flatten(source);
    await iterator.next();
    // Falsifiability: reject with the argument instead of the source's error.
    await expect(iterator.throw(failure)).rejects.toBe(other);
  });

  it('calls nothing on the source for return() or throw() before the first next()', async () => {
    const failure = new Error('stop');
    const returned = scripted([[1]]);
    const first = flatten(returned.source);
    expect(await first.return()).toEqual({ value: undefined, done: true });
    expect(await first.next()).toEqual({ value: undefined, done: true });
    const thrown = scripted([[1]]);
    const second = flatten(thrown.source);
    // Falsifiability: forward to the source whatever the status and both logs
    // are no longer empty.
    await expect(second.throw(failure)).rejects.toBe(failure);
    expect(await second.next()).toEqual({ value: undefined, done: true });
    expect(returned.calls).toEqual([]);
    expect(thrown.calls).toEqual([]);
  });

  it('ends on a source error', async () => {
    const failure = new Error('disk');
    const { source, calls } = scripted([[1, 2], failure]);
    const iterator = flatten(source);
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    expect(await iterator.next()).toEqual({ value: 2, done: false });
    // Falsifiability: leave the status open after the error and the next call
    // asks the source again.
    await expect(iterator.next()).rejects.toBe(failure);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'next']);
  });

  it('throws an aborted signal into the source before a buffered row', async () => {
    const controller = new AbortController();
    const reason = new Error('aborted');
    const other = new Error('abandoned');
    const { source, calls, thrown } = scripted([[1, 2, 3]], () =>
      Promise.reject(other),
    );
    const iterator = flatten(source, { signal: controller.signal });
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    controller.abort(reason);
    // Falsifiability: skip the signal test and this resolves with 2.
    await expect(iterator.next()).rejects.toBe(other);
    expect(thrown).toEqual([reason]);
    expect(calls).toEqual(['next', 'throw']);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'throw']);
  });

  it('serves the buffered rows when there is no signal', async () => {
    const { source, calls } = scripted([[1, 2, 3]]);
    const iterator = flatten(source);
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    expect(await iterator.next()).toEqual({ value: 2, done: false });
    expect(await iterator.next()).toEqual({ value: 3, done: false });
    expect(calls).toEqual(['next']);
  });

  it('does not serve a buffered row after return() was called', async () => {
    const { source } = scripted([[1, 2, 3]]);
    const iterator = flatten(source);
    await iterator.next();
    const closing = iterator.return();
    // Falsifiability: serve from the buffer whenever it is not empty, ahead of
    // the queue, and this is row 2.
    const after = iterator.next();
    expect(await after).toEqual({ value: undefined, done: true });
    await closing;
  });

  it('serves requests in call order', async () => {
    const gate = deferred<number[]>();
    const { source } = scripted([gate.promise]);
    const iterator = flatten(source);
    const order: string[] = [];
    const a = iterator.next().then(() => order.push('a'));
    const b = iterator.next().then(() => order.push('b'));
    const c = iterator.next().then(() => order.push('c'));
    await settle();
    gate.resolve([1, 2, 3]);
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('is its own async iterator', () => {
    const { source } = scripted([]);
    const iterator = flatten(source);
    // Falsifiability: return a fresh object and this is false.
    expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
  });

  it('ends when the source answers throw() with done', async () => {
    const { source, calls } = scripted([[1, 2]], () =>
      Promise.resolve({ value: undefined, done: true }),
    );
    const iterator = flatten(source);
    await iterator.next();
    // Falsifiability: rethrow the error after the source's throw() and this
    // rejects.
    expect(await iterator.throw(new Error('stop'))).toEqual({
      value: undefined,
      done: true,
    });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'throw']);
  });

  it('closes a source that catches throw() and yields again', async () => {
    const { source, calls } = scripted([[1, 2]], () =>
      Promise.resolve({ value: [9], done: false }),
    );
    const iterator = flatten(source);
    await iterator.next();
    // Falsifiability: drop the return() after a throw() answered not done and
    // the log ends at 'throw': a source left suspended.
    expect(await iterator.throw(new Error('stop'))).toEqual({
      value: undefined,
      done: true,
    });
    expect(calls).toEqual(['next', 'throw', 'return']);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'throw', 'return']);
  });

  it('rejects return() with what the source rejects with', async () => {
    const cleanup = new Error('cleanup failed');
    const { source, calls } = scripted([[1, 2]], undefined, () =>
      Promise.reject(cleanup),
    );
    const iterator = flatten(source);
    await iterator.next();
    // Falsifiability: swallow the source's error in return() and this resolves.
    await expect(iterator.return()).rejects.toBe(cleanup);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'return']);
  });

  it('settles return() as an async generator does when its value and the source both reject', async () => {
    const failure = new Error('value');
    const cleanup = new Error('cleanup failed');
    const reference = async function* (
      source: AsyncGenerator<number[], void, unknown>,
    ) {
      for await (const chunk of source) for (const row of chunk) yield row;
    };
    const outcome = async (
      make: (
        source: AsyncGenerator<number[], void, unknown>,
      ) => AsyncGenerator<number, void, unknown>,
    ) => {
      const { source, calls } = scripted([[1, 2]], undefined, () =>
        Promise.reject(cleanup),
      );
      const iterator = make(source);
      await iterator.next();
      const error = await iterator.return(Promise.reject(failure)).then(
        () => undefined,
        (e: unknown) => e,
      );
      return { error, calls };
    };
    const expected = await outcome(reference);
    // Falsifiability: await `value` after closing the source and `cleanup`
    // surfaces instead of `failure`.
    expect(expected.error).toBe(failure);
    expect(await outcome(flatten)).toEqual(expected);
  });

  it('treats a signal of undefined as no signal', async () => {
    const { source, calls } = scripted([[1, 2, 3]]);
    const iterator = flatten(source, { signal: undefined });
    expect(await rowsOf(iterator)).toEqual([1, 2, 3]);
    // Falsifiability: type the option `signal?: AbortSignal` and `tsc` rejects
    // this call under exactOptionalPropertyTypes.
    expect(calls).toEqual(['next', 'next']);
  });

  it('closes the source once when disposed', async () => {
    const { source, calls } = scripted([[1, 2]]);
    const iterator = flatten(source);
    await iterator.next();
    // Falsifiability: make the method a no-op and the log is ['next'].
    await iterator[Symbol.asyncDispose]();
    expect(calls).toEqual(['next', 'return']);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('collects the rows of a for await', async () => {
    const { source, calls } = scripted([[1, 2], [3], []]);
    expect(await rowsOf(flatten(source))).toEqual([1, 2, 3]);
    expect(calls).toEqual(['next', 'next', 'next', 'next']);
  });
});
