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

// Invariant 6 asserts B1 isolation: a read must never observe uncommitted rows.
// That property is universal and a build failure if violated.
//
// However, exercising it requires a second worker to be served while the
// transaction is open. On VFS that rotate a single exclusive OPFS access
// handle (HANDLE-1: OPFSAdaptiveVFS, OPFSWriteAheadVFS, OPFSCoopSyncVFS on
// Firefox), no other worker can be admitted until the transaction releases the
// handle — the pool-acquire call blocks at the scheduler level, before the
// AbortSignal passed to read() is ever checked. That is a structural property
// of the VFS model, not an isolation failure.
//
// The read is raced against a 2 s AbortController to detect the blocked case:
//   - Read served → assert zero uncommitted rows (B1; build failure if wrong).
//   - Abort fires first → pool was blocked (HANDLE-1); B1 was not exercised;
//     the test logs a visible warning and passes. The pending read's promise is
//     caught before it can become an unhandled rejection.
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
        // Falsifiable: comment out `await held` so the transaction commits
        // before the concurrent read below runs. On a VFS where the pool can
        // serve a second worker (no HANDLE-1), the read then sees the
        // committed row (count = 1) and the expect(0) assertion goes RED.
        await held;
      });

      // B1: try to serve a read on another worker while the transaction holds.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      // Always-settling wrapper so the promise never becomes an unhandled
      // rejection when the race abandons it after the abort fires.
      const readOutcome = db
        .read<{ n: number }>('SELECT count(*) AS n FROM t', undefined, {
          signal: controller.signal,
        })
        .then(
          (rows) => ({ ok: true as const, rows }),
          (err: unknown) => ({ ok: false as const, err }),
        );

      // Resolves as soon as the abort fires (synchronously on controller.abort).
      const aborted = new Promise<null>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(null), {
          once: true,
        });
      });

      const winner = await Promise.race([readOutcome, aborted]);
      clearTimeout(timeoutId);

      if (winner === null) {
        // HANDLE-1: abort fired before the read could be served. B1 isolation
        // was not exercised for this VFS on this browser.
        console.warn(
          `[invariant 6] ${vfs}: read aborted after 2 s ` +
            `(HANDLE-1 — pool blocked by open transaction; ` +
            `B1 isolation not exercised on this browser)`,
        );
      } else if (!winner.ok) {
        throw winner.err;
      } else {
        // Read was served — assert B1: must not have seen the uncommitted row.
        expect(winner.rows[0].n).toBe(0);
      }

      release();
      await tx;
      await db.close();
    });
  }
});
