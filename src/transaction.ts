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
 * A statement generator the callback still holds, paired with the transport it
 * drains.
 *
 * Both halves are needed to close it from the outside. `gen.return()` alone is
 * queued behind a `next()` the callback left in flight and does not settle
 * until that `next()` does; `worker.interrupt(transport)` is what settles it,
 * and it names the transport because the pool refuses a stop from anyone but
 * the query's current owner.
 *
 * Both fields are filled after the entry exists, which is why both are
 * optional. `gen` is set before the entry ever reaches `open`. `transport`
 * arrives with `onTransport`, which for `chunk()` fires synchronously inside
 * the factory and for `stream()` fires on the first `next()` — `streamRows` is
 * itself a generator, so it does not reach `chunk()` until then. An entry with
 * no transport yet has no query on the worker either, and there is nothing for
 * `interrupt()` to stop.
 */
type OpenStatement = {
  gen?: AsyncGenerator<unknown>;
  transport?: AsyncGenerator<unknown>;
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
      const open = new Set<OpenStatement>();

      /** Runs `release` when the consumer stops reading, however it stops. */
      const releasing = <R>(
        source: AsyncGenerator<R>,
        release: () => void,
        entry: OpenStatement,
      ): AsyncGenerator<R> => {
        // The entry is the box the generator's own `finally` needs: it must
        // remove itself from `open` and cannot name a generator that does not
        // exist until the expression below has returned. The same indirection
        // `src/pool.ts`'s `query` factory uses, for the same reason, and it is
        // also where the transport lands, whenever the factory gets to it.
        const gen = (async function* () {
          try {
            yield* source;
          } finally {
            open.delete(entry);
            release();
          }
        })();
        entry.gen = gen;
        open.add(entry);
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
       *
       * `interrupt()` comes first, for the reason `queries.ts`'s own finally
       * gives: a method call on an async generator is queued behind a `next()`
       * already in flight, so a callback that left one outstanding — `void
       * g.next()`, or a `Promise.race` that lost — would park this `return()`
       * for the whole of a sort that may never end. BEGIN, COMMIT and ROLLBACK
       * carry no signal, so nothing else would cut it and the transaction would
       * neither reject nor give its worker back.
       *
       * **What this can cost.** `interrupt()` only cuts the wait short when the
       * statement was abortable; a transaction carrying no `signal` and no
       * `timeout` passes `abortable: false` (queries.ts), so worker.ts installs
       * no progress handler at all and has nothing to answer the stop with. On
       * that path — the ordinary one, not an edge case — the worker cannot be
       * interrupted, and the wait runs until the statement ends by itself or
       * `drainTimeout` in pool.ts elapses — 60 s by default — after which the
       * worker is declared dead, `quiesce()` settles, and the slot is evicted.
       * `drainTimeout` is that bound already; stacking a second one on top of
       * it is one more thing to get wrong, not more safety. The origin-wide
       * write lock is held for the whole of it.
       *
       * **What this does not fix.** The eviction still happens — measured on
       * `drainTimeout: 2000` as `workers=3 terminated=2`, and on Firefox, where
       * a rotating exclusive OPFS handle turns it into the amendment A5 puts at
       * 9/40. That is strictly better than the leak this replaces, where the
       * same callback hung forever and never gave the write lock back — a
       * bounded wait and a clean eviction instead of no bound at all — but it
       * is a limit carried forward, not a regression to apologize for.
       */
      const closeOpenStatements = async () => {
        for (const { gen, transport } of [...open]) {
          try {
            if (transport) worker.interrupt(transport);
            await gen?.return(undefined);
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
          const entry: OpenStatement = {};
          // No lease work here: the transaction owns the lease, and
          // iterator.return() resolves `idle`, which settles the
          // quiesce().then(release) already pending in its own finally.
          const source = chunkWorker<T>(worker, query, params, {
            ...options,
            onAbandon: release,
            onTransport: (iterator) => {
              entry.transport = iterator;
            },
          });
          return releasing(source, release, entry);
        },

        stream: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: SQLiteChunkOptions,
        ) => {
          const query = checksql(sql);
          const { options, release } = withSignal(given);
          // streamRows forwards its options straight to chunk(), but it is a
          // generator itself: the transport lands in `entry` on the first
          // next(), not here.
          const entry: OpenStatement = {};
          // No lease work here: the transaction owns the lease, and
          // iterator.return() resolves `idle`, which settles the
          // quiesce().then(release) already pending in its own finally.
          const source = streamRows<T>(worker, query, params, {
            ...options,
            onAbandon: release,
            onTransport: (iterator) => {
              entry.transport = iterator;
            },
          });
          return releasing(source, release, entry);
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
