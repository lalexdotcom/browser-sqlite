import {
  createSQLiteClient,
  deleteDatabase,
  SQLiteError,
} from 'browser-sqlite';
import { describe, expect, it } from 'vitest';
import { VFS_CAPABILITIES } from '../../src/const/vfs';
import { createTestClient } from './helpers';

/**
 * `AccessHandlePoolVFS` cannot share access handles across connections, so its
 * pool is capped at 1. These are the sides that open a database: the cap as
 * default, and a pool of 1. The refusal of a larger pool runs in unit, for
 * every capped VFS (`tests/unit/vfs-guards.test.ts`).
 */
describe('AccessHandlePoolVFS pool guard', () => {
  // Falsifiable: restore `clientOptions.poolSize ?? DEFAULT_POOL_SIZE` in
  // client.ts. Selecting a single-connection VFS and nothing else used to
  // throw on a pool size the caller never chose.
  // One VFS: the subject is AccessHandlePoolVFS's own poolSize cap.
  it('defaults to the VFS cap rather than throwing when poolSize is omitted', async () => {
    const name = `bsq-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(name, { vfs: 'AccessHandlePoolVFS' });
    try {
      await db.write('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      expect(await db.read('SELECT id FROM t')).toEqual([]);
    } finally {
      await db.close();
      // One of AccessHandlePoolVFS's six fixed slots, given back by delete alone.
      await deleteDatabase(name, { vfs: 'AccessHandlePoolVFS' });
    }
  });

  // One VFS: the subject is AccessHandlePoolVFS's own poolSize guard.
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
  // One VFS: the subject is OPFSCoopSyncVFS's own poolSize cap.
  // Falsifiable: revert OPFSCoopSyncVFS.maxPoolSize to null — db.poolSize is
  // then 2, not 1.
  it('defaults to the VFS cap rather than throwing when poolSize is omitted', async () => {
    const db = createSQLiteClient(`bsq-test-${crypto.randomUUID()}`, {
      vfs: 'OPFSCoopSyncVFS',
    });
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
 * `VFS_CAPABILITIES` in `const/vfs.ts` is the single table declaring which wa-sqlite
 * builds each VFS accepts. The client checks the pair at construction so a bad
 * combination fails synchronously, with the supported builds named, instead of
 * surfacing later as an opaque `open-error` from inside a worker. The refusal
 * runs in unit (`tests/unit/vfs-guards.test.ts`); this is the accept side.
 */
describe('vfs/build combination guard', () => {
  // One VFS: the accept side of the guard whose refusal runs in unit.
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
  // One VFS (one per case): each case's own opening/round-trip is the
  // subject — the gate that keeps `pnpm test` honest about each addition.
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

describe('vfs is required', () => {
  // Falsifiable: restore `?? RECOMMENDED_VFS` in client.ts.
  it('throws synchronously when vfs is omitted', () => {
    expect(() =>
      // @ts-expect-error — the point of the guard is the runtime half, for
      // JavaScript consumers and for anyone who reached for `as any`.
      createSQLiteClient(`bsq-test-${crypto.randomUUID()}`, {}),
    ).toThrow(/vfs is required/);
  });

  // Falsifiable: name any VFS in the message `client.ts` throws here.
  it('points at the benchmark page and names no VFS', () => {
    let caught: unknown;
    try {
      // @ts-expect-error — see above.
      createSQLiteClient(`bsq-test-${crypto.randomUUID()}`, {});
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
