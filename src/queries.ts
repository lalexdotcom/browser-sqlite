import type { PoolWorker } from './pool';

type SQLiteQueryOptions<_T extends Record<string, unknown>> = {
  id?: string;
  chunkSize?: number;
  signal?: AbortSignal;
  debug?: string;
};

/**
 * Helper to execute a read query and collect all results.
 */
export const readWorker = async <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: SQLiteQueryOptions<T>,
) => {
  const result: T[] = [];
  for await (const chunk of worker.query<T>(sql, params, options)) {
    if (typeof chunk !== 'number') {
      result.push(...chunk);
    }
  }
  return result;
};

/**
 * Helper to execute a streaming query on a specific worker.
 */
export const streamWorker = async function* <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: SQLiteQueryOptions<T>,
) {
  for await (const chunk of worker.query<T>(sql, params, options)) {
    if (typeof chunk !== 'number') {
      yield chunk;
    }
  }
};

/**
 * Helper to execute a write query and return both results and affected count.
 */
export const writeWorker = async <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: SQLiteQueryOptions<T>,
) => {
  const result: T[] = [];
  let affected = 0;
  for await (const chunk of worker.query<T>(sql, params, options)) {
    if (typeof chunk !== 'number') {
      result.push(...chunk);
    } else {
      affected = chunk;
    }
  }
  return { result, affected };
};

/**
 * Helper to fetch a single row from a query result.
 * Aborts after receiving the first row to avoid unnecessary work.
 */
export const oneWorker = async <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: Omit<SQLiteQueryOptions<T>, 'chunkSize' | 'signal'>,
) => {
  let result: T | undefined;
  const abortController = new AbortController();
  for await (const chunk of streamWorker<T>(worker, sql, params, {
    ...options,
    signal: abortController.signal,
    chunkSize: 1,
  })) {
    result = chunk[0];
    abortController.abort();
    break;
  }
  return result;
};
