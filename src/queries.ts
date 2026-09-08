import {
  type Abandoned,
  type AbandonRegistry,
  type AbandonState,
  abandonRegistry,
  reclaim,
} from './abandon';
import type { SQLiteChunkOptions, SQLiteQueryOptions } from './api';
import type { PoolWorker } from './pool';

/**
 * Wires an AbortSignal into a promise that rejects the instant the signal
 * fires, and returns a teardown that removes the listener. The rejection sink
 * (`aborted?.catch`) suppresses the unhandled-rejection when the query ends
 * normally and nobody is racing the promise any more.
 *
 * This is the only place in the module that reads an AbortSignal; both
 * `chunk()` and `writeWorker()` delegate here.
 */
export const makeAbortRace = (
  signal: AbortSignal | undefined,
): { aborted: Promise<never> | undefined; teardown: () => void } => {
  if (!signal) return { aborted: undefined, teardown: () => {} };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // Nothing consumes this rejection when the query ends normally.
  aborted.catch(() => {});
  return {
    aborted,
    teardown: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
};

/**
 * `SQLiteChunkOptions` plus what only this library passes. `registry` is
 * TEST-ONLY and unsupported; it exists so the abandonment path can be driven
 * without a garbage collection.
 */
export type InternalChunkOptions = SQLiteChunkOptions & {
  credits?: number;
  /** The owning layer's teardown, run if the generator is abandoned. */
  onAbandon?: (() => void) | undefined;
  registry?: AbandonRegistry;
};

/**
 * The single query primitive. Every other read path is a thin derivation, and
 * abort is implemented here exactly once.
 *
 * **A factory, not a generator function**, so that the transport iterator
 * exists before the generator does and can be handed to the abandonment
 * registry. Building it early costs nothing: `worker.query()` runs no code
 * until its first `next()`, so the query message and the reuse guard still
 * happen when the consumer first pulls.
 */
export const chunk = <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: InternalChunkOptions,
): AsyncGenerator<T[]> => {
  const {
    signal,
    chunkSize,
    credits,
    onAbandon,
    registry = abandonRegistry,
  } = options ?? {};
  const iterator = worker.query<T>(sql, params, {
    chunkSize,
    credits,
    abortable: signal !== undefined,
  });
  const state: AbandonState = { started: false };
  const token = {};
  const held: Abandoned = { worker, iterator, state, release: onAbandon };

  /**
   * D7: an abort must reclaim, not merely reject. `makeAbortRace` inside the
   * generator rejects a promise that an abandoned consumer is no longer
   * awaiting, and that rejection is swallowed — so without this listener a
   * `timeout` buys an abandoned generator nothing at all.
   *
   * This closure captures the factory's scope and never the generator object,
   * so a signal the caller keeps alive does not prevent the collection the
   * registry depends on.
   */
  let detach = () => {};
  if (signal) {
    const onAbort = () => {
      registry.forget(token);
      reclaim(held);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    detach = () => signal.removeEventListener('abort', onAbort);
  }

  const gen = drain<T>(
    iterator,
    worker,
    signal,
    state,
    registry,
    token,
    detach,
  );
  registry.watch(gen, held, token);
  return gen;
};

const drain = async function* <T extends Record<string, unknown>>(
  iterator: AsyncGenerator<T[] | number>,
  worker: PoolWorker,
  signal: AbortSignal | undefined,
  state: AbandonState,
  registry: AbandonRegistry,
  token: object,
  detach: () => void,
): AsyncGenerator<T[]> {
  // B9: addEventListener never fires for a signal that is already aborted.
  // D2: this stays HERE and not in the factory above. Lifted, it would throw
  // at call time instead of on the first next(), which every caller feels.
  //
  // This path throws BEFORE the try, so the finally below never runs: it owes
  // its teardown itself.
  if (signal?.aborted) {
    detach();
    registry.forget(token);
    throw signal.reason;
  }

  const { aborted, teardown } = makeAbortRace(signal);
  state.started = true;
  try {
    while (true) {
      // Racing the pending chunk, not testing a flag after it: an ORDER BY
      // sorts entirely inside the first step(), so waiting for a chunk before
      // noticing the abort makes AbortSignal.timeout(n) return minutes late.
      // `aborted` first: D7's reclaim() may already have completed `iterator`
      // by the time this races again, so with both promises pre-settled,
      // array order breaks the tie. Putting `aborted` first keeps the abort
      // observed even though `iterator.next()` also resolves immediately.
      const next = aborted
        ? await Promise.race([aborted, iterator.next()])
        : await iterator.next();
      if (next.done) break;
      // FLK-1: chunks already queued are not delivered once the signal fired.
      if (typeof next.value !== 'number') yield next.value;
    }
  } finally {
    // First, so that neither a later abort nor a collection can run the
    // cleanup a second time on a worker already given back.
    detach();
    registry.forget(token);
    teardown();
    // Start the stop-and-drain, never await it. The caller must not wait for a
    // sort that may still have minutes to run; the lease returns through
    // quiesce() instead. interrupt() first, so the queued return() is not
    // parked behind a next() that will not settle.
    worker.interrupt();
    void iterator.return(undefined).catch(() => {});
  }
};

export const streamRows = async function* <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: InternalChunkOptions,
): AsyncGenerator<T> {
  for await (const rows of chunk<T>(worker, sql, params, options)) {
    for (const row of rows) yield row;
  }
};

export const readWorker = async <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: SQLiteChunkOptions,
): Promise<T[]> => {
  const result: T[] = [];
  for await (const rows of chunk<T>(worker, sql, params, options)) {
    result.push(...rows);
  }
  return result;
};

/**
 * First row, then stop. This BREAKS rather than aborting: a break triggers the
 * generator's return path, which runs chunk()'s finally and the transport's
 * stop-and-drain — the same worker-stop routine, reached without an exception.
 * That is why there is no internal AbortController here and no need to tell an
 * internal abort from the caller's.
 */
export const firstWorker = async <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: SQLiteQueryOptions,
): Promise<T | undefined> => {
  for await (const rows of chunk<T>(worker, sql, params, {
    ...options,
    chunkSize: 1,
    // Spec §4.1: with the default window of 2 the worker would produce a
    // second row before parking. One credit is the exact one-row bound the
    // JSDoc has always promised.
    credits: 1,
  })) {
    return rows[0];
  }
  return undefined;
};

export const writeWorker = async <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: SQLiteQueryOptions,
): Promise<{ result: T[]; affected: number }> => {
  const { signal } = options ?? {};

  // B9: addEventListener never fires for a signal that is already aborted.
  if (signal?.aborted) throw signal.reason;

  const { aborted, teardown } = makeAbortRace(signal);
  const iterator = worker.query<T>(sql, params, {
    abortable: signal !== undefined,
  });
  const result: T[] = [];
  let affected = 0;
  try {
    while (true) {
      // Racing the pending chunk, not testing a flag after it: an ORDER BY
      // sorts entirely inside the first step(), so waiting for a chunk before
      // noticing the abort makes AbortSignal.timeout(n) return minutes late.
      const next = aborted
        ? await Promise.race([iterator.next(), aborted])
        : await iterator.next();
      if (next.done) break;
      // write() is the only caller that needs the affected count, which is why
      // the T[] | number union stays private to this module.
      if (typeof next.value === 'number') affected = next.value;
      else result.push(...next.value);
    }
  } finally {
    teardown();
    // Start the stop-and-drain, never await it. Same pattern as chunk().
    worker.interrupt();
    void iterator.return(undefined).catch(() => {});
  }
  return { result, affected };
};
