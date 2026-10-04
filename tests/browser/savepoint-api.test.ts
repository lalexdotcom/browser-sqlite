import { describe, expect, it } from '@rstest/core';
import type { SQLiteSavepoint } from '../../src/api';
import { createTestClient } from './helpers';

/**
 * docs/superpowers/specs/2026-10-04-tx-savepoint-design.md: tx.savepoint()
 * against a real connection, on whatever (vfs, build) the run targets.
 */

const setUp = async () => {
  const db = await createTestClient({ poolSize: 1 });
  await db.write('CREATE TABLE t (a INTEGER UNIQUE)');
  return db;
};

type Db = Awaited<ReturnType<typeof setUp>>;

const rowsOf = async (db: Db) =>
  (await db.read<{ a: number }>('SELECT a FROM t ORDER BY a')).map((r) => r.a);

/** One INSERT whose single step() runs long enough for a 30 ms timeout to land inside it. */
const BIG_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000000) SELECT x FROM c';

describe('tx.savepoint() (spec 2026-10-04)', () => {
  // Falsifiable: in src/savepoints.ts rollback(), close only the rolled-back
  // entry, not those above it — the child stays open and its release() resolves.
  it('rolls a parent back with everything nested in it (B1)', async () => {
    const db = await setUp();
    try {
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        const parent = await tx.savepoint();
        await tx.write('INSERT INTO t VALUES (2)');
        const child = await tx.savepoint();
        await tx.write('INSERT INTO t VALUES (3)');
        await parent.rollback();
        await tx.write('INSERT INTO t VALUES (4)');
        await expect(child.release()).rejects.toMatchObject({
          code: 'SAVEPOINT_CLOSED',
        });
      });
      expect(await rowsOf(db)).toEqual([1, 4]);
    } finally {
      await db.close();
    }
  });

  // Falsifiable: ignore `release` in the handle's rollback() — the second
  // rollback becomes a no-op and the final release() rejects.
  it('keeps the savepoint open after rollback({ release: false }) (B2)', async () => {
    const db = await setUp();
    try {
      await db.transaction(async (tx) => {
        const sp = await tx.savepoint('retry');
        await tx.write('INSERT INTO t VALUES (1)');
        await sp.rollback({ release: false });
        await tx.write('INSERT INTO t VALUES (2)');
        await sp.rollback({ release: false });
        await tx.write('INSERT INTO t VALUES (3)');
        await sp.release();
      });
      expect(await rowsOf(db)).toEqual([3]);
    } finally {
      await db.close();
    }
  });

  it('keeps the items whose savepoint was released and none of the others (B3)', async () => {
    const db = await setUp();
    try {
      await db.write('INSERT INTO t VALUES (20)');
      await db.transaction(async (tx) => {
        for (const a of [1, 2, 3]) {
          const sp = await tx.savepoint();
          try {
            await tx.write('INSERT INTO t VALUES (?)', [a]);
            await tx.write('INSERT INTO t VALUES (?)', [a * 10]);
            await sp.release();
          } catch {
            await sp.rollback();
          }
        }
      });
      // Item 2's second row collides with 20, so its first row goes too.
      expect(await rowsOf(db)).toEqual([1, 3, 10, 20, 30]);
    } finally {
      await db.close();
    }
  });

  // Falsifiable: send the consumer's ROLLBACK TO before the pending __bsq_sp
  // conclusion — it pops __bsq_sp, the conclusion fails and the transaction dies.
  it('rolls back right after a caught abandoned write (B4, E15)', async () => {
    const db = await setUp();
    try {
      await db.write('CREATE TABLE big (x INTEGER)');
      await db.transaction(async (tx) => {
        const sp = await tx.savepoint('u');
        await tx.write('INSERT INTO t VALUES (1)');
        await tx.write(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
        await sp.rollback();
        await tx.write('INSERT INTO t VALUES (3)');
      });
      expect(await rowsOf(db)).toEqual([3]);
      expect(
        (await db.read<{ n: number }>('SELECT count(*) AS n FROM big'))[0]?.n,
      ).toBe(0);
    } finally {
      await db.close();
    }
  }, 60_000);

  // Falsifiable: drop the `if (ending)` check from the handle's release() —
  // a RELEASE reaches a connection that left its transaction and fails with
  // "no such savepoint" instead.
  it('closes every handle when the connection leaves the transaction (B5, E16)', async () => {
    const db = await setUp();
    try {
      await db.write('INSERT INTO t VALUES (1)');
      let inner: Promise<unknown> | undefined;
      let releaseError: unknown;
      const outcome = await db
        .transaction((tx) => {
          inner = (async () => {
            const sp = await tx.savepoint();
            await tx
              .write('INSERT OR ROLLBACK INTO t VALUES (1)')
              .catch(() => {});
            releaseError = await sp.release().catch((e) => e);
          })();
          return inner;
        })
        .catch((e) => e);
      await inner?.catch(() => {});
      expect(outcome).toBeInstanceOf(Error);
      expect(releaseError).toMatchObject({ code: 'TRANSACTION_CLOSED' });
      expect(await rowsOf(db)).toEqual([1]);
    } finally {
      await db.close();
    }
  });

  // E19, the supported shape: a load closed inside its savepoint is undone
  // with it. Falsifiable: send `RELEASE` for rollback() in src/transaction.ts.
  it('undoes an output() closed inside the savepoint it rolls back (B6)', async () => {
    const db = await setUp();
    try {
      await db.write('CREATE TABLE report (id INTEGER)');
      await db.write('INSERT INTO report VALUES (1)');
      await db.transaction(async (tx) => {
        const sp = await tx.savepoint();
        const out = tx.output('report', { id: 'INTEGER' });
        out.enqueue({ id: 2 });
        await out.close();
        await sp.rollback();
      });
      expect(await db.read('SELECT id FROM report')).toEqual([{ id: 1 }]);
      expect(
        await db.read(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__bsq_staging_%'",
        ),
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });

  // Review Focus 1. Falsifiable: interpolate the name without quoteIdent().
  it('accepts names with quotes, spaces and non-ASCII (B8)', async () => {
    const db = await setUp();
    try {
      const names: string[] = [];
      await db.transaction(async (tx) => {
        for (const name of ['a"b', 'my point', 'étape']) {
          const sp: SQLiteSavepoint = await tx.savepoint(name);
          await tx.write('INSERT INTO t VALUES (?)', [names.length]);
          await sp.rollback();
          names.push(sp.name);
        }
      });
      expect(names).toEqual(['a"b', 'my point', 'étape']);
      expect(await rowsOf(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
