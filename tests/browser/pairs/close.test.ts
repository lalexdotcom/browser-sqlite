import { describe, expect, it } from 'vitest';
import {
  createTestClient,
  interceptWorkers,
  sharedDatabase,
  sleep,
  waitUntil,
} from '../helpers';

/**
 * A write slow enough to still be running when the next line looks at it.
 *
 * Both tests below have to catch a write IN FLIGHT, and the state they poll for
 * is transient: a one-row INSERT can start and finish between two polls, after
 * which the predicate is false for ever. That is not hypothetical — it failed
 * about one Firefox run in three until 2026-09-03, as a mute 30-second timeout,
 * and it only became visible when `pnpm test` started running Firefox too.
 *
 * The recursive CTE gives the window a floor measured in milliseconds rather
 * than microseconds. It is the precondition that needed widening, not the
 * behaviour under test: what is asserted after the wait is unchanged.
 *
 * 20 000 rows was not enough: ~20 ms in Firefox on Linux, less on Apple
 * Silicon, where the 4 ms polls missed the whole write (macOS runner,
 * 2026-10-14). 200 000 rows: 140-190 ms in Firefox, 50-80 ms in Chrome here.
 */
const SLOW_INSERT_ROWS = 200_000;
const SLOW_INSERT =
  'INSERT INTO t (a) WITH RECURSIVE c(x) AS ' +
  `(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${SLOW_INSERT_ROWS}) ` +
  'SELECT x FROM c';

/** A request holds a worker it has not handed back — i.e. a write is live. */
const aRequestIsInFlight =
  (db: Awaited<ReturnType<typeof createTestClient>>) => () =>
    (db.debug?.requests ?? []).some(
      (request) =>
        request.acquireTime !== undefined && request.endTime === undefined,
    );

