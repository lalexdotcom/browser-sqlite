import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * INT-02: createSQLiteClient initializes and workers reach READY
 *
 * Strategy: createSQLiteClient is synchronous but workers initialize
 * asynchronously. The first query (`db.read('SELECT 1')`) is queued
 * until a worker is READY — if it fails, the pool is not initialized.
 * No source code changes required (no `ready` property exposed).
 */
describe('createSQLiteClient (INT-02)', () => {
  it('initializes the worker pool and responds to a simple query', async () => {
    const db = await createTestClient();

    // If workers are not READY, this query will reject or timeout (30s)
    const rows = await db.read<{ value: number }>('SELECT 1 AS value');

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(1);

    db.close();
  });

  it('supports poolSize: 1 (minimum)', async () => {
    // createTestClient uses the default poolSize: 2
    // Verify that a minimal pool works
    const { createSQLiteClient } = await import('../../src/client');
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;

    const cleanup = async () => {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(dbName, { recursive: true });
      } catch {
        /* ok */
      }
    };

    // afterEach is not available here directly — clean up manually
    try {
      const db = createSQLiteClient(dbName, { poolSize: 1 });
      const rows = await db.read<{ n: number }>('SELECT 42 AS n');
      expect(rows[0].n).toBe(42);
      db.close();
    } finally {
      await cleanup();
    }
  });

  it('returns the same result on multiple consecutive calls', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE init_test (id INTEGER PRIMARY KEY)');
    await db.write('INSERT INTO init_test VALUES (1)');
    await db.write('INSERT INTO init_test VALUES (2)');

    const rows = await db.read<{ id: number }>(
      'SELECT id FROM init_test ORDER BY id',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(1);
    expect(rows[1].id).toBe(2);

    db.close();
  });
});
