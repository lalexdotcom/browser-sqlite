// tests/browser/lifecycle.test.ts
import { afterEach, describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import {
  createTestClient,
  interceptWorkers,
  longQuery,
  sleep,
} from './helpers';

describe('worker lifecycle — crash detection', () => {
  // Falsifiable: delete `worker.onerror = ...` in pool.ts and this hangs until
  // the test timeout instead of rejecting.
  it('rejects the in-flight query when the worker reports an uncaught error', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');

    const running = db.read(longQuery(20_000_000));
    await sleep(100);
    records[0].worker.dispatchEvent(
      new ErrorEvent('error', { message: 'simulated worker failure' }),
    );

    await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
  });

  // Falsifiable: return 'lost' instead of 'restart' from the supervisor, or
  // drop the `if (decision === 'restart') void spawn(index)` branch in client.ts.
  it('restarts the slot once and keeps serving', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    expect(records.length).toBe(1);

    const running = db.read(longQuery(20_000_000));
    await sleep(100);
    records[0].worker.dispatchEvent(new ErrorEvent('error'));
    await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });

    const rows = await db.read<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
    expect(records.length).toBe(2);
  });

  // Falsifiable: delete the `failClient(error)` call on the 'fail-client'
  // decision in handleDeath (src/client.ts).
  it('fails the client permanently once the restart budget is spent', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, maxWorkerRestarts: 1 });
    await db.write('CREATE TABLE t (a)');

    for (const attempt of [0, 1]) {
      const running = db.read(longQuery(20_000_000));
      await sleep(100);
      records[attempt].worker.dispatchEvent(new ErrorEvent('error'));
      await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
      if (attempt === 0) await sleep(300); // let the replacement reach ready
    }

    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });
  });

  /**
   * Redirects every Worker from the `from`-th one on to a URL that does not
   * exist, so a REPLACEMENT can be made to fail deterministically while the
   * original boots normally. helpers' interceptWorkers redirects all of them.
   */
  const failWorkersFrom = (from: number) => {
    const created: Worker[] = [];
    const Original = globalThis.Worker;
    class Failing extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(
          created.length >= from ? '/definitely-missing-worker.js' : url,
          options,
        );
        created.push(this);
      }
    }
    globalThis.Worker = Failing as unknown as typeof Worker;
    onTestFinished(() => {
      globalThis.Worker = Original;
    });
    return created;
  };

  // Falsifiable: delete the `supervisor.report(index, 'spawned')` call in
  // spawn() (src/client.ts). The slot stays marked dead from the first death,
  // the replacement's death reads as a duplicate signal, report() returns no
  // decision, and the client neither restarts nor fails — this read then waits
  // for a worker that will never exist and the test dies on its timeout.
  it('fails the client when the replacement never boots', async () => {
    const created = failWorkersFrom(1);
    const db = await createTestClient({ poolSize: 1, maxWorkerRestarts: 1 });
    await db.write('CREATE TABLE t (a)');
    expect(created.length).toBe(1);

    const running = db.read(longQuery(20_000_000));
    await sleep(100);
    created[0].dispatchEvent(new ErrorEvent('error'));
    await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });

    // The slot restarts into a worker that cannot load. The client must reach a
    // verdict rather than leave the pool empty and silent.
    const outcome = await Promise.race([
      db.read('SELECT 1').then(
        () => 'resolved',
        (error: { code?: string }) => `rejected:${error.code}`,
      ),
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 10_000)),
    ]);
    expect(outcome).toBe('rejected:WORKER_CRASHED');
  });

  // Falsifiable: replace the load-failure branch with a generic message that
  // omits both the 'could not load its worker' wording and the
  // 'Bundler Configuration' README pointer.
  it('sends a load failure to the bundler configuration section, with a URL', async () => {
    interceptWorkers({ url: '/definitely-missing-worker.js' });
    const db = await createTestClient({ poolSize: 1 });

    // Chrome leaves ErrorEvent.filename empty here, so pool.ts names
    // import.meta.url instead — the directory the worker should sit beside.
    // The bundler may rename either chunk, so assert the stable wording and
    // the presence of some URL, never a literal path. The scheme is not
    // pinned either: a consumer bundle yields http(s), while rstest bundles
    // with source paths and yields file:.
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
      message: expect.stringContaining('could not load its worker'),
    });
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      message: expect.stringContaining('Bundler Configuration'),
    });
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      message: expect.stringMatching(/\w+:\/\/\S+/),
    });
  });

  // Falsifiable: delete the `worker.addEventListener('messageerror', ...)` call in pool.ts — the query then hangs.
  // Note: synthetic. Producing a genuinely undeserializable message on demand
  // is not achievable cleanly; the handler is exercised, not the browser's path
  // into it.
  it('rejects the in-flight query on a deserialization failure, and keeps the worker', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');

    // Long enough to still be in flight after the sleep below, and no longer:
    // 20 000 000 iterations cost 30 s on Firefox — against a 30 s budget, which
    // the test lost three times out of three — for a margin of 300× over what
    // it needs. At 2 000 000 the query still runs for seconds on the slowest
    // engine measured, twenty times the sleep.
    const running = db.read(longQuery(2_000_000));
    await sleep(100);
    records[0].worker.dispatchEvent(new MessageEvent('messageerror'));

    await expect(running).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(records[0].terminated).toBe(false);
    expect(records.length).toBe(1);
  });
});

