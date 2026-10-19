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
  onReturn: (
    value: unknown,
  ) => Promise<IteratorResult<number[], void>> = async () => ({
    value: undefined,
    done: true,
  }),
) => {
  const calls: string[] = [];
  const thrown: unknown[] = [];
  const returned: unknown[] = [];
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
    return(value?: unknown) {
      calls.push('return');
      returned.push(value);
      return onReturn(value);
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
  return { source, calls, thrown, returned, maxInFlight: () => maxInFlight };
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

  it('hands return(v) to the source itself on an open iterator and settles with its answer', async () => {
    const value = Promise.resolve(43);
    const { source, calls, returned } = scripted(
      [[1, 2]],
      undefined,
      async (v) => ({ value: (await v) as undefined, done: true }),
    );
    const iterator = flatten(source);
    await iterator.next();
    // Falsifiability: await `value` before closing the source and the source
    // receives 43, not the promise (or undefined).
    expect(await iterator.return(value as never)).toEqual({
      value: 43,
      done: true,
    });
    expect(returned).toHaveLength(1);
    expect(returned[0]).toBe(value);
    expect(calls).toEqual(['next', 'return']);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'return']);
  });

  it('settles return(v) with the source rejecting v on an open iterator', async () => {
    const failure = new Error('value');
    const { source, calls, returned } = scripted(
      [[1, 2]],
      undefined,
      (v) => Promise.resolve(v) as never,
    );
    const iterator = flatten(source);
    await iterator.next();
    const value = Promise.reject(failure);
    // Falsifiability: await `value` in flatten and the source never sees the
    // rejection: `returned` holds undefined.
    await expect(iterator.return(value as never)).rejects.toBe(failure);
    expect(returned[0]).toBe(value);
    expect(calls).toEqual(['next', 'return']);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('settles return(v) with what the source settles with, not with v', async () => {
    const cleanup = new Error('cleanup failed');
    const { source } = scripted([[1, 2]], undefined, () =>
      Promise.reject(cleanup),
    );
    const iterator = flatten(source);
    await iterator.next();
    // Falsifiability: reject with the value's error instead of the source's.
    const value = Promise.reject(new Error('value'));
    // The source ignores it, so nothing else observes the rejection.
    value.catch(() => undefined);
    await expect(iterator.return(value as never)).rejects.toBe(cleanup);
  });

  it('closes a source that yields again from its return()', async () => {
    let answers = 0;
    const { source, calls } = scripted([[1, 2]], undefined, () =>
      Promise.resolve(
        answers++ === 0
          ? { value: [9], done: false }
          : { value: undefined, done: true },
      ),
    );
    const iterator = flatten(source);
    await iterator.next();
    // Falsifiability: drop the second return() and the log ends at 'return'.
    expect(await iterator.return()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'return', 'return']);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toEqual(['next', 'return', 'return']);
  });

  it('rejects return() when the second return() of a source that yields again rejects', async () => {
    const cleanup = new Error('second return failed');
    let answers = 0;
    const { source, calls } = scripted([[1, 2]], undefined, () =>
      answers++ === 0
        ? Promise.resolve({ value: [9], done: false })
        : Promise.reject(cleanup),
    );
    const iterator = flatten(source);
    await iterator.next();
    // Falsifiability: fire the second return() without awaiting it and this
    // resolves.
    await expect(iterator.return()).rejects.toBe(cleanup);
    expect(calls).toEqual(['next', 'return', 'return']);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('rejects throw() when the return() that closes a source that yields again rejects', async () => {
    const cleanup = new Error('return failed');
    const { source, calls } = scripted(
      [[1, 2]],
      () => Promise.resolve({ value: [9], done: false }),
      () => Promise.reject(cleanup),
    );
    const iterator = flatten(source);
    await iterator.next();
    // Falsifiability: fire the return() without awaiting it and this resolves.
    await expect(iterator.throw(new Error('stop'))).rejects.toBe(cleanup);
    expect(calls).toEqual(['next', 'throw', 'return']);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('awaits return(v) itself when idle or ended, as an async generator does', async () => {
    const reference = async function* (
      source: AsyncGenerator<number[], void, unknown>,
    ) {
      for await (const chunk of source) for (const row of chunk) yield row;
    };
    type Make = (
      source: AsyncGenerator<number[], void, unknown>,
    ) => AsyncGenerator<number, void, unknown>;
    const settle = (promise: Promise<unknown>) =>
      promise.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    const outcome = async (make: Make) => {
      const idle = scripted([[1, 2]]);
      const unstarted = make(idle.source);
      const resolved = await unstarted.return(Promise.resolve(41) as never);
      const afterStart = await unstarted.next();
      const rejecting = scripted([[1, 2]]);
      const rejected = await settle(
        make(rejecting.source).return(
          Promise.reject(new Error('idle value')) as never,
        ),
      );
      const ended = scripted([[1]]);
      const finished = make(ended.source);
      await rowsOf(finished);
      const again = await finished.return(42 as never);
      const failed = await settle(
        finished.return(Promise.reject(new Error('ended value')) as never),
      );
      return {
        resolved,
        afterStart,
        rejected,
        again,
        failed,
        calls: [idle.calls, rejecting.calls, ended.calls],
      };
    };
    // Falsifiability: forward `value` to the source here and the idle log is
    // ['return'].
    expect(await outcome(flatten)).toEqual(await outcome(reference));
    expect(await outcome(flatten)).toMatchObject({
      resolved: { value: 41, done: true },
      again: { value: 42, done: true },
      calls: [[], [], ['next', 'next']],
    });
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

  it('inherits from the same %AsyncIteratorPrototype% as an async generator', () => {
    const { source } = scripted([]);
    const reference = (async function* () {})();
    const chainOf = (object: object) => {
      const chain: object[] = [];
      for (
        let proto = Object.getPrototypeOf(object);
        proto !== null;
        proto = Object.getPrototypeOf(proto)
      ) {
        chain.push(proto);
      }
      return chain;
    };
    const intrinsic = Object.getPrototypeOf(
      Object.getPrototypeOf(Object.getPrototypeOf(reference)),
    );
    // Falsifiability: drop the setPrototypeOf in flatten.ts and the chain
    // goes straight to Object.prototype.
    expect(chainOf(flatten(source))).toContain(intrinsic);
    expect(Object.hasOwn(flatten(source), 'next')).toBe(false);
  });

  it('reports itself as an AsyncGenerator', () => {
    const { source } = scripted([]);
    const iterator = flatten(source);
    const reference = (async function* () {})();
    // Falsifiability: remove the Symbol.toStringTag definition and this reads
    // [object Object].
    expect(Object.prototype.toString.call(iterator)).toBe(
      '[object AsyncGenerator]',
    );
    const own = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(iterator),
      Symbol.toStringTag,
    );
    const builtin = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Object.getPrototypeOf(reference)),
      Symbol.toStringTag,
    );
    expect(own?.enumerable).toBe(builtin?.enumerable);
    expect(own?.writable).toBe(builtin?.writable);
  });

  it.skipIf(typeof Symbol.asyncDispose !== 'symbol')(
    'is disposed through the inherited member as an async generator is',
    async () => {
      // The reference: what an async generator does on an open iterator.
      const log: string[] = [];
      const reference = (async function* () {
        try {
          yield 1;
        } finally {
          log.push('finally');
        }
      })();
      await reference.next();
      await reference[Symbol.asyncDispose]();
      expect(log).toEqual(['finally']);
      expect(await reference.next()).toEqual({ value: undefined, done: true });

      const { source, calls } = scripted([[1, 2]]);
      const iterator = flatten(source);
      expect(Object.hasOwn(iterator, Symbol.asyncDispose)).toBe(false);
      await iterator.next();
      // Falsifiability: remove the setPrototypeOf and the member is gone, so
      // this throws a TypeError.
      await iterator[Symbol.asyncDispose]();
      expect(calls).toEqual(['next', 'return']);
      expect(await iterator.next()).toEqual({ value: undefined, done: true });

      // Idle: nothing to close, on both.
      const idle = scripted([[1]]);
      await flatten(idle.source)[Symbol.asyncDispose]();
      expect(idle.calls).toEqual([]);
    },
  );

  it('collects the rows of a for await', async () => {
    const { source, calls } = scripted([[1, 2], [3], []]);
    expect(await rowsOf(flatten(source))).toEqual([1, 2, 3]);
    expect(calls).toEqual(['next', 'next', 'next', 'next']);
  });
});
