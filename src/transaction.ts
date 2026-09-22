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
import type { PoolWorker, PoolWorkerQueryOptions } from './pool';
import {
  chunk as chunkWorker,
  firstWorker,
  makeAbortRace,
  readWorker,
  streamRows,
  writeWorker,
} from './queries';
import type { Scheduler } from './scheduler';
import {
  isTransactionControl,
  isWriteQuery,
  mergeSignals,
  withDeadline,
} from './utils';

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
      /** See `src/bulk.ts`: the batch's place in this transaction's queue. */
      reserve?: () => { started: Promise<void>; done: () => void };
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
      /**
       * The conclusion owed to the savepoint the last savepointed write left
       * open (spec 2026-09-11, D5). The next message the transaction sends
       * carries it, and the worker runs it before anything else: `release`
       * keeps that write, `undo` rolls it back because its own signal abandoned
       * it. Undefined when no library savepoint is open.
       */
      let pending: 'release' | 'undo' | undefined;
      /**
       * Settles once a write abandoned by its own signal has ended on the
       * worker and been judged (spec 2026-09-11, R2). Every entry point waits
       * for it: nothing may reach the worker while that write still runs.
       * Never rejects.
       */
      let abandoned: Promise<void> | undefined;

      /**
       * The tail of this transaction's statement queue.
       *
       * Its statements share one connection with no scheduler lease between
       * them, so they must run one at a time. Issued sequentially they already
       * did — each one awaits `quiesce()` before it settles. Issued in the SAME
       * TICK they did not: both read the worker as free and the second met
       * `pool.ts`'s reuse guard, which lost the whole transaction to
       * `WORKER_BUSY` for what is baseline usage (`Promise.all` over
       * two reads).
       *
       * Each statement captures this SYNCHRONOUSLY and replaces it before its
       * first `await`. That is what makes the order the ISSUE order rather than
       * the resumption order: capturing after a wait would let concurrent
       * statements read the same tail and start together, which is the defect
       * moved rather than fixed.
       *
       * Never rejects — a statement's failure belongs to its caller, not to the
       * queue behind it.
       *
       * **`undefined` when no statement is in flight, and that is load-bearing,
       * not tidiness.** The uncontended path must post SYNCHRONOUSLY, as it
       * always has — the same invariant `entryWait` is careful about. Awaiting
       * an already-resolved tail still costs a microtask, and a statement whose
       * own signal aborts in that window never reaches the worker: it broke
       * spec R7 (`tests/unit/transaction.test.ts`, "does not die when a read is
       * abandoned by its own signal"), where the read must run on and be judged.
       */
      let tail: Promise<void> | undefined;

      // The SQL ends, for the transaction's own use. BEGIN, COMMIT and
      // ROLLBACK carry no signal, so a death can land while one is in flight.
      const commitNow = async () => {
        await exec(via(false), 'COMMIT');
        done = true;
        // A COMMIT that succeeded is what happened to the data, whatever died
        // meanwhile: overwrite, never keep an earlier death.
        ending = { kind: 'committed' };
      };
      const rollbackNow = async () => {
        // Straight to the worker, never through `via`: a full ROLLBACK
        // discards every savepoint, so there is nothing to conclude — and a
        // RELEASE sent to a connection that already left its transaction would
        // fail and evict a healthy worker (spec 2026-09-11, §4).
        pending = undefined;
        await exec(worker, 'ROLLBACK');
        done = true;
        // A rollback and a death both mean no effect, so a death that landed
        // first is kept, cause and all.
        ending ??= { kind: 'rolled-back' };
      };

      /**
       * The worker as one statement sees it (spec 2026-09-11, D9). Its `query`
       * hands the pool a thunk the pool reads only when it POSTS the query —
       * below the reuse guard — so a refused statement neither consumes the
       * pending conclusion nor claims a savepoint; and `mark` learns that the
       * statement reached the worker, which is what owes the idle wait (it
       * replaces `owesWait`: a statement the guard refused was never posted).
       * Everything else is the worker itself, through the prototype: the query
       * helpers call `query` and `interrupt`, and `interrupt` compares
       * transports by identity, which this leaves untouched.
       */
      const via = (open: boolean, mark?: { posted: boolean }): PoolWorker => {
        const facade: PoolWorker = Object.create(worker);
        facade.query = ((
          sql: string,
          params?: unknown[],
          options?: PoolWorkerQueryOptions,
        ) =>
          worker.query(sql, params, {
            ...options,
            savepoint: () => {
              if (mark) mark.posted = true;
              const conclude = pending;
              pending = open ? 'release' : undefined;
              if (!conclude && !open) return undefined;
              return {
                ...(conclude ? { conclude } : {}),
                ...(open ? { open: true as const } : {}),
              };
            },
          })) as PoolWorker['query'];
        return facade;
      };

      /**
       * R2 (spec 2026-09-11): a statement issued after a write abandoned by its
       * own signal waits until that write has ended and been judged. `waiting`
       * is the statement's merged signal: its own abort rejects it alone — it
       * has not reached the database — and the transaction's rejects it with
       * the cause. Call it only when `abandoned` is set, so that the common
       * path posts synchronously, as it always has.
       */
      const waitFor = async (
        current: Promise<void>,
        waiting: AbortSignal | undefined,
      ) => {
        // B9: addEventListener never fires for a signal already aborted.
        waiting?.throwIfAborted();
        const { aborted, teardown } = makeAbortRace(waiting);
        try {
          await (aborted ? Promise.race([current, aborted]) : current);
        } finally {
          teardown();
        }
        if (ending) throw closedError(ending);
      };

      const entryWait = async (waiting: AbortSignal | undefined) => {
        const current = abandoned;
        if (!current) return;
        await waitFor(current, waiting);
      };

      /**
       * Waiting one's turn in the statement queue, with a diagnosis attached.
       *
       * A wait that does not end has exactly one consumer-side cause — a
       * `chunk()`/`stream()` left open, which no statement after it can get
       * past — and that cause is indistinguishable from a consumer whose loop
       * body is merely slow: both leave the worker holding a query with nobody
       * pulling. So this WARNS rather than decides. An advisory may be wrong
       * about a slow consumer and cost nothing; an error may not, and refusing
       * the statement is what this whole change exists to stop doing.
       */
      const QUEUE_WARN_MS = 5_000;
      const queueWait = async (
        prior: Promise<void>,
        waiting: AbortSignal | undefined,
      ) => {
        const advisory = setTimeout(() => {
          deps.logger.always.warn(
            'A statement has waited several seconds for its turn on this ' +
              "transaction's connection. Statements in a transaction share one " +
              'connection and run one at a time, in issue order. A wait that ' +
              'never ends is usually a chunk() or stream() generator left open ' +
              '— exhaust it, break out of it, or call its return().',
          );
        }, QUEUE_WARN_MS);
        try {
          await waitFor(prior, waiting);
        } finally {
          clearTimeout(advisory);
        }
      };

      /**
       * The write was abandoned by its own signal while it ran (spec
       * 2026-09-11, R1). It runs on, driven by the transaction's signal alone;
       * the next message rolls it back, and every entry point waits for it. If
       * the connection left the transaction meanwhile, the transaction dies as
       * after any statement (spec 2026-09-10, D6).
       */
      const abandon = (running: Promise<unknown>, method: string) => {
        pending = 'undo';
        const judged: Promise<void> = running
          .then(
            () => ({ failed: false, error: undefined as unknown }),
            (error: unknown) => ({ failed: true, error }),
          )
          .then(async ({ failed, error }) => {
            await worker.quiesce();
            dieIfConnectionLeft(failed, error, method);
          })
          .catch(() => {
            // Judging must never reject: every entry point awaits this, and
            // the caller already has its rejection.
          })
          .finally(() => {
            if (abandoned === judged) abandoned = undefined;
          });
        abandoned = judged;
      };

      /**
       * Consumes an abandoned generator write to its end, discarding its rows,
       * so the worker's credits keep flowing and the write can finish (spec
       * 2026-09-11, §4). A `next()` still pending from the lost race is queued
       * ahead of this one, as async generators do.
       */
      const drainToEnd = async (source: AsyncGenerator<unknown>) => {
        for (;;) {
          const next = await source.next();
          if (next.done) return;
        }
      };

      /**
       * Whether a statement runs inside the library's savepoint (spec
       * 2026-09-11, R1): a write the caller may abandon alone — it carries its
       * own signal or timeout, not already aborted at the call. Only those pay
       * (D4). Never a transaction-control statement (D8).
       */
      const opensSavepoint = (
        sql: string,
        own: AbortSignal | undefined,
        abortedAtCall: boolean,
      ) =>
        own !== undefined &&
        !abortedAtCall &&
        isWriteQuery(sql) &&
        !isTransactionControl(sql);

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
       * guard a microtask later and throws `WORKER_BUSY`.
       *
       * **It costs nothing when there is nothing to wait for.** `quiesce()` is
       * `idle?.promise ?? Promise.resolve()`, and on a query that ended by
       * itself `pool.ts`'s transport finally has already resolved `idle` before
       * `done` is observable here — so the round trip is paid only where the
       * worker really is parked. And it adds no wait that was not already
       * running: that same finally performs the whole stop-and-drain bounded by
       * `drainTimeout`; awaiting `quiesce()` only OBSERVES it.
       *
       * It also owns the statement's own `timeout`: `withDeadline` turns
       * `given.timeout` into a signal exactly like the client path does, and
       * that signal is merged in here alongside the transaction's own —
       * without this a per-statement `timeout` type-checked and bounded
       * nothing.
       *
       * `settled` takes the query helper as a function of the worker facade and
       * the options, so it chooses both. **One exception to the idle wait, by
       * design (spec 2026-09-11, R1/R2):** a savepointed write rejected by its
       * own signal resolves its caller at once and runs on; the wait moves to
       * `abandoned`, which the next entry point awaits. The wait is owed only
       * by a statement that was posted (`mark.posted`) — a statement the reuse
       * guard refused never was.
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
        /**
         * `false` for a statement that ALREADY holds a place in the queue — the
         * batches of a `bulkWrite`, which reserve theirs synchronously in
         * `flush()` (`src/bulk.ts`). Without this they would wait for the slot
         * they are themselves holding.
         */
        queued = true,
      ): {
        options: O;
        driving: O;
        release: () => void;
        settled: <R>(
          start: (target: PoolWorker, options: O) => Promise<R>,
        ) => Promise<R>;
        own: AbortSignal | undefined;
        abortedAtCall: boolean;
        savepointed: boolean;
        mark: { posted: boolean };
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
        const savepointed = opensSavepoint(sql, own.signal, abortedAtCall);
        const mark = { posted: false };
        const options = { ...given, signal: merged.signal } as O;
        // A savepointed write's QUERY runs with the transaction's signal alone,
        // so that only a death cuts it: SQLite closes every savepoint when it
        // interrupts a write (spec 2026-09-11, §1).
        const driving = savepointed ? ({ ...given, signal } as O) : options;
        const settled = async <R>(
          start: (target: PoolWorker, options: O) => Promise<R>,
        ): Promise<R> => {
          // Captured and replaced BEFORE the first await, so the queue keeps
          // the issue order even when statements are created in one tick.
          const prior = queued ? tail : undefined;
          const mine = Promise.withResolvers<void>();
          if (queued) tail = mine.promise;
          let failed = false;
          let error: unknown;
          // Set when the caller was rejected by its own signal while the write
          // ran on: from then on the wait belongs to `abandoned`.
          let left = false;
          try {
            if (prior) await queueWait(prior, options.signal);
            if (abandoned) await entryWait(options.signal);
            if (!savepointed) return await start(via(false, mark), options);
            // Its own signal may have fired during the wait: then it never
            // reached the worker, and rejects alone.
            own.signal?.throwIfAborted();
            const running = start(via(true, mark), driving);
            const { aborted, teardown } = makeAbortRace(own.signal);
            try {
              return await (aborted
                ? Promise.race([running, aborted])
                : running);
            } catch (e) {
              if (
                mark.posted &&
                own.signal?.aborted === true &&
                e === own.signal.reason
              ) {
                left = true;
                abandon(running, method);
              }
              throw e;
            } finally {
              teardown();
            }
          } catch (e) {
            failed = true;
            error = e;
            throw e;
          } finally {
            release();
            try {
              if (mark.posted && !left) {
                await worker.quiesce();
                dieIfConnectionLeft(failed, error, method);
              }
            } finally {
              // After quiesce, never before: the next statement in the queue
              // must find the worker genuinely idle. And in a `finally` of its
              // own, because `dieIfConnectionLeft` throws — a death must not
              // strand every statement queued behind it.
              //
              // **Resolved WITH `prior`, not empty.** A statement that leaves
              // the queue early — aborted by its own signal while it was still
              // waiting its turn — never waited for its own place, so handing
              // an empty resolution on would let the next statement start while
              // the one at the head was still in flight. It met the reuse guard
              // there, which is the defect this queue exists to remove
              // (`tx-concurrent.test.ts`, "rejects a statement aborted while it
              // waits its turn"). A place left early is passed on, not cancelled.
              if (tail === mine.promise) tail = undefined;
              mine.resolve(prior);
            }
          }
        };
        return {
          options,
          driving,
          release,
          settled,
          own: own.signal,
          abortedAtCall,
          savepointed,
          mark,
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
        entry: OpenStatement,
        st: {
          release: () => void;
          own: AbortSignal | undefined;
          abortedAtCall: boolean;
          savepointed: boolean;
          mark: { posted: boolean };
          options: { signal?: AbortSignal | undefined };
        },
        method: string,
      ): AsyncGenerator<R> => {
        // The entry is the box the generator's own `finally` needs: it must
        // remove itself from `open` and cannot name a generator that does not
        // exist until the expression below has returned. The same indirection
        // `src/pool.ts`'s `query` factory uses, for the same reason, and it is
        // also where the transport lands, whenever the factory gets to it.
        const gen = (async function* () {
          if (ending) {
            open.delete(entry);
            st.release();
            throw closedError(ending);
          }
          // The queue, joined at the FIRST next() rather than at creation:
          // this body does not run until the consumer pulls, and a generator
          // created but never pulled holds no worker — making it hold the queue
          // would deadlock every statement behind it. In a `Promise.all` the
          // `for await` pulls before the next statement is issued, so the issue
          // order still holds.
          const prior = tail;
          const mine = Promise.withResolvers<void>();
          tail = mine.promise;
          let failed = false;
          let error: unknown;
          // As in `settled`: set when the consumer was rejected by the
          // statement's own signal while the write ran on.
          let left = false;
          try {
            if (prior) await queueWait(prior, st.options.signal);
            if (abandoned) await entryWait(st.options.signal);

            // **The queue waits on the WORKER, not on this object.** A consumer
            // that stops pulling a query which has already reached `done`
            // leaves this body suspended at its `yield` for ever, so the
            // `finally` below never runs — while pool.ts has long since cleared
            // `deferredChunk` and the worker is free. Blocking the queue on
            // that is wrong, and `abandon.test.ts` ("does not truncate the query
            // the worker has moved on to") says so.
            //
            // So the release is `free()` — the pool's own "the guard would let
            // the next one through", resolved where `deferredChunk` is cleared.
            // NOT `quiesce()`, which waits for the transport's finally and so
            // never fires for a parked consumer. Armed at the FIRST value,
            // strictly after the query has posted, which makes it deterministic
            // rather than a bet on when a task runs. A generator abandoned
            // mid-stream never frees the worker, and that is the case the queue
            // is meant to hold.
            const releaseQueue = () => {
              if (tail === mine.promise) tail = undefined;
              mine.resolve(prior);
            };
            let watching = false;
            const watchIdle = () => {
              if (watching) return;
              watching = true;
              void worker.free().then(releaseQueue, releaseQueue);
            };

            if (!st.savepointed) {
              try {
                for await (const value of source) {
                  watchIdle();
                  yield value;
                }
              } finally {
                // `yield*` forwarded the consumer's `return()` to the source on
                // its own; the explicit loop owes it by hand, exactly as the
                // savepointed branch below already does.
                await source.return(undefined);
              }
              return;
            }
            st.own?.throwIfAborted();
            const { aborted, teardown } = makeAbortRace(st.own);
            try {
              while (true) {
                const next = aborted
                  ? await Promise.race([source.next(), aborted])
                  : await source.next();
                if (next.done) return;
                watchIdle();
                yield next.value;
              }
            } catch (e) {
              if (
                st.mark.posted &&
                st.own?.aborted === true &&
                e === st.own.reason
              ) {
                left = true;
                abandon(drainToEnd(source), method);
              }
              throw e;
            } finally {
              teardown();
              // What `yield*` did for the other branch: the consumer's break or
              // return() reaches the query. Not for an abandoned write, which
              // drainToEnd now owns.
              if (!left) await source.return(undefined);
            }
          } catch (e) {
            failed = true;
            error = e;
            throw e;
          } finally {
            open.delete(entry);
            st.release();
            // The generator half of `settled`'s invariant, and the reason it
            // belongs HERE rather than at the callback's boundary: a generator
            // abandoned BETWEEN two statements — `break` out of a `for await`,
            // an explicit `return()` — is not what closeOpenStatements() sees,
            // since that runs once the callback is over. `drain`'s own finally
            // has already gone out with the interrupt by the time this runs,
            // because `yield*` forwards `return()` to the source and awaits it.
            // Not owed by an abandoned write either: drainToEnd now owns its
            // wait, and judging it is abandon()'s job, not this finally's.
            try {
              if (st.mark.posted && !left) {
                await worker.quiesce();
                dieIfConnectionLeft(failed, error, method);
              }
            } finally {
              if (tail === mine.promise) tail = undefined;
              mine.resolve(prior);
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
              const { settled } = withSignal(given, 'read', query);
              return settled((target, options) =>
                readWorker(target, query, params, options),
              );
            },
            write: (sql, params, given) => {
              if (ending) return Promise.reject(closedError(ending));
              const query = checksql(sql);
              // Not queued: `flush()` took the slot synchronously, the moment
              // the batch was committed to. Asking for a second one here would
              // wait for the first.
              const { settled } = withSignal(given, 'write', query, false);
              return settled((target, options) =>
                writeWorker(target, query, params, options),
              );
            },
            /**
             * A batch takes its place in the queue the instant `flush()` is
             * called — synchronously, from `close()` or from the `enqueue()`
             * that filled the buffer — and holds it until the batch has been
             * written. Without it the batch posts a microtask later and a
             * statement issued after it runs FIRST, which is not an error but a
             * stale read: `tests/browser/tx-concurrent.test.ts` caught a count
             * of 2 where the rows were 4.
             */
            reserve: () => {
              const prior = tail;
              const mine = Promise.withResolvers<void>();
              tail = mine.promise;
              return {
                started: prior ?? Promise.resolve(),
                done: () => {
                  if (tail === mine.promise) tail = undefined;
                  mine.resolve(prior);
                },
              };
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
          if (ending) return Promise.reject(closedError(ending));
          const query = checksql(sql);
          const { settled } = withSignal(given, 'read', query);
          return settled((target, options) =>
            readWorker<T>(target, query, params, options),
          );
        },

        write: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: Interruptible,
        ) => {
          if (ending) return Promise.reject(closedError(ending));
          const query = checksql(sql);
          const { settled } = withSignal(given, 'write', query);
          return settled((target, options) =>
            writeWorker<T>(target, query, params, options),
          );
        },

        chunk: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: SQLiteChunkOptions,
        ) => {
          const query = checksql(sql);
          const st = withSignal(given, 'chunk', query);
          const entry: OpenStatement = {};
          // No lease work here: the transaction owns the lease, and
          // iterator.return() resolves `idle`, which settles the
          // quiesce().then(release) already pending in its own finally.
          const source = chunkWorker<T>(
            via(st.savepointed, st.mark),
            query,
            params,
            {
              ...(st.savepointed ? st.driving : st.options),
              onAbandon: st.release,
              onTransport: (iterator) => {
                entry.transport = iterator;
              },
            },
          );
          return releasing(source, entry, st, 'chunk');
        },

        stream: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: SQLiteChunkOptions,
        ) => {
          const query = checksql(sql);
          const st = withSignal(given, 'stream', query);
          // streamRows forwards its options straight to chunk(), but it is a
          // generator itself: the transport lands in `entry` on the first
          // next(), not here.
          const entry: OpenStatement = {};
          // No lease work here: the transaction owns the lease, and
          // iterator.return() resolves `idle`, which settles the
          // quiesce().then(release) already pending in its own finally.
          const source = streamRows<T>(
            via(st.savepointed, st.mark),
            query,
            params,
            {
              ...(st.savepointed ? st.driving : st.options),
              onAbandon: st.release,
              onTransport: (iterator) => {
                entry.transport = iterator;
              },
            },
          );
          return releasing(source, entry, st, 'stream');
        },

        first: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: Interruptible,
        ) => {
          if (ending) return Promise.reject(closedError(ending));
          const query = checksql(sql);
          const { settled } = withSignal(given, 'first', query);
          return settled((target, options) =>
            firstWorker<T>(target, query, params, options),
          );
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
          // COMMIT is a statement on the same worker, so it takes its place in
          // the queue like any other: an explicit commit() created alongside
          // the write it concludes must follow it, not race it.
          const prior = tail;
          const mine = Promise.withResolvers<void>();
          tail = mine.promise;
          try {
            if (prior) await queueWait(prior, signal);
            if (abandoned) await entryWait(signal);
            await commitNow();
          } finally {
            if (tail === mine.promise) tail = undefined;
            mine.resolve(prior);
          }
        },

        rollback: async () => {
          if (ending) {
            if (ending.kind === 'committed')
              deps.logger.always.warn(
                'rollback() was called on a transaction that has already committed; nothing was rolled back.',
              );
            return;
          }
          const prior = tail;
          const mine = Promise.withResolvers<void>();
          tail = mine.promise;
          try {
            if (prior) await queueWait(prior, signal);
            if (abandoned) await entryWait(signal);
            await rollbackNow();
          } finally {
            if (tail === mine.promise) tail = undefined;
            mine.resolve(prior);
          }
        },
        // The merged signal itself (spec §4): it aborts on every cause of death with the cause as
        // reason, and the outer finally only detaches it, so a normal end leaves it un-aborted for good.
        // The death controller is never exposed — the consumer can listen, not abort.
        signal,
      };

      const { aborted, teardown } = makeAbortRace(signal);

      try {
        signal?.throwIfAborted();
        // BEGIN carries no signal, and neither do COMMIT and ROLLBACK — this
        // concerns BEGIN in both its deferred and IMMEDIATE forms. Their
        // completion is what decides whether a rollback is owed: a BEGIN that ran
        // on the worker but rejected on the client would return a connection to
        // the pool holding an open transaction, which is the state onPoisoned
        // exists to prevent. The cost is a window — while BEGIN is in flight the
        // transaction cannot be abandoned, and on a VFS rotating one exclusive
        // handle that wait can be long. The abort lands the moment BEGIN settles.
        //
        // A write transaction announces itself: OPFSWriteAheadVFS refuses one
        // that reaches its first write from a deferred BEGIN — "Write
        // transaction cannot use BEGIN DEFERRED" — and the client stayed broken
        // afterwards (spec 2026-09-15, A4). The origin write lock is already
        // held here, so IMMEDIATE only moves SQLite's RESERVED lock to the start
        // of a transaction no other writer can be in. A read-only one stays
        // deferred: it takes no write lock and must not ask SQLite for one.
        await exec(via(false), readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
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
          // Spec 2026-09-11, R2: the COMMIT waits for a write abandoned by its
          // own signal, and carries its undo.
          if (abandoned) await entryWait(signal);
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
