import { createSQLiteClient, SQLiteError } from 'browser-sqlite';
import { describe, expect, it } from 'vitest';
import { defaultBuildFor, missingFeature } from '../../../src/capabilities';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../../src/const/vfs';
import { createTestClient, forEachCase, TEST_TARGET } from '../helpers';
import { AVAILABLE_FEATURES } from '../helpers/environment';

/**
 * A VFS that cannot share access handles across connections caps its pool
 * (`maxPoolSize` in `VFS_CAPABILITIES`). These are the sides that open a
 * database: the cap as default, and a pool of 1. The refusal of a larger pool
 * runs in unit, for every capped VFS (`tests/unit/vfs-guards.test.ts`).
 */
describe('a VFS that caps its pool', {
  tags: ['requires:capped-pool'],
}, () => {
  // Falsifiable: restore `clientOptions.poolSize ?? DEFAULT_POOL_SIZE` in
  // client.ts. Selecting a single-connection VFS and nothing else used to
  // throw on a pool size the caller never chose. Also revert a VFS's
  // maxPoolSize to null — db.poolSize is then 2, not its cap.
  it('defaults to the VFS cap rather than throwing when poolSize is omitted', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(await db.read('SELECT id FROM t')).toEqual([]);
    expect(db.poolSize).toBe(VFS_CAPABILITIES[TEST_TARGET.vfs].maxPoolSize);
  });

  it('accepts poolSize 1 and serves queries', async () => {
    const db = await createTestClient({ poolSize: 1 });

    await db.write('CREATE TABLE capped (id INTEGER, val TEXT)');
    await db.write("INSERT INTO capped VALUES (1, 'ok')");

    const rows = await db.read<{ id: number; val: string }>(
      'SELECT * FROM capped',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].val).toBe('ok');

    await db.close();
  });
});

/**
 * Every VFS this browser can run opens on its default build and serves a
 * round trip: the gate that keeps `pnpm test` honest about each loader in
 * the worker. Standalone, once per browser; a VFS added to VFS_CAPABILITIES
 * joins with no edit here.
 */
describe('every wired VFS', () => {
  // Falsifiable: delete any one loader from VFSConfigs in worker/worker.ts.
  it('opens on its default build and serves a round trip', {
    tags: ['standalone'],
  }, async () => {
    const runnable = (Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]).filter(
      (vfs) =>
        missingFeature(
          vfs,
          defaultBuildFor(vfs, AVAILABLE_FEATURES),
          AVAILABLE_FEATURES,
        ) === null,
    );
    await forEachCase(
      runnable,
      (vfs) => vfs,
      async (vfs) => {
        const db = await createTestClient(
          {},
          { vfs, build: defaultBuildFor(vfs, AVAILABLE_FEATURES) },
        );
        try {
          await db.write('CREATE TABLE wired (id INTEGER, val TEXT)');
          await db.write("INSERT INTO wired VALUES (1, 'ok')");
          const rows = await db.read<{ id: number; val: string }>(
            'SELECT * FROM wired',
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]?.val).toBe('ok');
        } finally {
          await db.close();
        }
      },
    );
  });
});

describe('vfs is required', {
  tags: ['standalone'],
}, () => {
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
