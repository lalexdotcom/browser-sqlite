import { describe, expect, it } from '@rstest/core';
import type { SQLiteTransactionDB } from '../../src/api';
import { createTestClient } from './helpers';

type Debuggable = { debug: { workers: { creationTime: number }[] } };
const workerIdentity = (db: unknown) =>
  (db as Debuggable).debug.workers.map((w) => w.creationTime).join(',');

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/**
 * Transaction B on a `poolSize: 1` client — so on the worker the previous
 * transaction used — paused between its two statements while the test does
 * something with an older handle.
 */
const pausedTransaction = async (
  db: Awaited<ReturnType<typeof createTestClient>>,
) => {
  const inside = gate();
  const resume = gate();
  const done = db.transaction(async (tx) => {
    await tx.write("INSERT INTO t VALUES ('b1')");
    inside.open();
    await resume.promise;
    await tx.write("INSERT INTO t VALUES ('b2')");
  });
  done.catch(() => {});
  await inside.promise;
  return { resume: resume.open, done };
};

describe('a transaction handle used after its transaction ended (spec §1.2)', () => {
  // Falsifiable, all three: remove the `if (ending)` guards in transaction.ts's
  // rollback() and write(); B is destroyed or contaminated, as measured.
  it("an abandoned transaction's rollback() leaves the next transaction alone", async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    try {
      await db.write('CREATE TABLE t (a TEXT)');
      const before = workerIdentity(db);
      const ctl = new AbortController();
      const entered = gate();
      const late = gate();
      let kept!: SQLiteTransactionDB;
      const a = db.transaction(
        async (tx) => {
          kept = tx;
          await tx.write("INSERT INTO t VALUES ('a1')");
          entered.open();
          await late.promise;
        },
        { signal: ctl.signal },
      );
      a.catch(() => {});
      await entered.promise;
      ctl.abort(new Error('abandon A'));
      await expect(a).rejects.toThrow('abandon A');

      const b = await pausedTransaction(db);
      await expect(kept.rollback()).resolves.toBeUndefined();
      b.resume();
      await expect(b.done).resolves.toBeUndefined();
      late.open();

      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 'b1' },
        { a: 'b2' },
      ]);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  });

  it("a committed transaction's rollback() leaves the next transaction alone", async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    try {
      await db.write('CREATE TABLE t (a TEXT)');
      let kept!: SQLiteTransactionDB;
      await db.transaction(async (tx) => {
        kept = tx;
        await tx.write("INSERT INTO t VALUES ('a1')");
      });

      const b = await pausedTransaction(db);
      await expect(kept.rollback()).resolves.toBeUndefined();
      b.resume();
      await expect(b.done).resolves.toBeUndefined();

      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 'a1' },
        { a: 'b1' },
        { a: 'b2' },
      ]);
    } finally {
      await db.close();
    }
  });

  it("a committed transaction's write() is refused and lands nowhere", async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a TEXT)');
      let kept!: SQLiteTransactionDB;
      await db.transaction(async (tx) => {
        kept = tx;
        await tx.write("INSERT INTO t VALUES ('a1')");
      });

      const b = await pausedTransaction(db);
      const refused = await kept
        .write("INSERT INTO t VALUES ('late')")
        .catch((e) => e);
      b.resume();
      await expect(b.done).resolves.toBeUndefined();

      expect(refused).toMatchObject({ code: 'TRANSACTION_CLOSED' });
      expect((refused as Error).cause).toBeUndefined();
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 'a1' },
        { a: 'b1' },
        { a: 'b2' },
      ]);
    } finally {
      await db.close();
    }
  });
});

describe('a statement after an explicit end, inside the callback', () => {
  // Falsifiable: remove the `if (ending)` guard in transaction.ts's write();
  // the statement runs in autocommit on the leased worker and lands.
  it.each(['commit', 'rollback'] as const)(
    'is refused after tx.%s() under autoCommit: false',
    async (end) => {
      const db = await createTestClient({ poolSize: 1 });
      try {
        await db.write('CREATE TABLE t (a TEXT)');
        let refused: unknown;
        await db.transaction(
          async (tx) => {
            await tx.write("INSERT INTO t VALUES ('in')");
            await tx[end]();
            refused = await tx
              .write("INSERT INTO t VALUES ('after')")
              .catch((e) => e);
          },
          { autoCommit: false },
        );
        expect(refused).toMatchObject({ code: 'TRANSACTION_CLOSED' });
        const rows = await db.read('SELECT a FROM t ORDER BY a');
        expect(rows).toEqual(end === 'commit' ? [{ a: 'in' }] : []);
      } finally {
        await db.close();
      }
    },
  );
});
