import { describe, expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { createTestClient } from './helpers';

/**
 * Characterization tests for the `AccessHandlePoolVFS` + `poolSize` guard.
 *
 * `AccessHandlePoolVFS` cannot share access handles across connections, so the
 * client refuses any pool larger than 1 — at construction time, synchronously.
 * The guard is easy to break during the pool refactor (wave 1), hence the test.
 */
describe('AccessHandlePoolVFS pool guard', () => {
  it('throws when combined with an explicit poolSize > 1', () => {
    expect(() =>
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {
        vfs: 'AccessHandlePoolVFS',
        poolSize: 2,
      }),
    ).toThrow(/pool sizes greater than 1/);
  });

  it('throws with the default poolSize, which is 2', () => {
    // Footgun: selecting this VFS without also setting poolSize: 1 fails.
    expect(() =>
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {
        vfs: 'AccessHandlePoolVFS',
      }),
    ).toThrow(/pool sizes greater than 1/);
  });

  it('accepts poolSize 1 and serves queries', async () => {
    const db = await createTestClient({
      vfs: 'AccessHandlePoolVFS',
      poolSize: 1,
    });

    await db.write('CREATE TABLE ahp (id INTEGER, val TEXT)');
    await db.write("INSERT INTO ahp VALUES (1, 'ok')");

    const rows = await db.read<{ id: number; val: string }>(
      'SELECT * FROM ahp',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].val).toBe('ok');

    db.close();
  });
});
