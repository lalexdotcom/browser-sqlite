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

  it('names the recommended VFS and the benchmark page', () => {
    let caught: unknown;
    try {
      // @ts-expect-error — see above.
      createSQLiteClient(`browser-sqlite-test-${crypto.randomUUID()}`, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SQLiteError);
    expect((caught as SQLiteError).code).toBe('INVALID_OPTION');
    expect((caught as SQLiteError).message).toContain('OPFSAdaptiveVFS');
    expect((caught as SQLiteError).message).toContain(
      'lalexdotcom.github.io/browser-sqlite',
    );
  });
});
