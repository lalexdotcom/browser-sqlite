import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * docs/superpowers/specs/2026-09-11-tx-savepoint-design.md: a statement the
 * callback catches has no effect, and the transaction goes on (R1-R4).
 */

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

type Debuggable = { debug: { workers: { creationTime: number }[] } };

/** The pool's workers by birth time: a change means one was evicted and respawned. */
const workerIdentity = (db: unknown) =>
  (db as Debuggable).debug.workers.map((w) => w.creationTime).join(',');

const setUp = async (options: {
  vfs: 'MemoryVFS' | 'OPFSAdaptiveVFS';
  build?: 'sync' | 'async';
}) => {
  const db = await createTestClient({ ...options, poolSize: 1, debug: true });
  await db.write('CREATE TABLE t (a INTEGER)');
  await db.write('CREATE TABLE big (x INTEGER)');
  await db.write('INSERT INTO t VALUES (0)');
  return db;
};

type Db = Awaited<ReturnType<typeof setUp>>;

const rowsOf = async (db: Db) =>
  (await db.read<{ a: number }>('SELECT a FROM t ORDER BY a')).map((r) => r.a);

/**
 * One INSERT whose single step() runs for hundreds of milliseconds (Chromium)
 * to seconds (Firefox), so an abort at 30 ms lands inside it.
 */
const BIG_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000000) SELECT x FROM c';

const abortAfter = (ms: number, reason: unknown) => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(reason), ms);
  return ctl.signal;
};

const bigCount = async (db: Db) =>
  (await db.read<{ n: number }>('SELECT count(*) AS n FROM big'))[0]?.n;

/** Milliseconds `fn` takes. */
const timed = async (fn: () => Promise<unknown>) => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
};

describe('an SQL error the callback catches (spec 2026-09-11 §1)', () => {
  // The first row of the spec's §1 table, which no test covered. Falsifiable:
  // in src/transaction.ts's `settled`, call die(e) in the catch for every
  // rejection — the caught violation then kills the transaction and
  // INSERT (2) never lands.
  it('lets the transaction go on and commit what preceded it (T11)', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      await db.write('CREATE UNIQUE INDEX t_a ON t (a)');
      let caught: unknown;
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        caught = await tx.write('INSERT INTO t VALUES (1)').catch((e) => e);
        await tx.write('INSERT INTO t VALUES (2)');
      });
      expect((caught as Error).message).toMatch(/UNIQUE/);
      expect(await rowsOf(db)).toEqual([0, 1, 2]);
    } finally {
      await db.close();
    }
  });

  // D6 of the 2026-09-10 spec, in a browser for the first time — only the fake
  // worker of tests/unit/transaction.test.ts pinned it. Falsifiable: remove the
  // dieIfConnectionLeft() call from `settled` — the SELECT then runs in
  // autocommit and `later` holds its rows.
  it('dies when ON CONFLICT ROLLBACK takes the transaction with it (T10)', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      await db.write('CREATE UNIQUE INDEX t_a ON t (a)');
      const before = workerIdentity(db);
      let caught: unknown;
      let later: unknown;
      const finished = deferred();
      const outcome = await db
        .transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          caught = await tx
            .write('INSERT OR ROLLBACK INTO t VALUES (1)')
            .catch((e) => e);
          later = await tx.read('SELECT a FROM t').catch((e) => e);
          finished.resolve();
        })
        .catch((e) => e);
      await finished.promise;

      expect(outcome).toBe(caught);
      expect(later).toMatchObject({ code: 'TRANSACTION_CLOSED' });
      expect((later as Error).cause).toBe(caught);
      expect(await rowsOf(db)).toEqual([0]);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  });
});

/** A 3 000 000-row insert: long enough on Chromium for a timing bound to discriminate. */
const HUGE_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3000000) SELECT x FROM c';

