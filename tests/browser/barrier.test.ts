import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { BARRIER_SQL } from '../../src/epochs';
import { HAS_UNSAFE_HANDLES } from '../conformance/helpers';
import { createTestClient, removeDatabaseFiles } from './helpers';

/**
 * With the designation forbidden on index 0 at poolSize 2, the writer is
 * always w1, so which worker pays a barrier is deterministic.
 *
 * No test here can observe the barrier's absence: removing its statement
 * leaves every one of them green on every pair (spike 2026-09-25,
 * `mem:follow-ups`). The staleness it was built for came from the worker
 * reading column names before the first step(). The schema tests below guard
 * that capture; the count tests guard when the barrier is paid.
 */
const forced = {
  // Writer spread: needs two live workers, so a target that caps the pool
  // without readwrite-unsafe (spec 2026-09-13, §10) falls back to a pair
  // that keeps two, on every engine, or is skipped under the matrix (spec
  // 2026-09-15, A5, A7).
  needs: ['two-workers'] as const,
  poolSize: 2,
  __unsafeTestWriterPolicy: (i: number) => i !== 0,
};

const countBarrierStatements = (
  db: Awaited<ReturnType<typeof createTestClient>>,
): number =>
  (db.debug?.workers ?? [])
    .flatMap((worker) => worker.requests)
    .flatMap((request) => request.queries)
    .filter((query) => query.sql.includes(BARRIER_SQL)).length;

describe('commit-propagation barrier', () => {
  // Falsifiable: in src/worker/worker.ts, read `column_names(stmt)` before the
  // first step() — the statement cached before the rename reports old_col.
  it('sees a schema swap committed by another worker', async ({ skip }) => {
    const db = await createTestClient({ ...forced, skip });

    await db.write('CREATE TABLE t (old_col)');
    await db.write('INSERT INTO t (old_col) VALUES (42)');

    // Caches the statement the read below reuses, prepared on the old schema.
    await db.read('SELECT * FROM t');

    await db.transaction(async (tx) => {
      await tx.write('ALTER TABLE t RENAME COLUMN old_col TO new_col');
    });

    const rows = await db.read<{ new_col: number }>('SELECT * FROM t');
    expect(rows[0]?.new_col).toBe(42);
  });

  // Falsifiable: in src/worker/worker.ts, read `column_names(stmt)` before the
  // first step() — the statement cached before the swap reports old_col.
  it('sees a table dropped and replaced with a different shape', async ({
    skip,
  }) => {
    const db = await createTestClient({ ...forced, skip });

    await db.write('CREATE TABLE t (old_col)');
    await db.write('INSERT INTO t (old_col) VALUES (1)');
    await db.read('SELECT * FROM t');

    await db.transaction(async (tx) => {
      await tx.write('DROP TABLE t');
      await tx.write('CREATE TABLE t (new_col)');
      await tx.write('INSERT INTO t (new_col) VALUES (42)');
    });

    const rows = await db.read<{ new_col: number }>('SELECT * FROM t');
    expect(rows[0]?.new_col).toBe(42);
  });

  // Falsifiable: remove the `if (worker.seen >= target) return;` guard in
  // applyBarrier() — this is the test that explicitly pins conditionality.
  // The backpressure tests also go red as collateral (the extra barrier query
  // pushes their step-count limits), but only this one names the requirement.
  it('does not repeat the barrier on a worker that is already current', async ({
    skip,
  }) => {
    const db = await createTestClient({ ...forced, skip, debug: true });

    await db.write('CREATE TABLE t (a)');
    // Both reads go to w1, the last writer, which is current.
    await db.read('SELECT * FROM t');
    const before = countBarrierStatements(db);
    await db.read('SELECT * FROM t'); // must pay nothing
    expect(countBarrierStatements(db)).toBe(before);
  });

  // The point of lastWriterIndex, stated as a count rather than a duration: the
  // worker that just wrote has already seen the commit, so a read routed there
  // owes no barrier. `forced` keeps the writer off index 0, without which the
  // preference and the lowest-index scan would name the same worker.
  //
  // Falsifiable: delete the lastWriterIndex branch from takeAvailable() — the
  // read then lands on worker 0, whose epoch the INSERT left behind, and pays a
  // barrier.
  it('sends a read to the worker that just wrote, which owes no barrier', async ({
    skip,
  }) => {
    const db = await createTestClient({ ...forced, skip, debug: true });

    await db.write('CREATE TABLE t (a)');
    await db.read('SELECT * FROM t');
    const before = countBarrierStatements(db);

    await db.write('INSERT INTO t VALUES (1)');
    await db.read('SELECT * FROM t');

    expect(countBarrierStatements(db)).toBe(before);
  });
});

