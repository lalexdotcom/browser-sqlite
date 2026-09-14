import { describe, expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { SQLiteError } from '../../src/errors';
import { VFS_CAPABILITIES } from '../../src/types';
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

  // Falsifiable: restore `clientOptions.poolSize ?? DEFAULT_POOL_SIZE` in
  // client.ts. Selecting a single-connection VFS and nothing else used to
  // throw on a pool size the caller never chose.
  it('defaults to the VFS cap rather than throwing when poolSize is omitted', async () => {
    const db = createSQLiteClient(
      `browser-sqlite-test-${crypto.randomUUID()}`,
      { vfs: 'AccessHandlePoolVFS' },
    );
    try {
      await db.write('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      expect(await db.read('SELECT id FROM t')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  // Falsifiable: revert the pool guard in client.ts to `throw new Error(...)`.
  it('reports the pool guard as SQLiteError with code INVALID_OPTION', () => {
    let caught: unknown;
    try {
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {
        vfs: 'AccessHandlePoolVFS',
        poolSize: 2,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SQLiteError);
    expect((caught as SQLiteError).code).toBe('INVALID_OPTION');
    // The message must carry the reason, or the caller cannot act on it.
    expect((caught as SQLiteError).message).toMatch(
      /pool sizes greater than 1/,
    );
    expect((caught as SQLiteError).message).toMatch(/access handles/);
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

describe('OPFSCoopSyncVFS pool guard', () => {
  it('throws when combined with an explicit poolSize > 1', () => {
    expect(() =>
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {
        vfs: 'OPFSCoopSyncVFS',
        poolSize: 2,
      }),
    ).toThrow(/pool sizes greater than 1/);
  });

  it('defaults to the VFS cap rather than throwing when poolSize is omitted', async () => {
    const db = createSQLiteClient(
      `browser-sqlite-test-${crypto.randomUUID()}`,
      { vfs: 'OPFSCoopSyncVFS' },
    );
    try {
      await db.write('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      expect(await db.read('SELECT id FROM t')).toEqual([]);
      expect(db.poolSize).toBe(1);
    } finally {
      await db.close();
    }
  });
});

/**
 * Characterization tests for the `vfs` + `build` combination guard.
 *
 * `VFS_CAPABILITIES` in `types.ts` is the single table declaring which wa-sqlite
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

/**
 * Each newly wired VFS opens on its default build and serves a round trip.
 * The exhaustive build sweep lives in the conformance project; this is the
 * gate that keeps `pnpm test` honest about the four additions.
 */
describe('newly wired VFS', () => {
  // Falsifiable: delete any one loader from VFSConfigs in worker/worker.ts.
  const cases = [
    // poolSize 1 because the capability table now says so — see MIRROR-1.
    { vfs: 'IDBMirrorVFS', poolSize: 1 },
    { vfs: 'OPFSAnyContextVFS', poolSize: 2 },
    { vfs: 'MemoryVFS', poolSize: 1 },
    { vfs: 'MemoryAsyncVFS', poolSize: 1 },
  ] as const;

  for (const { vfs, poolSize } of cases) {
    it(`${vfs} opens and serves a round trip`, async () => {
      const db = await createTestClient({ vfs, poolSize });

      await db.write('CREATE TABLE wired (id INTEGER, val TEXT)');
      await db.write("INSERT INTO wired VALUES (1, 'ok')");

      const rows = await db.read<{ id: number; val: string }>(
        'SELECT * FROM wired',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].val).toBe('ok');

      await db.close();
    });
  }
});

/**
 * The memory VFS hold their pages in the worker that opened them, so a pool
 * would hold independent databases diverging silently. That is corruption, not
 * volatility, and the guard states it.
 */
describe('memory VFS pool guard', () => {
  // Falsifiable: set maxPoolSize to null on MemoryVFS in VFS_CAPABILITIES.
  for (const vfs of ['MemoryVFS', 'MemoryAsyncVFS'] as const) {
    it(`${vfs} refuses a pool larger than 1`, () => {
      let caught: unknown;
      try {
        createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {
          vfs,
          poolSize: 2,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SQLiteError);
      expect((caught as SQLiteError).code).toBe('INVALID_OPTION');
      expect((caught as SQLiteError).message).toMatch(/diverge/);
    });
  }
});

describe('vfs is required', () => {
  // Falsifiable: restore `?? RECOMMENDED_VFS` in client.ts.
  it('throws synchronously when vfs is omitted', () => {
    expect(() =>
      // @ts-expect-error — the point of the guard is the runtime half, for
      // JavaScript consumers and for anyone who reached for `as any`.
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {}),
    ).toThrow(/vfs is required/);
  });

  // Falsifiable: name any VFS in the message `client.ts` throws here.
  it('points at the benchmark page and names no VFS', () => {
    let caught: unknown;
    try {
      // @ts-expect-error — see above.
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SQLiteError);
    expect((caught as SQLiteError).code).toBe('INVALID_OPTION');
    expect((caught as SQLiteError).message).toContain(
      'lalexdotcom.github.io/browser-sqlite',
    );
    // The recommendation is documentation, not code. A VFS named here would
    // travel in a string a consumer copies, and each VFS is its own store, so
    // the day the recommendation moves that name points at another database.
    for (const vfs of Object.keys(VFS_CAPABILITIES)) {
      expect((caught as SQLiteError).message).not.toContain(vfs);
    }
  });
});
