import { describe, expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { SQLiteError } from '../../src/errors';
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

/**
 * Characterization tests for the `vfs` + `build` combination guard.
 *
 * `VFS_BUILDS` in `types.ts` is the single table declaring which wa-sqlite
 * builds each VFS accepts. The client checks the pair at construction so a bad
 * combination fails synchronously, with the supported builds named, instead of
 * surfacing later as an opaque `open-error` from inside a worker.
 */
describe('vfs/build combination guard', () => {
  it('throws when the build is not one the VFS supports', () => {
    // OPFSAdaptiveVFS declares ['async', 'jspi'] — 'sync' is not among them.
    expect(() =>
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {
        vfs: 'OPFSAdaptiveVFS',
        build: 'sync',
      }),
    ).toThrow(/cannot run on the 'sync' build/);
  });

  it('reports the failure as SQLiteError with code INVALID_OPTION', () => {
    let caught: unknown;
    try {
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {
        vfs: 'OPFSAdaptiveVFS',
        build: 'sync',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SQLiteError);
    expect((caught as SQLiteError).code).toBe('INVALID_OPTION');
    // The message must name the supported builds, or the caller cannot act.
    expect((caught as SQLiteError).message).toContain('async');
  });

  it('accepts an explicitly declared combination and serves queries', async () => {
    const db = await createTestClient({
      vfs: 'OPFSAdaptiveVFS',
      build: 'async',
    });

    await db.write('CREATE TABLE combo (id INTEGER, val TEXT)');
    await db.write("INSERT INTO combo VALUES (1, 'ok')");

    const rows = await db.read<{ id: number; val: string }>(
      'SELECT * FROM combo',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].val).toBe('ok');

    await db.close();
  });
});
