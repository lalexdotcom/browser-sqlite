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
 * One INSERT whose single step() runs for hundreds of milliseconds (Chromium)
 * to seconds (Firefox), so an abort at 30 ms lands inside it on a build that
 * can cut a running step. Copied from tests/browser/tx-abort.test.ts.
 */
const BIG_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000000) SELECT x FROM c';

const abortAfter = (ms: number, reason: unknown) => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(reason), ms);
  return ctl.signal;
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

describe('tx.signal', () => {
  // Falsifiable: expose `outer` instead of the merged signal; the death
  // controller never reaches it and this stays un-aborted.
  //
  // An in-flight abort whose rejection ESCAPES the callback (spec 2026-09-11,
  // case 2): a caught one no longer kills the transaction — see the next test.
  // createTestClient()'s default VFS, OPFSAdaptiveVFS, is on the async build.
  it('aborts with the write reason when an abandoned write escapes the callback', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.write('CREATE TABLE big (x INTEGER)');
      const reason = new Error('abandon the write');
      let seen!: AbortSignal;

      const outcome = await db
        .transaction(async (tx) => {
          seen = tx.signal;
          await tx.write(BIG_INSERT, [], { signal: abortAfter(30, reason) });
        })
        .catch((e) => e);

      expect(outcome).toBe(reason);
      expect(seen.aborted).toBe(true);
      expect(seen.reason).toBe(reason);
    } finally {
      await db.close();
    }
  }, 30_000);

  // Spec 2026-09-11, §3: a caught abandoned write leaves the transaction whole,
  // so transaction() resolves and tx.signal never fires. Falsifiable: call
  // die(e) inside `abandon` in src/transaction.ts — the transaction then dies
  // and tx.signal aborts.
  it('does not abort when the callback catches an abandoned write', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.write('CREATE TABLE big (x INTEGER)');
      const reason = new Error('abandon the write');
      let seen!: AbortSignal;

      await db.transaction(async (tx) => {
        seen = tx.signal;
        await tx
          .write(BIG_INSERT, [], { signal: abortAfter(30, reason) })
          .catch(() => {});
        await tx.write('INSERT INTO t VALUES (1)');
      });

      expect(seen.aborted).toBe(false);
      expect(await db.read('SELECT a FROM t')).toEqual([{ a: 1 }]);
      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([
        { n: 0 },
      ]);
    } finally {
      await db.close();
    }
  }, 30_000);

  // Falsifiable: remove `die(e)` from the catch in src/transaction.ts's
  // createTransaction — transaction() still rejects with `boom`, but
  // tx.signal stays un-aborted.
  it('aborts with the error the callback throws', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      const boom = new Error('boom');
      let seen!: AbortSignal;

      await expect(
        db.transaction(async (tx) => {
          seen = tx.signal;
          await tx.write('INSERT INTO t VALUES (1)');
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(seen.aborted).toBe(true);
      expect(seen.reason).toBe(boom);
      expect(await db.read('SELECT a FROM t')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('aborts with OPERATION_TIMEOUT when the transaction outlives its timeout', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      let seen!: AbortSignal;
      await expect(
        db.transaction(
          async (tx) => {
            seen = tx.signal;
            // Work that is not a statement, stopped by the signal it was handed.
            await new Promise<void>((resolve) =>
              tx.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
          },
          { timeout: 1000 },
        ),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      // The precondition: the callback ran before the deadline. If this fails, the deadline expired during lease + BEGIN.
      expect(seen).toBeDefined();
      expect(seen.aborted).toBe(true);
      expect(seen.reason).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    } finally {
      await db.close();
    }
  });

  // Falsifiable: drop `releaseDeath()` from transaction.ts's outer finally; the
  // later close() then aborts a signal whose transaction ended long ago. (Not
  // `releaseClose()`: with no transaction signal or timeout, mergeSignals
  // returns closeSignal itself and that release is a no-op.)
  it('is not aborted by a normal end, an explicit commit, or a later close()', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      let seen!: AbortSignal;
      let afterCommit: boolean | undefined;
      await db.transaction(
        async (tx) => {
          seen = tx.signal;
          await tx.write('INSERT INTO t VALUES (1)');
          await tx.commit();
          afterCommit = tx.signal.aborted;
        },
        { autoCommit: false },
      );
      expect(afterCommit).toBe(false);
      expect(seen.aborted).toBe(false);
      await db.close();
      expect(seen.aborted).toBe(false);
    } finally {
      await db.close();
    }
  });
});
