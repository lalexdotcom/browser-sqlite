import { describe, expect, it } from '@rstest/core';
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

describe('commit-propagation barrier', () => {
  // Falsifiable: delete the `if (worker.seen < target)` block in
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
});
