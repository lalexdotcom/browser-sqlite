import type { OptionsWithSignal, SQLiteChunkOptions } from './api';
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
 * The single query primitive. Every other read path is a thin derivation, and
 * abort is implemented here exactly once.
 */
export const chunk = async function* <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: SQLiteChunkOptions & { credits?: number },
): AsyncGenerator<T[]> {
  const { signal, chunkSize, credits } = options ?? {};

  // B9: addEventListener never fires for a signal that is already aborted.
  if (signal?.aborted) throw signal.reason;

  const { aborted, teardown } = makeAbortRace(signal);
  const iterator = worker.query<T>(sql, params, { chunkSize, credits });
  try {
    while (true) {
      // Racing the pending chunk, not testing a flag after it: an ORDER BY
      // sorts entirely inside the first step(), so waiting for a chunk before
      // noticing the abort makes AbortSignal.timeout(n) return minutes late.
      const next = aborted
        ? await Promise.race([iterator.next(), aborted])
        : await iterator.next();
      if (next.done) break;
      // FLK-1: chunks already queued are not delivered once the signal fired.
      if (typeof next.value !== 'number') yield next.value;
    }
  } finally {
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
  options?: SQLiteChunkOptions,
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
  options?: OptionsWithSignal,
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
  options?: OptionsWithSignal,
): Promise<{ result: T[]; affected: number }> => {
  const { signal } = options ?? {};

  // B9: addEventListener never fires for a signal that is already aborted.
  if (signal?.aborted) throw signal.reason;

  const { aborted, teardown } = makeAbortRace(signal);
  const iterator = worker.query<T>(sql, params, {});
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
