import { describe, expect, it } from '@rstest/core';
import {
  createTestClient,
  interceptWorkers,
  sleep,
  waitUntil,
} from './helpers';

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
 */
const SLOW_INSERT_ROWS = 20_000;
const SLOW_INSERT =
  'INSERT INTO t (a) WITH RECURSIVE c(x) AS ' +
  `(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${SLOW_INSERT_ROWS}) ` +
  'SELECT x FROM c';

/** The worker is holding a request it has not released — i.e. a write is live. */
const aRequestIsInFlight =
  (db: Awaited<ReturnType<typeof createTestClient>>) => () =>
    (db.debug?.workers ?? []).some(
      (w) => w.currentRequest && !w.currentRequest.releaseTime,
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
  // waits behind inFlight's web lock and completes instead of rejecting.
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
    const closing = db.close();
    await expect(queued).rejects.toMatchObject({ code: 'CLIENT_CLOSED' });
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
});
