import type {
  Abortable,
  SQLiteChunkOptions,
  SQLiteQueryAPI,
  SQLiteTransactionDB,
  SQLiteTransactionOptions,
} from './api';
import type { ReadFn, TransactionFn, WriteFn } from './bulk';
import { SQLiteError } from './errors';
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

// Drains a statement that returns no rows (BEGIN, COMMIT, ROLLBACK) without
// the chunkSize-1 + break overhead of firstWorker.
const exec = async (worker: PoolWorker, sql: string): Promise<void> => {
  await readWorker(worker, sql);
};

/**
 * Returns the `transaction()` method for a SQLiteDB instance.
 *
 * The returned function acquires exactly one lease for the full lifetime of
 * the transaction. All SQLiteTransactionDB methods call worker-bound derivations
 * directly — never the public API — so no secondary lease acquisition can
 * occur during the callback.
 */
export const createTransaction =
  (deps: {
    scheduler: Scheduler<PoolWorker>;
    afterWrite: (worker: PoolWorker) => void;
    /**
     * Called when a connection may still hold an open transaction. The worker
     * is evicted rather than repaired: a "dirty worker" state is one more
     * state the barrier would have to reason about, while a respawned
     * connection is transaction-free by construction.
     */
    onPoisoned: (index: number, error: SQLiteError) => void;
    /**
     * The client's bulk factory. Called per transaction with the transaction's
     * own read/write and a pass-through `transaction`, so output()'s swap runs
     * on the caller's transaction instead of opening a BEGIN SQLite does not
     * allow.
     */
    bulkFor: (target: {
      read: ReadFn;
      write: WriteFn;
      transaction: TransactionFn;
    }) => {
      bulkWrite: SQLiteQueryAPI['bulkWrite'];
      output: SQLiteQueryAPI['output'];
    };
  }) =>
  async <T = void>(
    callback: (db: SQLiteTransactionDB) => Promise<T>,
    options?: SQLiteTransactionOptions,
  ): Promise<T> => {
    const { readOnly = false, autoCommit = true } = options ?? {};
    const lease = await deps.scheduler.acquire(readOnly ? 'read' : 'write');
    const worker = lease.worker;

    const checksql = (sql: string): string => {
      if (readOnly && isWriteQuery(sql))
        throw new SQLiteError(
          'READ_ONLY_TRANSACTION',
          'Cannot write in a read-only transaction.',
        );
      return sql;
    };

    let done = false;

    // Guarded at the call, not at the first flush. bulkWrite buffers, so the
    // failure would otherwise surface once the buffer overflows — and for
    // output() later still, trapped inside the createStaging promise.
    const refuse = (method: string) => (): never => {
      throw new SQLiteError(
        'READ_ONLY_TRANSACTION',
        `${method}() writes, and this transaction is read-only.`,
      );
    };

    const bulk = readOnly
      ? {
          bulkWrite: refuse('bulkWrite') as SQLiteQueryAPI['bulkWrite'],
          output: refuse('output') as SQLiteQueryAPI['output'],
        }
      : deps.bulkFor({
          read: (sql, params, options) =>
            readWorker(worker, checksql(sql), params, options),
          write: (sql, params, options) =>
            writeWorker(worker, checksql(sql), params, options),
          // The caller's transaction is already open. No BEGIN, no COMMIT.
          // db is referenced before its const declaration, deliberately: this arrow
          // only runs when output().close() fires, by which point db is assigned.
          // Moving `bulk` below `const db` breaks the literal that consumes it.
          transaction: (fn) => fn(db),
        });

    const db: SQLiteTransactionDB = {
      read: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: SQLiteChunkOptions,
      ) => readWorker<T>(worker, checksql(sql), params, options),

      write: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: Abortable,
      ) => writeWorker<T>(worker, checksql(sql), params, options),

      chunk: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: SQLiteChunkOptions,
      ) => chunkWorker<T>(worker, checksql(sql), params, options),

      stream: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: SQLiteChunkOptions,
      ) => streamRows<T>(worker, checksql(sql), params, options),

      first: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        options?: Abortable,
      ) => firstWorker<T>(worker, checksql(sql), params, options),

      bulkWrite: bulk.bulkWrite,
      output: bulk.output,

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
          // one that explains what actually went wrong. But the connection may
          // now hold an open transaction, and a read inside one reads that
          // transaction's snapshot — the barrier would refresh nothing and
          // report success. Evict instead of hoping.
          deps.onPoisoned(
            worker.index,
            new SQLiteError(
              'WORKER_CRASHED',
              `Worker ${worker.index + 1} may hold an open transaction after a failed rollback.`,
              { cause: e },
            ),
          );
        }
      }
      throw e;
    } finally {
      // Same reasoning as write(): before the void, because release is
      // asynchronous. A read-only transaction commits nothing and must not
      // bump.
      if (!readOnly) deps.afterWrite(worker);
      // The lease returns when the worker confirms it is idle, not when the
      // caller leaves: a worker still inside step() must not be re-lent, and
      // the caller must not wait for it.
      void lease.worker.quiesce().then(
        () => lease.release(),
        () => lease.release(),
      );
    }
  };
