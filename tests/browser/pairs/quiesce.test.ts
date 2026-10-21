import { describe, expect, it } from 'vitest';
import {
  createTestClient,
  interceptWorkers,
  killSilently,
  waitUntil,
} from '../helpers';

/**
 * A worker the client kills without a `closed` reply — a crash, a timeout, a
 * failed client. On an IndexedDB VFS it is first asked to quiesce: Safari
 * before WebKit 321564@main keeps the connection of a worker terminated with a
 * transaction live, and a kill mid-write stranded the database in 3-22 % of
 * kills on Safari 26.6.2 (2026-10-20). The transport is cut at once either way.
 */
const crash = (worker: Worker) =>
  worker.dispatchEvent(new ErrorEvent('error', { message: 'simulated' }));

describe('a worker killed without closing', () => {
  // Falsifiable: terminate at once on every VFS — no post:quiesce.
  it('is asked to quiesce, and terminated once it has', {
    tags: ['requires:idb-storage'],
  }, async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, maxWorkerRestarts: 0 });
    await db.write('CREATE TABLE t (a)');

    crash(records[0].worker);
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });
    await waitUntil(() => records[0].terminated, 'the kill');

    const trace = records[0].log;
    expect(trace.indexOf('post:quiesce')).toBeGreaterThan(-1);
    expect(trace.indexOf('recv:quiesced')).toBeGreaterThan(
      trace.indexOf('post:quiesce'),
    );
    expect(trace.indexOf('terminate')).toBeGreaterThan(
      trace.indexOf('recv:quiesced'),
    );
  });

  // Falsifiable: wait for `quiesced` with no bound — a worker already gone
  // answers nothing, and the client would hold it for ever.
  it('is terminated after a grace when it cannot answer', {
    tags: ['requires:idb-storage'],
  }, async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, maxWorkerRestarts: 0 });
    await db.write('CREATE TABLE t (a)');

    // Gone without the library knowing: no message will ever come back.
    killSilently(records[0].worker);
    const killedAt = performance.now();
    crash(records[0].worker);
    await waitUntil(() => records[0].terminated, 'the kill');
    const waited = performance.now() - killedAt;

    expect(records[0].log).toContain('post:quiesce');
    expect(records[0].log).not.toContain('recv:quiesced');
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(waited).toBeLessThan(5_000);
  });

  // Falsifiable: quiesce every VFS — OPFS handles would outlive the kill by
  // the grace, while the replacement opens.
  it('is terminated at once on a VFS without IndexedDB', {
    tags: ['excludes:idb-storage'],
  }, async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, maxWorkerRestarts: 0 });
    await db.write('CREATE TABLE t (a)');

    crash(records[0].worker);

    expect(records[0].terminated).toBe(true);
    expect(records[0].log).not.toContain('post:quiesce');
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });
  });
});
