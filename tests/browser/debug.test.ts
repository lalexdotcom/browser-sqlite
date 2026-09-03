import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { createTestClient } from './helpers';

describe('debug subsystem (B6)', () => {
  it('is undefined when the option is absent', async () => {
    const db = await createTestClient();
    expect(db.debug).toBeUndefined();
    await db.close();
  });

  it('populates the whole chain after one read', async () => {
    const db = await createTestClient({ debug: true });

    await db.write('CREATE TABLE d (id INTEGER)');
    await db.write('INSERT INTO d (id) VALUES (1)');
    await db.read('SELECT id FROM d');

    const state = db.debug;
    expect(state).toBeDefined();

    const worker = state!.workers.find((w) => w?.requests.length);
    expect(worker).toBeDefined();

    // Find the request that served the SELECT — multiple requests exist because
    // the writes above each create one. assign() stamps acquireTime and links
    // worker.currentRequest, so a missing assign() leaves acquireTime undefined
    // and this test fails.
    const request = worker!.requests.find((r) =>
      r?.queries.some((q) => q.sql.includes('SELECT')),
    )!;
    // The request level is what wave 1 lost entirely — see spec §3.1.
    expect(request).toBeDefined();
    expect(request.acquireTime).toBeGreaterThan(0);
    expect(request.releaseTime).toBeGreaterThan(0);

    const query = request.queries[0]!;
    expect(query.sql).toContain('SELECT');
    expect(query.endTime).toBeGreaterThan(0);
    expect(query.firstRowTime).toBeGreaterThan(0);

    await db.close();
  });

  it('reads queue depths live from the scheduler', async () => {
    const db = await createTestClient({ debug: 'probe' });
    expect(db.debug!.queue.read).toBe(0);
    expect(db.debug!.queue.write).toBe(0);
    await db.close();
  });

  it('names the client the way its log lines are prefixed', async () => {
    const db = createSQLiteClient('debug-name.db', {
      vfs: 'IDBBatchAtomicVFS',
      name: 'ledger',
      debug: true,
    });
    onTestFinished(() => db.close());
    expect(db.debug?.name).toMatch(/^ledger \d+$/);
  });
});
