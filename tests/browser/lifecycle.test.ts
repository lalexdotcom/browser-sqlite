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

  // Falsifiable: return 'evict' instead of 'restart' from the supervisor, or
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

    const running = db.read(longQuery(20_000_000));
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
