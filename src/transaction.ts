import type {
  Interruptible,
  SQLiteChunkOptions,
  SQLiteQueryAPI,
  SQLiteTransactionDB,
  SQLiteTransactionOptions,
} from './api';
import type { ReadFn, TransactionFn, WriteFn } from './bulk';
import { SQLiteError } from './errors';
import type { Logger } from './logger';
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
     * Aborted when the client closes, with `CLIENT_CLOSED`.
     *
     * Merged into the transaction's own signal so that closing ABANDONS a
     * running transaction the way a caller's `signal` does — the callback is
     * not interrupted, it simply can no longer reach the database. Without it
     * the caller of a transaction whose callback sits on an `await` that is not
     * a statement waited for ever: nothing else in the transaction observes the
     * client going away.
     */
    closeSignal: AbortSignal;
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
      /**
       * Called when a bulkWrite() or output() made on this target is abandoned
       * by its own signal or timeout. A transaction passes one, because an
       * abandoned write abandons the transaction (spec 2026-09-10, R1) and this
       * signal exists only in here; the client path passes none.
       */
      onAbandoned?: (cause: unknown) => void;
    }) => {
      bulkWrite: SQLiteQueryAPI['bulkWrite'];
      output: SQLiteQueryAPI['output'];
    };
    /**
     * Reached only through `always`: `rollback()` on a transaction that has
     * already committed warns whatever the `debug` option says (spec R4) — a
     * warning visible only under debug would be the same as silence.
     */
    logger: Pick<Logger, 'always'>;
  }) =>
  async <T = void>(
    callback: (db: SQLiteTransactionDB) => Promise<T>,
    options?: SQLiteTransactionOptions,
  ): Promise<T> => {
    const { readOnly = false, autoCommit = true } = options ?? {};
    // The deadline is the transaction's own signal from here on: it reaches
    // the lease acquisition, every inner statement through withSignal, and the
    // race against the callback itself.
    const { signal: deadline, release: releaseDeadline } = withDeadline(
      options,
      'transaction',
    );
    // The close signal joins the caller's own here, at the single place the
    // transaction's signal is built, so it reaches everything the comment above
    // lists without any of them being told about it.
    const { signal: outer, release: releaseClose } = mergeSignals(
      deadline,
      deps.closeSignal,
    );
    // The causes of death decided inside the transaction (spec R1) — an
    // abandoned write, a connection that left — join the three that come from
    // outside by aborting this, so the race, the statements in flight and the
    // handle's ending all see them the same way.
    const death = new AbortController();
    const { signal: merged, release: releaseDeath } = mergeSignals(
      outer,
      death.signal,
    );
    // Never undefined, since death.signal is not — mergeSignals cannot say so.
    const signal = merged ?? death.signal;
    /**
     * How this transaction ended, set once — except that a COMMIT that
     * succeeds records `committed` over a death that landed while it was in
     * flight (spec §4). Every public method of the handle reads it at its
     * entry: once it is set, nothing the handle does reaches the worker,
     * which by then may be serving someone else (spec §1.2).
     */
    type Ending =
      | { kind: 'committed' }
      | { kind: 'rolled-back' }
      | { kind: 'died'; cause: unknown };
    let ending: Ending | undefined;
    // The existing causes of death — the caller's signal, the timeout,
    // close() — all abort `signal`; this is where they become an ending.
    const onAbort = () => {
      ending ??= { kind: 'died', cause: signal?.reason };
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const closedError = (end: Ending): SQLiteError =>
      new SQLiteError(
        'TRANSACTION_CLOSED',
        end.kind === 'died'
          ? 'This transaction was abandoned; nothing more can run in it.'
          : `This transaction has already ${end.kind === 'committed' ? 'committed' : 'rolled back'}; nothing more can run in it.`,
        end.kind === 'died' ? { cause: end.cause } : undefined,
      );

    /** Kills the transaction with `cause` (spec R1). Nothing once it has ended. */
    const die = (cause: unknown) => {
      if (!ending) death.abort(cause);
    };
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

      // The SQL ends, for the transaction's own use. BEGIN, COMMIT and
      // ROLLBACK carry no signal, so a death can land while one is in flight.
      const commitNow = async () => {
        await exec(worker, 'COMMIT');
        done = true;
        // A COMMIT that succeeded is what happened to the data, whatever died
        // meanwhile: overwrite, never keep an earlier death.
        ending = { kind: 'committed' };
      };
      const rollbackNow = async () => {
        await exec(worker, 'ROLLBACK');
        done = true;
        // A rollback and a death both mean no effect, so a death that landed
        // first is kept, cause and all.
        ending ??= { kind: 'rolled-back' };
      };

      /**
       * Whether a statement that ended in `error` owes the wait below.
       *
       * It does not when `pool.ts`'s reuse guard refused it: that rejection
       * means the statement never claimed the worker, so the query in flight
       * belongs to somebody else and waiting for it would be wrong twice over.
       * It would park a rejection that has somewhere to be — the callback, or
       * the transaction's own unwinding — behind a query this statement has no
       * business serializing with. Two statements issued at once are one way to
       * reach the guard; the other is a generator the callback simply DROPPED,
       * and there nothing has closed that query at all — `idle` resolves only
       * when `closeOpenStatements()` returns the generator at the end of the
       * callback, which is precisely where the rejection was heading. Waiting
       * here deadlocks the two against each other, and that was found by the
       * test that pins the boundary, not by review.
       */
      const owesWait = (error: unknown): boolean =>
        !(error instanceof SQLiteError && error.code === 'GENERATOR_ABANDONED');

      /**
       * Whether `error` is a WRITE abandoned WHILE IT RAN, by its own signal
       * or timeout (spec 2026-09-10, D4 reversed). The SQL decides, not the
       * method — read(), first(), chunk() and stream() accept a write too —
       * but a signal already aborted AT THE CALL does not count: that write
       * never reached the worker, so it rejects alone and the callback may
       * continue, exactly as for any other caught error.
       */
      const isAbandonedWrite = (
        error: unknown,
        own: AbortSignal | undefined,
        sql: string,
        abortedAtCall: boolean,
      ) =>
        !abortedAtCall &&
        own?.aborted === true &&
        error === own.reason &&
        isWriteQuery(sql);

      /**
       * Kills the transaction when the connection reports it is no longer in
       * one (spec R1, D6) — read after quiesce(), once the worker's reply has
       * been processed. The cause is the statement's own error, or, when it
       * succeeded, a TRANSACTION_CLOSED naming it (spec R2).
       */
      const dieIfConnectionLeft = (
        failed: boolean,
        error: unknown,
        method: string,
      ) => {
        if (!begun || ending || worker.inTransaction !== false) return;
        die(
          failed
            ? error
            : new SQLiteError(
                'TRANSACTION_CLOSED',
                `The connection left the transaction after ${method}().`,
              ),
        );
      };

      /**
       * The options a statement runs with: the transaction's signal, merged with
       * the caller's own when they gave one, so either may abort the statement
       * and the reason is always the source's. `release` is owed once the
       * statement has settled — the merge is the only thing here that subscribes
       * to a signal the caller may keep alive far longer than this transaction.
       *
       * `settled` is the second half, and every promise-returning statement must
       * return through it: **a statement does not resolve until the worker is
       * idle again.** Inside a transaction the statements share one worker with
       * no scheduler lease between them, so a statement that leaves its
       * transport without reaching `done` — `first()` on any query with a row
       * left to produce, a `read()`/`write()` cut short by an abort — leaves
       * `pool.ts`'s `deferredChunk` set: `queries.ts` posts the stop and fires
       * `iterator.return()` WITHOUT awaiting it, deliberately, because the
       * client path has a lease to do the waiting and no reason to block. Here
       * nobody does, so the next statement in the same callback meets the reuse
       * guard a microtask later and throws `GENERATOR_ABANDONED`.
       *
       * **It costs nothing when there is nothing to wait for.** `quiesce()` is
       * `idle?.promise ?? Promise.resolve()`, and on a query that ended by
       * itself `pool.ts`'s transport finally has already resolved `idle` before
       * `done` is observable here — so the round trip is paid only where the
       * worker really is parked. And it adds no wait that was not already
       * running: that same finally performs the whole stop-and-drain bounded by
       * `drainTimeout`; awaiting `quiesce()` only OBSERVES it.
       *
       * The pairing is the point. A statement gets its signal here or not at
       * all, so a method that skips this helper is visibly wrong rather than
       * quietly missing its wait — which is what carries the invariant for the
       * next method added to `SQLiteTransactionDB`. Generator-returning
       * statements take `release` instead and wait in `releasing`'s finally,
       * which is the same rule at the only other place a statement can end.
       *
       * It also owns the statement's own `timeout`: `withDeadline` turns
       * `given.timeout` into a signal exactly like the client path does, and
       * that signal is merged in here alongside the transaction's own —
       * without this a per-statement `timeout` type-checked and bounded
       * nothing.
       */
      const withSignal = <
        O extends {
          signal?: AbortSignal | undefined;
          timeout?: number | undefined;
        },
      >(
        given: O | undefined,
        method: string,
        sql: string,
      ): {
        options: O;
        release: () => void;
        settled: <R>(promise: Promise<R>) => Promise<R>;
        own: AbortSignal | undefined;
        abortedAtCall: boolean;
      } => {
        const own = withDeadline(given, method);
        // At the call, before anything can settle: D4 reversed decides on
        // this snapshot, not on whatever `own.signal.aborted` reads once the
        // statement has already rejected.
        const abortedAtCall = own.signal?.aborted === true;
        const merged = mergeSignals(signal, own.signal);
        const release = () => {
          merged.release();
          own.release();
        };
        const settled = async <R>(promise: Promise<R>): Promise<R> => {
          let refused = false;
          let failed = false;
          let error: unknown;
          try {
            return await promise;
          } catch (e) {
            failed = true;
            error = e;
            refused = !owesWait(e);
            // Before the wait, so the transaction — and tx.signal — die at
            // once rather than when the worker is idle again.
            if (isAbandonedWrite(e, own.signal, sql, abortedAtCall)) die(e);
            throw e;
          } finally {
            release();
            if (!refused) {
              await worker.quiesce();
              dieIfConnectionLeft(failed, error, method);
            }
          }
        };
        return {
          options: { ...given, signal: merged.signal } as O,
          release,
          settled,
          own: own.signal,
          abortedAtCall,
        };
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
        own: AbortSignal | undefined,
        sql: string,
        method: string,
        abortedAtCall: boolean,
      ): AsyncGenerator<R> => {
        // The entry is the box the generator's own `finally` needs: it must
        // remove itself from `open` and cannot name a generator that does not
        // exist until the expression below has returned. The same indirection
        // `src/pool.ts`'s `query` factory uses, for the same reason, and it is
        // also where the transport lands, whenever the factory gets to it.
        const gen = (async function* () {
          // Checked before the try, not inside it (review I2): a closed
          // handle throws here at once, without the finally below waiting on
          // `worker.quiesce()` for a statement that never claimed the
          // worker — the `owesWait` rule applied on this, the generator half
          // of the same path `settled` guards with `refused`.
          if (ending) {
            open.delete(entry);
            release();
            throw closedError(ending);
          }
          let refused = false;
          let failed = false;
          let error: unknown;
          try {
            yield* source;
          } catch (e) {
            failed = true;
            error = e;
            refused = !owesWait(e);
            if (isAbandonedWrite(e, own, sql, abortedAtCall)) die(e);
            throw e;
          } finally {
            open.delete(entry);
            release();
            // The generator half of `settled`'s invariant, and the reason it
            // belongs HERE rather than at the callback's boundary: a generator
            // abandoned BETWEEN two statements — `break` out of a `for await`,
            // an explicit `return()` — is not what closeOpenStatements() sees,
            // since that runs once the callback is over. `drain`'s own finally
            // has already gone out with the interrupt by the time this runs,
            // because `yield*` forwards `return()` to the source and awaits it.
            if (!refused) {
              await worker.quiesce();
              dieIfConnectionLeft(failed, error, method);
            }
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
       * **What this can cost, and what decides it is the BUILD.** An earlier
       * version of this comment said a transaction carrying no `signal` and no
       * `timeout` passes `abortable: false`. That is wrong: `withSignal` merges
       * the transaction's signal into every statement, `mergeSignals` returns
       * the surviving side when one is absent, and `closeSignal` is always
       * defined — so a statement inside a transaction is ALWAYS abortable, and
       * worker.ts always installs its progress handler. Measured on 2026-09-10:
       * `first()` on a query whose second row costs a 3 M-row recursion returns
       * in 2.4 ms on the async build, against 683 ms for the same query on the
       * client path, which passes no signal and is genuinely not abortable.
       *
       * What is left is the case worker.ts cannot serve: on the `sync` build
       * WITHOUT cross-origin isolation it installs no progress handler at all —
       * no yield to read the stop, no abort slot to poll — so a worker inside
       * `step()` runs to the end of that statement. The same query measures
       * 360 ms there. The wait then runs until the statement ends by itself or
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
              if (ending) return Promise.reject(closedError(ending));
              const query = checksql(sql);
              const { options, settled } = withSignal(given, 'read', query);
              return settled(readWorker(worker, query, params, options));
            },
            write: (sql, params, given) => {
              if (ending) return Promise.reject(closedError(ending));
              const query = checksql(sql);
              const { options, settled } = withSignal(given, 'write', query);
              return settled(writeWorker(worker, query, params, options));
            },
            // The caller's transaction is already open. No BEGIN, no COMMIT.
            // db is referenced before its const declaration, deliberately: this arrow
            // only runs when output().close() fires, by which point db is assigned.
            // Moving `bulk` below `const db` breaks the literal that consumes it.
            transaction: (fn) => fn(db),
            onAbandoned: (cause: unknown) => die(cause),
          });

      const db: SQLiteTransactionDB = {
        read: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: SQLiteChunkOptions,
        ) => {
          if (ending) return Promise.reject(closedError(ending));
          const query = checksql(sql);
          const { options, settled } = withSignal(given, 'read', query);
          return settled(readWorker<T>(worker, query, params, options));
        },

        write: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: Interruptible,
        ) => {
          if (ending) return Promise.reject(closedError(ending));
          const query = checksql(sql);
          const { options, settled } = withSignal(given, 'write', query);
          return settled(writeWorker<T>(worker, query, params, options));
        },

        chunk: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: SQLiteChunkOptions,
        ) => {
          const query = checksql(sql);
          const { options, release, own, abortedAtCall } = withSignal(
            given,
            'chunk',
            query,
          );
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
          return releasing(
            source,
            release,
            entry,
            own,
            query,
            'chunk',
            abortedAtCall,
          );
        },

        stream: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: SQLiteChunkOptions,
        ) => {
          const query = checksql(sql);
          const { options, release, own, abortedAtCall } = withSignal(
            given,
            'stream',
            query,
          );
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
          return releasing(
            source,
            release,
            entry,
            own,
            query,
            'stream',
            abortedAtCall,
          );
        },

        first: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: Interruptible,
        ) => {
          if (ending) return Promise.reject(closedError(ending));
          const query = checksql(sql);
          const { options, settled } = withSignal(given, 'first', query);
          return settled(firstWorker<T>(worker, query, params, options));
        },

        bulkWrite: ((...args: Parameters<SQLiteQueryAPI['bulkWrite']>) => {
          if (ending) throw closedError(ending);
          return bulk.bulkWrite(...args);
        }) as SQLiteQueryAPI['bulkWrite'],
        output: ((...args: Parameters<SQLiteQueryAPI['output']>) => {
          if (ending) throw closedError(ending);
          return bulk.output(...args);
        }) as SQLiteQueryAPI['output'],

        commit: async () => {
          // The only place a COMMIT is refused, and it covers both callers: the
          // explicit tx.commit() and the auto-commit below. Without it a callback
          // that swallowed its statement's rejection could still commit, and the
          // transaction's own rejection would arrive after the data landed. The
          // listener sets `ending` synchronously when the signal aborts, so this
          // guard covers what `throwIfAborted()` did.
          if (ending) {
            if (ending.kind === 'committed') return;
            throw closedError(ending);
          }
          await commitNow();
        },

        rollback: async () => {
          if (ending) {
            if (ending.kind === 'committed')
              deps.logger.always.warn(
                'rollback() was called on a transaction that has already committed; nothing was rolled back.',
              );
            return;
          }
          await rollbackNow();
        },
        // The merged signal itself (spec §4): it aborts on every cause of death with the cause as
        // reason, and the outer finally only detaches it, so a normal end leaves it un-aborted for good.
        // The death controller is never exposed — the consumer can listen, not abort.
        signal,
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
          // An abort that landed after the callback returned — during
          // closeOpenStatements() — still refuses the COMMIT, and with the
          // cause rather than TRANSACTION_CLOSED: this is the transaction's own
          // outcome (spec R2), not a late statement.
          signal?.throwIfAborted();
          if (autoCommit) await commitNow();
          else await rollbackNow();
        }
        return result;
      } catch (e) {
        // First: tx.signal aborts whenever transaction() rejects, whatever the
        // reason (spec 2026-09-10, R8 amended). die() is a no-op once the
        // transaction has already ended or died, so a death that caused this
        // rejection keeps its own cause; otherwise the handle becomes `died`
        // with cause `e` here, before anything else runs.
        die(e);

        // Only roll back if the transaction is still open. `done` is set after the
        // statement succeeds, so a COMMIT that failed leaves it false and the
        // transaction still active — that case must still roll back.
        await closeOpenStatements();

        // SQLite may already have left the transaction by itself — an
        // interrupted write rolls the whole transaction back. A ROLLBACK then
        // fails, and failing it evicted a healthy worker (spec §1.1, R6). A
        // worker that has reported nothing yet counts as open: the default can
        // only cost a ROLLBACK that fails, never skip one that was owed.
        if (begun && !done && worker.inTransaction !== false) {
          try {
            await rollbackNow();
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
        // No path out of transaction() may leave the handle open (spec §4).
        ending ??= { kind: 'rolled-back' };
        // Detached here, before afterWrite() publishes the commit epoch — not
        // after it — so a close() or a timeout landing during afterWrite
        // cannot abort tx.signal on a transaction that has already resolved
        // as committed (spec 2026-09-10, R8 amended). Kept in the outer
        // finally too (idempotent): it covers a failed lease acquisition,
        // which never reaches this inner finally at all.
        releaseDeath();
        signal?.removeEventListener('abort', onAbort);
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
      signal?.removeEventListener('abort', onAbort);
      releaseDeath();
      releaseClose();
      releaseDeadline();
    }
  };
