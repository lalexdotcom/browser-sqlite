import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { BARRIER_SQL } from '../../src/epochs';
import { createTestClient } from './helpers';

/**
 * The failing configuration is forced, not waited for: with the designation
 * forbidden on index 0 at poolSize 2, the writer is always w1 and reads always
 * land on w0. Unforced, this configuration occurs ~3 runs in 10 and the test
 * would pin nothing. Control before the barrier: 8/8 stale.
 */
const forced = {
  vfs: 'OPFSAdaptiveVFS' as const,
  poolSize: 2,
  __unsafeTestWriterPolicy: (i: number) => i !== 0,
};

const countBarrierStatements = (
  db: Awaited<ReturnType<typeof createTestClient>>,
): number =>
  (db.debug?.workers ?? [])
    .flatMap((worker) => worker.requests)
    .flatMap((request) => request.queries)
    .filter((query) => query.sql === BARRIER_SQL).length;

describe('commit-propagation barrier', () => {
  // Falsifiable: delete the `worker.query(BARRIER_SQL, ...)` call in
  // applyBarrier() in src/client.ts and this goes red every run.
  it('sees a schema swap committed by another worker', async () => {
    const db = await createTestClient(forced);

    await db.write('CREATE TABLE t (old_col)');
    await db.write('INSERT INTO t (old_col) VALUES (42)');

    // Primes w0: any earlier read on the connection that later serves the
    // read is what freezes its cached page 1. output()'s sweep guarantees one.
    await db.read('SELECT * FROM t');

    await db.transaction(async (tx) => {
      await tx.write('ALTER TABLE t RENAME COLUMN old_col TO new_col');
    });

    const rows = await db.read<{ new_col: number }>('SELECT * FROM t');
    expect(rows[0]?.new_col).toBe(42);
  });

  // Falsifiable: delete the `worker.query(BARRIER_SQL, ...)` call in
  // applyBarrier() in src/client.ts and this goes red every run.
  it('sees a table dropped and replaced with a different shape', async () => {
    const db = await createTestClient(forced);

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
  it('does not repeat the barrier on a worker that is already current', async () => {
    const db = await createTestClient({ ...forced, debug: true });

    await db.write('CREATE TABLE t (a)');
    await db.read('SELECT * FROM t'); // w0 pays its barrier here
    const before = countBarrierStatements(db);
    await db.read('SELECT * FROM t'); // w0 is current — must pay nothing
    expect(countBarrierStatements(db)).toBe(before);
  });
});

describe('barrier — two clients in one tab', () => {
  // Falsifiable: replace the globalThis symbol registry in src/epochs.ts with
  // a per-client counter and this goes red.
  //
  // NOTE: the test uses DDL (column rename) — not a pure INSERT — because
  // SQLite refreshes data pages at the start of every read transaction (change
  // counter check) but caches the schema from page 1 across queries. Without
  // the barrier a primed worker's schema cache goes stale after a remote DDL
  // commit; a pure INSERT leaves the schema unchanged so no barrier is needed
  // to see it, making such a test vacuous.
  it("client B observes client A's schema change", async () => {
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
    const a = createSQLiteClient(dbName, forced);
    const b = createSQLiteClient(dbName, forced);
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
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(dbName, { recursive: true });
      } catch {
        /* ignore */
      }
    });

    await a.write('CREATE TABLE t (old_col)');
    await a.write('INSERT INTO t (old_col) VALUES (42)');
    await b.read('SELECT * FROM t'); // primes B's reading worker with old schema
    await a.write('ALTER TABLE t RENAME COLUMN old_col TO new_col');

    const rows = await b.read<{ new_col: number }>('SELECT * FROM t');
    expect(rows[0]?.new_col).toBe(42);
  });

  // Falsifiable: delete the normalizeDatabaseFile call at the entry of
  // createSQLiteClient and this goes red — the two clients key two counters
  // so B's barrier never fires and B reads the stale schema.
  it('treats two spellings of one file as one database', async () => {
    // Shorter prefix: './bsq-test-<uuid>' = 47 chars, safely under the
    // 56-char wa-sqlite path limit (FacadeVFS.jFullPathname copies raw name;
    // SQLite checks nPathname + 8 > mxPathname = 64 before calling xOpen).
    // './browser-sqlite-test-<uuid>' = 58 chars would crash the worker.
    const dbName = `bsq-test-${crypto.randomUUID()}`;
    const a = createSQLiteClient(dbName, forced);
    const b = createSQLiteClient(`./${dbName}`, forced);
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
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(dbName, { recursive: true });
      } catch {
        /* ignore */
      }
    });

    await a.write('CREATE TABLE t (old_col)');
    await a.write('INSERT INTO t (old_col) VALUES (42)');
    await b.read('SELECT * FROM t'); // primes B's reading worker with old schema
    await a.write('ALTER TABLE t RENAME COLUMN old_col TO new_col');

    const rows = await b.read<{ new_col: number }>('SELECT * FROM t');
    expect(rows[0]?.new_col).toBe(42);
  });
});
