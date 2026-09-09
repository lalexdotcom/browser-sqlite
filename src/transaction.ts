import type {
  Interruptible,
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
  makeAbortRace,
  readWorker,
  streamRows,
  writeWorker,
} from './queries';
import type { Scheduler } from './scheduler';
import { isWriteQuery, mergeSignals, withDeadline } from './utils';

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
    afterWrite: (worker: PoolWorker) => Promise<unknown>;
    /**
     * Called when a connection may still hold an open transaction. The worker
     * is lost rather than repaired: a "dirty worker" state is one more
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
    // The deadline is the transaction's own signal from here on: it reaches
    // the lease acquisition, every inner statement through withSignal, and the
    // race against the callback itself.
    const { signal, release: releaseDeadline } = withDeadline(
      options,
      'transaction',
    );
    try {
      // The signal aborts the wait too: without it a transaction could not be
      // abandoned while the pool has nothing to lend, which is a state a VFS
      // rotating one exclusive OPFS handle can stay in indefinitely.
      const lease = await deps.scheduler.acquire(
        readOnly ? 'read' : 'write',
        signal,
      );
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
      // Set only once BEGIN has come back. A ROLLBACK sent to a connection that
      // opened no transaction fails, and that failure would lose a healthy
      // worker through onPoisoned.
      let begun = false;

      /**
       * The options a statement runs with: the transaction's signal, merged with
       * the caller's own when they gave one, so either may abort the statement
       * and the reason is always the source's. `release` is owed once the
       * statement has settled — the merge is the only thing here that subscribes
       * to a signal the caller may keep alive far longer than this transaction.
       */
      const withSignal = <O extends { signal?: AbortSignal | undefined }>(
        given: O | undefined,
      ): { options: O; release: () => void } => {
        const { signal: merged, release } = mergeSignals(signal, given?.signal);
        return { options: { ...given, signal: merged } as O, release };
      };

      /**
       * Every statement generator this transaction has handed out and that has not
       * finished. The transaction closes what the callback left open before it
       * commits: an open generator holds a query on the transaction's worker, and
       * the next statement — the auto-COMMIT if nothing else — would trip pool.ts's
       * reuse guard, fail the ROLLBACK in turn and get the worker evicted. On
       * Firefox that eviction strands the rotated exclusive OPFS handle and wedges
       * the pool for good, which is the defect this exists to prevent.
       */
      const open = new Set<AsyncGenerator<unknown>>();

      /** Runs `release` when the consumer stops reading, however it stops. */
      const releasing = <R>(
        source: AsyncGenerator<R>,
        release: () => void,
      ): AsyncGenerator<R> => {
        // Definite assignment assertion, not a non-null one: `gen` is read
        // only from inside the generator body below, which cannot run before
        // the assignment on the next line completes — an async generator's
        // body does not start until its first `next()`. TypeScript's flow
        // analysis does not know that and flags the plain declaration as used
        // before being assigned.
        let gen!: AsyncGenerator<R>;
        gen = (async function* () {
          try {
            yield* source;
          } finally {
            open.delete(gen);
            release();
          }
        })();
        open.add(gen);
        return gen;
      };

      /**
       * Close what the callback abandoned. `return()` sends the worker the stop
       * request and starts the drain, but queries.ts's `drain()` fires that off
       * without awaiting it — deliberately, for the registry-driven abandonment
       * path this also serves, where nobody is left waiting. Here somebody is:
       * the next thing this transaction does is talk to the same worker
       * directly, with no scheduler lease gate in between. `worker.quiesce()`
       * is the actual wait — it resolves when the worker's own finally clears
       * `deferredChunk`, which is the pool.ts state the reuse guard reads — so
       * the connection is genuinely idle before COMMIT rather than merely
       * believed to be.
       */
      const closeOpenStatements = async () => {
        for (const gen of [...open]) {
          try {
            await gen.return(undefined);
          } catch {
            // A generator that throws on the way out must not replace the
            // caller's own error, and must not stop the others from closing.
          }
        }
        await worker.quiesce();
      };

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
            read: (sql, params, given) => {
              const query = checksql(sql);
              const { options, release } = withSignal(given);
              return readWorker(worker, query, params, options).finally(
                release,
              );
            },
            write: (sql, params, given) => {
              const query = checksql(sql);
              const { options, release } = withSignal(given);
              return writeWorker(worker, query, params, options).finally(
                release,
              );
            },
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
          given?: SQLiteChunkOptions,
        ) => {
          const query = checksql(sql);
          const { options, release } = withSignal(given);
          return readWorker<T>(worker, query, params, options).finally(release);
        },

        write: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: Interruptible,
        ) => {
          const query = checksql(sql);
          const { options, release } = withSignal(given);
          return writeWorker<T>(worker, query, params, options).finally(
            release,
          );
        },

        chunk: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: SQLiteChunkOptions,
        ) => {
          const query = checksql(sql);
          const { options, release } = withSignal(given);
          return releasing(
            // No lease work here: the transaction owns the lease, and
            // iterator.return() resolves `idle`, which settles the
            // quiesce().then(release) already pending in its own finally.
            chunkWorker<T>(worker, query, params, {
              ...options,
              onAbandon: release,
            }),
            release,
          );
        },

        stream: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: SQLiteChunkOptions,
        ) => {
          const query = checksql(sql);
          const { options, release } = withSignal(given);
          return releasing(
            // No lease work here: the transaction owns the lease, and
            // iterator.return() resolves `idle`, which settles the
            // quiesce().then(release) already pending in its own finally.
            streamRows<T>(worker, query, params, {
              ...options,
              onAbandon: release,
            }),
            release,
          );
        },

        first: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: Interruptible,
        ) => {
          const query = checksql(sql);
          const { options, release } = withSignal(given);
          return firstWorker<T>(worker, query, params, options).finally(
            release,
          );
        },

        bulkWrite: bulk.bulkWrite,
        output: bulk.output,

        commit: async () => {
          // The only place a COMMIT is refused, and it covers both callers: the
          // explicit tx.commit() and the auto-commit below. Without it a callback
          // that swallowed its statement's rejection could still commit, and the
          // transaction's own rejection would arrive after the data landed.
          signal?.throwIfAborted();
          await exec(worker, 'COMMIT');
          done = true;
        },

        rollback: async () => {
          await exec(worker, 'ROLLBACK');
          done = true;
        },
      };

      const { aborted, teardown } = makeAbortRace(signal);

      try {
        signal?.throwIfAborted();
        // BEGIN carries no signal, and neither do COMMIT and ROLLBACK. Their
        // completion is what decides whether a rollback is owed: a BEGIN that ran
        // on the worker but rejected on the client would return a connection to
        // the pool holding an open transaction, which is the state onPoisoned
        // exists to prevent. The cost is a window — while BEGIN is in flight the
        // transaction cannot be abandoned, and on a VFS rotating one exclusive
        // handle that wait can be long. The abort lands the moment BEGIN settles.
        await exec(worker, 'BEGIN');
        begun = true;
        // That window, closed: the signal may have fired while BEGIN was in
        // flight, and the transaction is open now. The callback never runs.
        signal?.throwIfAborted();

        const running = callback(db);
        // Racing the callback, not only its statements: an abort landing while
        // the callback sits in user code — an await on anything that is not a
        // statement — would otherwise be invisible until it returns, which may be
        // never. The callback is not interrupted, it is abandoned; it cannot
        // reach the worker afterwards because every statement it issues inherits
        // the aborted signal and rejects before the round trip, and the lease
        // returns to the pool only after quiesce().
        running.catch(() => {
          // Nothing consumes this rejection when the abort wins the race.
        });
        const result = aborted
          ? await Promise.race([running, aborted])
          : await running;

        await closeOpenStatements();

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
        await closeOpenStatements();

        if (begun && !done) {
          try {
            await db.rollback();
          } catch {
            // A failed rollback must not replace the caller's error, which is the
            // one that explains what actually went wrong. But the connection may
            // now hold an open transaction, and a read inside one reads that
            // transaction's snapshot — the barrier would refresh nothing and
            // report success. Evict instead of hoping.
            //
            // An abandoned `chunk()`/`stream()` generator no longer gets here:
            // closeOpenStatements() above drains it before this ROLLBACK is even
            // attempted, so the guard it used to trip never trips. What remains
            // is a connection broken for some other reason — a crashed worker, a
            // transport failure — where the ROLLBACK itself cannot be trusted to
            // have run, and eviction is the only sound response.
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
        teardown();
        // Same reasoning as write(): before the void, because release is
        // asynchronous. A read-only transaction commits nothing and must not
        // bump.
        if (!readOnly) await deps.afterWrite(worker);
        // The lease returns when the worker confirms it is idle, not when the
        // caller leaves: a worker still inside step() must not be re-lent, and
        // the caller must not wait for it.
        void lease.worker.quiesce().then(
          () => lease.release(),
          () => lease.release(),
        );
      }
    } finally {
      releaseDeadline();
    }
  };
