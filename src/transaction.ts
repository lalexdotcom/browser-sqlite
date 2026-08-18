import type { PoolWorker } from './pool';
import {
  chunk as chunkWorker,
  firstWorker,
  readWorker,
  streamRows,
  writeWorker,
} from './queries';
import type { Scheduler } from './scheduler';
import type { SQLiteQueryOptions } from './types';
import { isWriteQuery } from './utils';

export type TransactionDB = {
  read: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions<T>,
  ) => Promise<T[]>;
  write: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: Omit<SQLiteQueryOptions<T>, 'chunkSize'>,
  ) => Promise<{ result: T[]; affected: number }>;
  chunk: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions<T>,
  ) => AsyncGenerator<T[]>;
  stream: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: Omit<SQLiteQueryOptions<T>, 'chunkSize'>,
  ) => AsyncGenerator<T>;
  first: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: Omit<SQLiteQueryOptions<T>, 'chunkSize'>,
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
        options?: Omit<SQLiteQueryOptions<T>, 'chunkSize'>,
      ) => writeWorker<T>(worker, checksql(sql), params, options),

      chunk: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: SQLiteQueryOptions<T>,
      ) => chunkWorker<T>(worker, checksql(sql), params, options),

      stream: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: Omit<SQLiteQueryOptions<T>, 'chunkSize'>,
      ) => streamRows<T>(worker, checksql(sql), params, options),

      first: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: Omit<SQLiteQueryOptions<T>, 'chunkSize'>,
      ) => firstWorker<T>(worker, checksql(sql), params, options),

      commit: async () => {
        await exec(worker, 'COMMIT');
        done = true;
      },

      rollback: async () => {
        await exec(worker, 'ROLLBACK');
        done = true;
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
      // Only roll back if the transaction is still open. `done` is set after the
      // statement succeeds, so a COMMIT that failed leaves it false and the
      // transaction still active — that case must still roll back.
      if (!done) {
        try {
          await db.rollback();
        } catch {
          // A failed rollback must not replace the caller's error, which is the
          // one that explains what actually went wrong.
        }
      }
      throw e;
    } finally {
      lease.release();
    }
  };
