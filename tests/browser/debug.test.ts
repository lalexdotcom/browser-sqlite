import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { createTestClient, TEST_TARGET } from './helpers';

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

    // Not "a query with SELECT": the freshness barrier itself is a SELECT and
    // can land on a write's own request too, on a worker's first call.
    const request = state!.requests.find((r) => r.kind === 'read')!;
    expect(request).toBeDefined();
    expect(request.kind).toBe('read');
    expect(request.worker).toBeDefined();
    expect(request.acquireTime).toBeGreaterThanOrEqual(request.startTime);
    expect(request.endTime).toBeGreaterThanOrEqual(request.acquireTime!);

    const query = request.queries.at(-1)!;
    expect(query.sql).toContain('SELECT');
    expect(query.endTime).toBeGreaterThan(0);
    expect(query.firstRowTime).toBeGreaterThan(0);
    expect(query.rows).toBe(1);
    expect(request.rows).toBe(
      request.queries.reduce((sum, q) => sum + q.rows, 0),
    );

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
      vfs: TEST_TARGET.vfs,
      build: TEST_TARGET.build,
      name: 'ledger',
      debug: true,
    });
    onTestFinished(() => db.close());
    expect(db.debug?.name).toMatch(/^ledger \d+$/);
  });
});
