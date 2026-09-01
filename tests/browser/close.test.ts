import { describe, expect, it } from '@rstest/core';
import { createTestClient, interceptWorkers, sleep } from './helpers';

/**
 * Polls until the predicate is true, yielding to the macrotask queue between
 * checks. Used to observe scheduler state without a fixed-duration sleep.
 */
const waitUntil = async (predicate: () => boolean): Promise<void> => {
  while (!predicate()) await sleep(0);
};

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
    const inFlight = db.write('INSERT INTO t (a) VALUES (1)');
    // Wait until inFlight has crossed the web-lock threshold and holds the
    // scheduler lease. Before this point close()'s abort signal would cancel
    // inFlight's pending lock request; after it the lock is granted and the
    // Web Locks spec guarantees the signal cannot revoke it.
    await waitUntil(() =>
      (db.debug?.workers ?? []).some(
        (w) => w.currentRequest && !w.currentRequest.releaseTime,
      ),
    );
    const closing = db.close();
    await expect(inFlight).resolves.toMatchObject({ affected: 1 });
    await closing;
  });

  // Falsifiable: delete the closeAbort.abort() call in close() — queued then
  // waits behind inFlight's web lock and completes instead of rejecting.
  it('rejects a queued request and every later call', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    await db.write('CREATE TABLE t (a)');
    const inFlight = db.write('INSERT INTO t (a) VALUES (1)');
    // Wait until inFlight holds the web lock and the scheduler lease. Starting
    // queued before this point would race: inFlight's lock might not be granted
    // yet and close() could abort both. After this point inFlight's lock is
    // irrevocable and queued is parked behind it — exactly where close() needs
    // to find it.
    await waitUntil(() =>
      (db.debug?.workers ?? []).some(
        (w) => w.currentRequest && !w.currentRequest.releaseTime,
      ),
    );
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
    void db.transaction(async () => {
      await new Promise(() => {}); // never settles
    });
    await sleep(100);
    await db.close(); // must settle, not hang
  });
});
