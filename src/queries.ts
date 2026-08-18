import type { PoolWorker } from './pool';

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
  options?: { chunkSize?: number; signal?: AbortSignal },
): AsyncGenerator<T[]> {
  const { signal, chunkSize } = options ?? {};

  // B9: addEventListener never fires for a signal that is already aborted, and
  // nothing else checks. Without this the query runs to completion.
  if (signal?.aborted) throw signal.reason;

  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  signal?.addEventListener('abort', onAbort);

  try {
    for await (const item of worker.query<T>(sql, params, { chunkSize })) {
      // FLK-1: chunks already sitting in the message queue are NOT delivered.
      // Stopping the worker is not enough — it races ahead of the abort flag.
      if (aborted) break;
      if (typeof item !== 'number') yield item;
    }
    if (aborted) throw signal?.reason;
  } finally {
    // In the finally, never after the loop: every early exit skipped it before,
    // and first() exits early by construction.
    signal?.removeEventListener('abort', onAbort);
  }
};

export const streamRows = async function* <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: { chunkSize?: number; signal?: AbortSignal },
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
  options?: { chunkSize?: number; signal?: AbortSignal },
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
  options?: { signal?: AbortSignal },
): Promise<T | undefined> => {
  for await (const rows of chunk<T>(worker, sql, params, {
    ...options,
    chunkSize: 1,
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
  options?: { signal?: AbortSignal },
): Promise<{ result: T[]; affected: number }> => {
  const { signal } = options ?? {};

  // Mirror chunk(): reject immediately if the signal is already aborted.
  if (signal?.aborted) throw signal.reason;

  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  signal?.addEventListener('abort', onAbort);

  const result: T[] = [];
  let affected = 0;
  try {
    // write() is the only caller that needs the affected count, which is why the
    // T[] | number union stays private to this module.
    for await (const item of worker.query<T>(sql, params, {})) {
      if (aborted) break;
      if (typeof item === 'number') affected = item;
      else result.push(...item);
    }
    if (aborted) throw signal?.reason;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return { result, affected };
};