describe('a write the callback abandons by its own signal (spec 2026-09-11, R1-R3)', () => {
  for (const vfs of ['OPFSAdaptiveVFS', 'MemoryVFS'] as const) {
    // Falsifiable: in `settled`, `await worker.quiesce()` before rethrowing the
    // own abort — the rejection then arrives when the write ends, and the next
    // statement waits for nothing.
    it(`rejects at the deadline, and the next statement pays for the rest (T2, ${vfs})`, async () => {
      const db = await setUp({ vfs });
      try {
        let rejectedAfter = 0;
        let nextWaited = 0;
        await db.transaction(async (tx) => {
          const t0 = performance.now();
          await tx.write(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
          const t1 = performance.now();
          await tx.write('INSERT INTO t VALUES (1)');
          rejectedAfter = t1 - t0;
          nextWaited = performance.now() - t1;
        });
        expect(nextWaited).toBeGreaterThan(rejectedAfter);
        expect(await bigCount(db)).toBe(0);
        expect(await rowsOf(db)).toEqual([0, 1]);
      } finally {
        await db.close();
      }
    }, 60_000);

    // Falsifiable: in `entryWait`, await `abandoned` without the race — the
    // waiting write then lands, and its row 9 is committed.
    it(`rejects a statement that times out behind an abandoned write, alone (T5, ${vfs})`, async () => {
      const db = await setUp({ vfs });
      try {
        let second: unknown;
        await db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          await tx.write(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
          second = await tx
            .write('INSERT INTO t VALUES (9)', [], { timeout: 20 })
            .catch((e) => e);
          await tx.write('INSERT INTO t VALUES (2)');
        });
        expect(second).toMatchObject({
          code: 'OPERATION_TIMEOUT',
          timeout: 20,
        });
        expect(await rowsOf(db)).toEqual([0, 1, 2]);
        expect(await bigCount(db)).toBe(0);
      } finally {
        await db.close();
      }
    }, 60_000);

    // Falsifiable: make commitNow() send its COMMIT with `exec(worker, …)`
    // instead of `via(false)` — the COMMIT then carries no undo and the
    // million rows are committed.
    it(`commits only what preceded a caught abandoned write when the callback returns at once (T6, ${vfs})`, async () => {
      const db = await setUp({ vfs });
      try {
        await db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          await tx.write(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
        });
        expect(await rowsOf(db)).toEqual([0, 1]);
        expect(await bigCount(db)).toBe(0);
      } finally {
        await db.close();
      }
    }, 60_000);
  }

  // On a build that can cut a step: the rejection escapes, the transaction
  // dies, and the background write is cut rather than awaited. Falsifiable:
  // start the savepointed write with `{ ...given, signal: undefined }` in
  // `settled` — the death then cannot cut it and transaction() waits for the
  // whole write.
  it('cuts the write, keeps nothing, and aborts tx.signal when the rejection escapes (T3)', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      const natural = await timed(() => db.write(HUGE_INSERT));
      await db.write('DELETE FROM big');
      const before = workerIdentity(db);
      const reason = new Error('abandon the write');
      let seen!: AbortSignal;
      const took = await timed(() =>
        expect(
          db.transaction(async (tx) => {
            seen = tx.signal;
            await tx.write('INSERT INTO t VALUES (1)');
            await tx.write(HUGE_INSERT, [], {
              signal: abortAfter(30, reason),
            });
          }),
        ).rejects.toBe(reason),
      );
      expect(took).toBeLessThan(natural / 2);
      expect(seen.aborted).toBe(true);
      expect(seen.reason).toBe(reason);
      expect(await rowsOf(db)).toEqual([0]);
      expect(await bigCount(db)).toBe(0);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  }, 120_000);

  // Falsifiable: as T3.
  it("cuts an abandoned write when the transaction's own timeout expires (T4)", async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      const natural = await timed(() => db.write(HUGE_INSERT));
      await db.write('DELETE FROM big');
      let outcome: unknown;
      const took = await timed(async () => {
        outcome = await db
          .transaction(
            async (tx) => {
              await tx.write('INSERT INTO t VALUES (1)');
              await tx.write(HUGE_INSERT, [], { timeout: 30 }).catch(() => {});
              await tx.write('INSERT INTO t VALUES (2)');
            },
            { timeout: 150 },
          )
          .catch((e) => e);
      });
      expect(outcome).toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 150,
      });
      expect(took).toBeLessThan(natural / 2);
      expect(await rowsOf(db)).toEqual([0]);
      expect(await bigCount(db)).toBe(0);
    } finally {
      await db.close();
    }
  }, 120_000);
});

describe('a write issued through a generator (spec 2026-09-11, §4)', () => {
  for (const vfs of ['OPFSAdaptiveVFS', 'MemoryVFS'] as const) {
    // Falsifiable: in `releasing`, drop the abandon(…) call — the write is
    // then closed like any generator: cut where a step can be cut (the
    // transaction dies), committed where it cannot.
    it(`undoes a caught write issued through tx.chunk(), and goes on (${vfs})`, async () => {
      const db = await setUp({ vfs });
      try {
        let caught: unknown;
        await db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          caught = await (async () => {
            for await (const _rows of tx.chunk(
              `${BIG_INSERT} RETURNING x`,
              [],
              {
                timeout: 30,
              },
            )) {
              // The first chunk comes only after the whole DML.
            }
          })().catch((e) => e);
          await tx.write('INSERT INTO t VALUES (2)');
        });
        expect(caught).toMatchObject({ code: 'OPERATION_TIMEOUT' });
        expect(await rowsOf(db)).toEqual([0, 1, 2]);
        expect(await bigCount(db)).toBe(0);
      } finally {
        await db.close();
      }
    }, 60_000);
  }
});
