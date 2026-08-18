import type { PoolWorker } from './pool';
import {
  chunk as chunkWorker,
  firstWorker,
  readWorker,
  streamRows,
  writeWorker,
} from './queries';
import type { Scheduler } from './scheduler';
import { isWriteQuery } from './utils';

// Mirrors the query-options type from client.ts — kept local to avoid a
// circular import (client imports createTransaction; transaction cannot
// therefore import from client).
type SQLiteQueryOptions<_T extends Record<string, unknown>> = {
  id?: string;
  chunkSize?: number;
  signal?: AbortSignal;
  debug?: string;
};

export type TransactionDB = {
  read: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions<T>,
  ) => Promise<T[]>;
  write: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions<T>,
  ) => Promise<{ result: T[]; affected: number }>;
  chunk: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions<T>,
  ) => AsyncGenerator<T[]>;
  stream: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions<T>,
  ) => AsyncGenerator<T>;
  first: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions<T>,
  ) => Promise<T | undefined>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

// Drains a statement that returns no rows (BEGIN, COMMIT, ROLLBACK) without
// the chunkSize-1 + break overhead of firstWorker.
const exec = async (worker: PoolWorker, sql: string): Promise<void> => {
  await readWorker(worker, sql);
};

/**
 * Returns the `transaction()` method for a SQLiteDB instance.
 *
 * The returned function acquires exactly one lease for the full lifetime of
 * the transaction. All TransactionDB methods call worker-bound derivations
 * directly — never the public API — so no secondary lease acquisition can
 * occur during the callback.
 */
export const createTransaction =
  (deps: { scheduler: Scheduler<PoolWorker> }) =>
  async <T = void>(
    callback: (db: TransactionDB) => Promise<T>,
    options?: { readOnly?: boolean; autoCommit?: boolean },
  ): Promise<T> => {
    const { readOnly = false, autoCommit = true } = options ?? {};
    const lease = await deps.scheduler.acquire(readOnly ? 'read' : 'write');
    const worker = lease.worker;

    const checksql = (sql: string): string => {
      if (readOnly && isWriteQuery(sql))
        throw new Error('Cannot write in read-only transaction');
      return sql;
    };

    let done = false;

    const db: TransactionDB = {
      read: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: SQLiteQueryOptions<T>,
      ) => readWorker<T>(worker, checksql(sql), params, options),

      write: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: SQLiteQueryOptions<T>,
      ) => writeWorker<T>(worker, checksql(sql), params, options),

      chunk: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: SQLiteQueryOptions<T>,
      ) => chunkWorker<T>(worker, checksql(sql), params, options),

      stream: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: SQLiteQueryOptions<T>,
      ) => streamRows<T>(worker, checksql(sql), params, options),

      first: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: SQLiteQueryOptions<T>,
      ) => firstWorker<T>(worker, checksql(sql), params, options),

      commit: async () => {
        done = true;
        await exec(worker, 'COMMIT');
      },

      rollback: async () => {
        done = true;
        await exec(worker, 'ROLLBACK');
      },
    };

    try {
      await exec(worker, 'BEGIN');
      const result = await callback(db);

      if (!done) {
        if (autoCommit) {
          await db.commit();
        } else {
          await db.rollback();
        }
      }
      return result;
    } catch (e) {
      await db.rollback();
      throw e;
    } finally {
      lease.release();
    }
  };
