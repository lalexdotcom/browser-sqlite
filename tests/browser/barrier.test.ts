import { describe, expect, it } from '@rstest/core';
import { BARRIER_SQL } from '../../src/epochs';
import { createTestClient } from './helpers';

/**
 * The failing configuration is forced, not waited for: with the designation
 * forbidden on index 0 at poolSize 2, the writer is always w1 and reads always
 * land on w0. Unforced, this configuration occurs ~3 runs in 10 and the test
 * would pin nothing. Control before the barrier: 8/8 stale.
 */
const forced = {
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
  // applyBarrier() — the barrier still works, every other test stays green, and
  // only this one goes red. That guard is the entire difference between a
  // conditional barrier and a round-trip on every single query.
  it('does not repeat the barrier on a worker that is already current', async () => {
    const db = await createTestClient({ ...forced, debug: true });

    await db.write('CREATE TABLE t (a)');
    await db.read('SELECT * FROM t'); // w0 pays its barrier here
    const before = countBarrierStatements(db);
    await db.read('SELECT * FROM t'); // w0 is current — must pay nothing
    expect(countBarrierStatements(db)).toBe(before);
  });
});