describe('close()', () => {
  // Falsifiable: drop the await on the 'closed' reply in pool.ts — 'terminate'
  // then appears before 'recv:closed' in the trace.
  it('waits for the worker to close the database before terminating it', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');

    await db.close();

    const trace = records[0].log;
    expect(trace).toContain('post:close');
    expect(trace.indexOf('recv:closed')).toBeGreaterThan(
      trace.indexOf('post:close'),
    );
    expect(trace.indexOf('terminate')).toBeGreaterThan(
      trace.indexOf('recv:closed'),
    );
  });

  // Falsifiable: reject in-flight work instead of draining it.
  it('lets an in-flight write finish', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    await db.write('CREATE TABLE t (a)');
    const inFlight = db.write(SLOW_INSERT);
    // Wait until inFlight has crossed the web-lock threshold and holds the
    // scheduler lease. Before this point close()'s abort signal would cancel
    // inFlight's pending lock request; after it the lock is granted and the
    // Web Locks spec guarantees the signal cannot revoke it.
    await waitUntil(aRequestIsInFlight(db), 'the write to be in flight');
    const closing = db.close();
    await expect(inFlight).resolves.toMatchObject({
      affected: SLOW_INSERT_ROWS,
    });
    await closing;
  });

  // Falsifiable: delete the closeAbort.abort() call in close() — queued then
  // waits behind inFlight's web lock, and is refused only once inFlight is
  // done, by the scheduler's shutdown: the same CLIENT_CLOSED, too late. Hence
  // the order is asserted, not only the code.
  it('rejects a queued request and every later call', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    await db.write('CREATE TABLE t (a)');
    const inFlight = db.write(SLOW_INSERT);
    // Wait until inFlight holds the web lock and the scheduler lease. Starting
    // queued before this point would race: inFlight's lock might not be granted
    // yet and close() could abort both. After this point inFlight's lock is
    // irrevocable and queued is parked behind it — exactly where close() needs
    // to find it.
    await waitUntil(aRequestIsInFlight(db), 'the write to be in flight');
    const queued = db.write('INSERT INTO t (a) VALUES (2)');
    let inFlightSettled = false;
    const markSettled = () => {
      inFlightSettled = true;
    };
    void inFlight.then(markSettled, markSettled);
    const closing = db.close();
    await expect(queued).rejects.toMatchObject({ code: 'CLIENT_CLOSED' });
    // Rejected while inFlight still holds the lock, not after it.
    expect(inFlightSettled).toBe(false);
    await inFlight;
    await closing;
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'CLIENT_CLOSED',
    });
  });

  // Falsifiable: rebuild the promise on each call instead of memoizing it.
  it('is idempotent', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    const first = db.close();
    const second = db.close();
    expect(first).toBe(second);
    await first;
  });

  // Falsifiable: remove the drainTimeout race around the handshake — the test
  // then hangs on the never-returning callback instead of settling.
  it('is bounded when a transaction never finishes', async () => {
    const db = await createTestClient({ poolSize: 1, drainTimeout: 500 });
    await db.write('CREATE TABLE t (a)');
    // Caught, and it did not have to be until close() started settling this
    // transaction rather than leaving it pending for ever: an abandoned
    // rejection escapes the test file and fails the RUN while every test in it
    // passes.
    db.transaction(async () => {
      await new Promise(() => {}); // never settles
    }).catch(() => {});
    await sleep(100);
    await db.close(); // must settle, not hang
  });

  /**
   * Bounding `close()` was never the whole obligation: the CALLER of the
   * transaction was left waiting for ever too, because nothing told it the
   * client had gone. Measured before this was written — the transaction
   * promise never settled, and the first statement the callback issued after
   * `close()` HUNG rather than rejecting, since `PoolWorker` is the native
   * `Worker` and `terminate()` says nothing to our transport.
   */
  it('settles a transaction whose callback is still running', async () => {
    const db = await createTestClient({ poolSize: 1, drainTimeout: 500 });
    await db.write('CREATE TABLE t (a)');

    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transaction = db.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
      entered();
      await new Promise(() => {}); // user code that never comes back
    });
    await inside;

    // The handler must be attached BEFORE close(): the rejection lands inside
    // close(), and `expect(...).rejects` would subscribe a turn too late.
    const settled = transaction.then(
      () => 'resolved',
      (error: { code?: string }) => error.code ?? 'unknown',
    );
    await db.close();
    await expect(settled).resolves.toBe('CLIENT_CLOSED');
  });

  it('rejects — never hangs — a statement the callback issues after close()', async () => {
    const db = await createTestClient({ poolSize: 1, drainTimeout: 500 });
    await db.write('CREATE TABLE t (a)');

    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    // Settled by the callback with whatever its post-close statement did, so a
    // hang shows up as this test's own timeout rather than as a pass.
    let report!: (outcome: string) => void;
    const outcome = new Promise<string>((resolve) => {
      report = resolve;
    });

    const transaction = db.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
      entered();
      await gate;
      report(
        await tx.write('INSERT INTO t VALUES (2)').then(
          () => 'resolved',
          (error: { code?: string }) => error.code ?? 'unknown',
        ),
      );
    });
    transaction.catch(() => {});
    await inside;

    await db.close();
    resume();
    // Spec R3: the statement reports the closed handle; the transaction itself
    // still rejects with CLIENT_CLOSED (the test above).
    await expect(outcome).resolves.toBe('TRANSACTION_CLOSED');
  });

  // Falsifiable: reply `closed` without closing the VFS. Under
  // synchronous=NORMAL, IDBBatchAtomicVFS's last commit is still in flight when
  // the worker is terminated, and is lost about half the time on Chrome and
  // Firefox (wa-sqlite #384). The same close is what keeps Safari from
  // stranding the IndexedDB connection, which no other engine shows.
  it('keeps the last write of a client closed under synchronous=NORMAL', {
    tags: ['requires:idb-storage'],
  }, async () => {
    const database = sharedDatabase();
    const setup = database.open({ poolSize: 1 });
    await setup.write('CREATE TABLE t (a)');
    await setup.close();

    const ROUNDS = 10;
    for (let i = 0; i < ROUNDS; i++) {
      const db = database.open({
        poolSize: 1,
        pragmas: { synchronous: 'NORMAL' },
      });
      await db.write('INSERT INTO t (a) VALUES (?)', [i]);
      await db.close();
    }

    const reader = database.open({ poolSize: 1 });
    expect(
      await reader.read<{ n: number }>('SELECT count(*) AS n FROM t'),
    ).toEqual([{ n: ROUNDS }]);
  });
});
