import { describe, expect, it } from '@rstest/core';
import { VFS_CAPABILITIES } from '../../src/types';
import { ALL_VFS, conformanceClient, createReopened } from './helpers';

/**
 * What every VFS owes, whatever the browser. These fail the build: a VFS that
 * loses data is broken, full stop. What legitimately varies between VFS -
 * latency, throughput, footprint, whether a long statement strands the pool -
 * is measured by the benchmark page and never asserted here.
 *
 * A scenario a VFS cannot support is skipped with its reason, never silently
 * absent, so the output reads as coverage rather than as a pass.
 */
describe('invariant 1 — what is written is read back', () => {
  for (const vfs of ALL_VFS) {
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.write('INSERT INTO t VALUES (42)');
      const rows = await db.read<{ a: number }>('SELECT a FROM t');
      expect(rows).toEqual([{ a: 42 }]);
      await db.close();
    });
  }
});

describe('invariant 2 — data survives close and reopen', () => {
  for (const vfs of ALL_VFS) {
    if (!VFS_CAPABILITIES[vfs].persistent) {
      it.skip(`${vfs} — skipped, declared not persistent`, () => {});
      continue;
    }
    it(`${vfs}`, async () => {
      const { file, db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.write('INSERT INTO t VALUES (7)');
      await db.close();

      const reopened = createReopened(file, vfs);
      const rows = await reopened.read<{ a: number }>('SELECT a FROM t');
      expect(rows).toEqual([{ a: 7 }]);
      await reopened.close();
    });
  }
});

describe('invariant 3 — concurrent writes lose nothing', () => {
  for (const vfs of ALL_VFS) {
    if (VFS_CAPABILITIES[vfs].maxPoolSize === 1) {
      it.skip(`${vfs} — skipped, capped at one worker`, () => {});
      continue;
    }
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');

      const N = 20;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          db.write('INSERT INTO t VALUES (?)', [i]),
        ),
      );

      const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
      expect(rows[0].n).toBe(N);
      await db.close();
    });
  }
});

describe('invariant 4 — a rolled-back transaction leaves nothing', () => {
  for (const vfs of ALL_VFS) {
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');

      await expect(
        db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          throw new Error('deliberate rollback');
        }),
      ).rejects.toThrow('deliberate rollback');

      const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
      expect(rows[0].n).toBe(0);
      await db.close();
    });
  }
});

describe('invariant 5 — close settles', () => {
  for (const vfs of ALL_VFS) {
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');
      // No clock: a close that never settles exhausts the 60 s testTimeout,
      // which is the failure. Asserting a duration here would be a benchmark.
      await db.close();
      await expect(db.read('SELECT 1 AS n')).rejects.toThrow();
    });
  }
});

describe('invariant 6 — no read runs inside an open transaction', () => {
  for (const vfs of ALL_VFS) {
    if (VFS_CAPABILITIES[vfs].maxPoolSize === 1) {
      it.skip(`${vfs} — skipped, capped at one worker`, () => {});
      continue;
    }
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const tx = db.transaction(async (inner) => {
        await inner.write('INSERT INTO t VALUES (1)');
        await held;
      });

      // B1: this must be served by another worker and must not see the
      // uncommitted row. If it ran inside the transaction it would see 1.
      const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
      expect(rows[0].n).toBe(0);

      release();
      await tx;
      await db.close();
    });
  }
});