// One VFS: two clients must share one database; OPFSAdaptiveVFS shares it on
// every engine (see `secondClientOutcome`).
const sharedFile = { vfs: 'OPFSAdaptiveVFS' as const };

describe('barrier — two clients in one tab', () => {
  // Falsifiable: in src/worker/worker.ts, read `column_names(stmt)` before the
  // first step() — B's statement, cached before A's rename, reports old_col.
  it("client B observes client A's schema change", async () => {
    const dbName = `bsq-test-${crypto.randomUUID()}`;
    const a = createSQLiteClient(dbName, sharedFile);
    const b = createSQLiteClient(dbName, sharedFile);
    onTestFinished(async () => {
      try {
        await a.close();
      } catch {
        /* ignore */
      }
      try {
        await b.close();
      } catch {
        /* ignore */
      }
      try {
        await removeDatabaseFiles(dbName, sharedFile.vfs);
      } catch {
        /* ignore */
      }
    });

    await a.write('CREATE TABLE t (old_col)');
    await a.write('INSERT INTO t (old_col) VALUES (42)');
    await b.read('SELECT * FROM t'); // caches B's statement on the old schema
    await a.write('ALTER TABLE t RENAME COLUMN old_col TO new_col');

    const rows = await b.read<{ new_col: number }>('SELECT * FROM t');
    expect(rows[0]?.new_col).toBe(42);
  });

  // No falsifier in this library: making resolveDatabase skip
  // normalizeDatabaseFile leaves it green, the VFS resolving './' to the same
  // file on its own (spike 2026-09-25). The column-name mutation above turns
  // it red, as it does the test before.
  it('treats two spellings of one file as one database', async () => {
    // './bsq-test-<uuid>' normalizes to the same 45-char name as `dbName`
    // (URL resolves './' away), well under the 56-char wa-sqlite path bound
    // (SQLite checks nPathname + 8 > mxPathname = 64 before calling xOpen) —
    // folder included, since this VFS keeps one.
    const dbName = `bsq-test-${crypto.randomUUID()}`;
    const a = createSQLiteClient(dbName, sharedFile);
    const b = createSQLiteClient(`./${dbName}`, sharedFile);
    onTestFinished(async () => {
      try {
        await a.close();
      } catch {
        /* ignore */
      }
      try {
        await b.close();
      } catch {
        /* ignore */
      }
      try {
        await removeDatabaseFiles(dbName, sharedFile.vfs);
      } catch {
        /* ignore */
      }
    });

    await a.write('CREATE TABLE t (old_col)');
    await a.write('INSERT INTO t (old_col) VALUES (42)');
    await b.read('SELECT * FROM t'); // caches B's statement on the old schema
    await a.write('ALTER TABLE t RENAME COLUMN old_col TO new_col');

    const rows = await b.read<{ new_col: number }>('SELECT * FROM t');
    expect(rows[0]?.new_col).toBe(42);
  });
});

describe('catch-up pragma', () => {
  // One VFS: the subject is OPFSWriteAheadVFS's catchUpPragma. A barrier needs
  // a second worker, which this VFS has only with readwrite-unsafe.
  // Falsifiable: drop the closing `PRAGMA wal_read_latest=0` in barrierSqlFor —
  // the worker that paid the barrier then reads 1, and every later read on it
  // scans the write-ahead to its end.
  it('closes the pragma the barrier opens on OPFSWriteAheadVFS', async ({
    skip,
  }) => {
    if (!HAS_UNSAFE_HANDLES) return skip();
    const db = await createTestClient({
      vfs: 'OPFSWriteAheadVFS',
      poolSize: 2,
      __unsafeTestWriterPolicy: (i: number) => i !== 0,
      debug: true,
    });

    await db.write('CREATE TABLE t (a)');
    // Two at once, so one lands on worker 0, which the write left behind.
    const modes = await Promise.all([
      db.read<Record<string, string>>('PRAGMA wal_read_latest'),
      db.read<Record<string, string>>('PRAGMA wal_read_latest'),
    ]);

    expect(countBarrierStatements(db)).toBeGreaterThan(0);
    const barriers = (db.debug?.workers ?? [])
      .flatMap((worker) => worker.requests)
      .flatMap((request) => request.queries)
      .filter((query) => query.sql.includes(BARRIER_SQL));
    for (const barrier of barriers)
      expect(barrier.sql).toContain('PRAGMA wal_read_latest=1');
    expect(modes.map((rows) => Object.values(rows[0] ?? {})[0])).toEqual([
      '0',
      '0',
    ]);
  });
});