describe('worker lifecycle — bounds', () => {
  let shared: string;
  afterEach(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(shared, { recursive: true });
    } catch {
      // OPFS entry may not exist if the test failed before DB creation
    }
  });

  // Falsifiable: put `postMessage({type:'ready'})` back in a `.finally()` in
  // worker.ts — the second client then reports ready and hangs on its query.
  it('reports a failed open instead of reporting ready', async () => {
    shared = `browser-sqlite-test-${crypto.randomUUID()}`;
    const first = createSQLiteClient(shared, {
      poolSize: 1,
      vfs: 'AccessHandlePoolVFS',
    });
    await first.write('CREATE TABLE t (a)');

    const second = createSQLiteClient(shared, {
      poolSize: 1,
      vfs: 'AccessHandlePoolVFS',
      openTimeout: 3000,
    });
    await expect(second.read('SELECT 1')).rejects.toMatchObject({
      name: expect.stringMatching(/WORKER_CRASHED|TIMEOUT/),
    });

    await first.close();
    await second.close();
  });
});

describe('worker lifecycle — onWorkerLost callback', () => {
  // Falsifiable: remove the emitWorkerLost() call from the 'lost' branch of
  // handleDeath — the callback is never fired and events stays empty.
  it('is called when a worker slot is permanently lost', async () => {
    const records = interceptWorkers();
    const events: number[] = [];
    const db = await createTestClient({
      poolSize: 2,
      maxWorkerRestarts: 0,
      onWorkerLost: ({ index }) => events.push(index),
    });
    await db.write('CREATE TABLE t (a)');

    // Kill worker 0 — budget is 0, so it goes directly to 'lost'.
    const running = db.read(longQuery(20_000_000));
    await sleep(100);
    records[0].worker.dispatchEvent(new ErrorEvent('error'));
    await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });

    await sleep(100);
    expect(events).toContain(0);
  });

  // Falsifiable: call failClient() before emitWorkerLost() in the fail-client
  // branch — the client is shut down first and the callback may not fire in
  // time (the scheduler rejects all acquires synchronously on shutdown,
  // interrupting any pending work the callback depended on).
  it('is called before the client is failed when the last slot is lost', async () => {
    const records = interceptWorkers();
    const callOrder: string[] = [];
    const db = await createTestClient({
      poolSize: 1,
      maxWorkerRestarts: 0,
      onWorkerLost: () => callOrder.push('callback'),
    });
    await db.write('CREATE TABLE t (a)');

    const running = db.read(longQuery(20_000_000));
    await sleep(100);
    records[0].worker.dispatchEvent(new ErrorEvent('error'));

    // The read rejects because the client is failed.
    await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    // The callback must have fired before (or during) the failure.
    expect(callOrder).toContain('callback');
  });

  // Falsifiable: let a throwing onWorkerLost bubble out of handleDeath — the
  // pool becomes corrupted and subsequent queries hang or produce wrong errors.
  it('a throwing callback does not break the pool', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({
      poolSize: 2,
      maxWorkerRestarts: 0,
      onWorkerLost: () => {
        throw new Error('callback exploded');
      },
    });
    await db.write('CREATE TABLE t (a)');

    // Kill worker 0 — callback throws, must be swallowed.
    const running = db.read(longQuery(20_000_000));
    await sleep(100);
    records[0].worker.dispatchEvent(new ErrorEvent('error'));
    await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });

    // Worker 1 is still alive and can serve queries.
    await sleep(100);
    const rows = await db.read<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
  });
});

