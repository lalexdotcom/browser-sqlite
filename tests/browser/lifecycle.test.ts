// tests/browser/lifecycle.test.ts
import { describe, expect, it } from '@rstest/core';
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

  // Falsifiable: delete the `fail()` call on the 'fail-client' decision.
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

  // Falsifiable: replace the load-failure message with a bare 'worker error'.
  it('names the URL it failed to load', async () => {
    interceptWorkers({ url: '/definitely-missing-worker.js' });
    const db = await createTestClient({ poolSize: 1 });

    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
      message: expect.stringContaining('definitely-missing-worker.js'),
    });
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      message: expect.stringContaining('Bundler Configuration'),
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