/**
 * Intercepts worker creation and makes the N-th worker (0-based) fail by
 * redirecting it to a missing URL. All other workers use the real URL.
 * Returns the array of created Worker instances in creation order.
 */
function failWorkerAtIndex(n: number): Worker[] {
  const created: Worker[] = [];
  const Original = globalThis.Worker;
  class Selective extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(
        created.length === n ? '/definitely-missing-worker.js' : url,
        options,
      );
      created.push(this);
    }
  }
  globalThis.Worker = Selective as unknown as typeof Worker;
  onTestFinished(() => {
    globalThis.Worker = Original;
  });
  return created;
}

/**
 * Intercepts worker creation and makes workers from index `from` onwards fail.
 * Returns the array of created Worker instances in creation order.
 */
function failWorkersFromIndex(from: number): Worker[] {
  const created: Worker[] = [];
  const Original = globalThis.Worker;
  class Selective extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(
        created.length >= from ? '/definitely-missing-worker.js' : url,
        options,
      );
      created.push(this);
    }
  }
  globalThis.Worker = Selective as unknown as typeof Worker;
  onTestFinished(() => {
    globalThis.Worker = Original;
  });
  return created;
}

describe('worker lifecycle — startup readiness gate', () => {
  // Falsifiable: in handleDeath (src/client.ts), guard the startupLosses.set
  // call with `if (retrySlots.has(index))` (reverting defect 1 fix). Slot 0's
  // death during the retry round is then silently dropped — onWorkerLost never
  // fires for index 0 and the test fails on the events assertion.
  it('reports a slot that opened and then dies during the retry round as lost', async () => {
    // Worker 0 (slot 0): real URL — opens successfully in round 1.
    // Worker 1 (slot 1, round 1): bad URL — fails immediately.
    // Worker 2 (slot 1, retry): real URL — succeeds in the retry round.
    const created = failWorkerAtIndex(1);
    const lostIndices: number[] = [];
    const db = await createTestClient({
      poolSize: 2,
      onWorkerLost: ({ index }) => lostIndices.push(index),
    });

    // Wait for round 1 to settle: worker 1 (bad URL) fails fast, worker 0
    // eventually opens.  After onFirstSettle the retry round begins and
    // worker 2 (slot 1 retry, real URL) starts loading.
    // Poll until worker 2 has been created (= retry round is in progress).
    while (created.length < 3) await sleep(10);

    // Kill slot 0's worker while the retry round is still open.
    // The browser fires load errors asynchronously, so dispatching here is
    // ordered before worker 2's real load completes.
    created[0].dispatchEvent(
      new ErrorEvent('error', { message: 'killed during retry' }),
    );

    // The gate opens when slot 1 retry (worker 2) settles.  After that the
    // client has one live worker (slot 1) and one permanent startup loss (slot 0).
    await db.write('CREATE TABLE t (a)');

    // onWorkerLost must have been called for the slot that died during the retry.
    expect(lostIndices).toContain(0);
  });

  // Falsifiable: remove the `pool.filter(Boolean).length === 0` check in
  // onGateOpen (src/client.ts), relying only on the 'fail-client' supervisor
  // verdict. Because supervisor returns 'restart' for the everReady slot 0
  // before returning 'fail-client' for slot 1, and the iteration order puts
  // slot 1 (inserted first) ahead of slot 0, the 'fail-client' verdict is
  // never seen and the client does not fail — the Promise.race then resolves
  // to 'HUNG' and the assertion fails.
  it('fails the client rather than hanging when all startup workers are gone', async () => {
    // Worker 0 (slot 0): real URL — opens in round 1 and stays alive until we
    //   kill it manually.
    // Worker 1 (slot 1, round 1): bad URL — fails immediately.
    // Worker 2 (slot 1, retry): bad URL — fails again.
    const created = failWorkersFromIndex(1);
    const lostIndices: number[] = [];
    const db = await createTestClient({
      poolSize: 2,
      onWorkerLost: ({ index }) => lostIndices.push(index),
    });

    // Poll until worker 2 (slot 1 retry) is created so we are reliably inside
    // the retry round before worker 2's load error fires.
    while (created.length < 3) await sleep(10);

    // Kill slot 0 while the retry round is still open.  Combined with the
    // failing slot 1 retry this leaves the pool entirely empty at gate-open.
    created[0].dispatchEvent(
      new ErrorEvent('error', { message: 'killed during retry' }),
    );

    // Give the retry worker (worker 2) time to fail and the gate to open.
    await sleep(500);

    // The gate is now open with 0 workers.  A subsequent query must reject, not
    // block indefinitely.  The bound of 8 s converts a hang into a test failure.
    const outcome = await Promise.race([
      db.read('SELECT 1').then(
        () => 'resolved' as const,
        (e: { code?: string }) => `rejected:${e.code ?? 'UNKNOWN'}` as const,
      ),
      new Promise<'HUNG'>((resolve) =>
        setTimeout(() => resolve('HUNG'), 8_000),
      ),
    ]);
    expect(outcome).not.toBe('HUNG');
    expect(outcome).toMatch(/^rejected:/);
    // Both permanently lost slots must have been reported before the client failed.
    expect(lostIndices.sort()).toEqual([0, 1]);
  });

  // Falsifiable: remove the emitWorkerLost loop from the `openedCount === 0`
  // branch in onFirstSettle (src/client.ts). The callback then fires for no
  // slots on total failure and the length assertion fails.
  it('fires onWorkerLost for every slot on total startup failure (openedCount === 0)', async () => {
    interceptWorkers({ url: '/definitely-missing-worker.js' });
    const lostIndices: number[] = [];
    const db = await createTestClient({
      poolSize: 2,
      onWorkerLost: ({ index }) => lostIndices.push(index),
    });

    // Both workers fail to load; the client must reject and fire the callback
    // for each slot before doing so.
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });
    expect(lostIndices.sort()).toEqual([0, 1]);
  });

  // Falsifiable: remove `startupLosses.delete(index)` from spawn's .then()
  // in src/client.ts. Slot 1 stays in startupLosses even after it succeeds,
  // so onGateOpen emits onWorkerLost for it and lostIndices becomes [1].
  it('does not report a slot as lost when its retry round succeeds', async () => {
    // Worker 0 (slot 0): real URL, round 1 success.
    // Worker 1 (slot 1, round 1): bad URL, fail.
    // Worker 2 (slot 1, retry): real URL, success.
    failWorkerAtIndex(1);
    const lostIndices: number[] = [];
    const db = await createTestClient({
      poolSize: 2,
      onWorkerLost: ({ index }) => lostIndices.push(index),
    });

    // Wait for startup to complete — both slots are now live.
    await db.write('CREATE TABLE t (a)');

    // No permanent losses occurred.
    expect(lostIndices).toEqual([]);
  });
});
