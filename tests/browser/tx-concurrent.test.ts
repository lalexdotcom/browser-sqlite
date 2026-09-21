import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * Statements created in the SAME tick inside one transaction.
 *
 * A transaction's statements all share one connection, so they must run one at
 * a time — that part is by design. What is NOT by design is refusing them: a
 * `Promise.all` over two reads is baseline usage, and until 2026-09-21 it lost
 * the whole transaction to `GENERATOR_ABANDONED`, an error named after a
 * generator the consumer never opened.
 *
 * The distinction these tests pin: issued concurrently, statements QUEUE in
 * issue order; they do not race and they do not fail.
 *
 * Falsifiable: remove the serial chain in `src/transaction.ts` — every test
 * here fails with `GENERATOR_ABANDONED` on whichever statement loses the race.
 */
describe('statements issued in the same tick inside a transaction', () => {
  it('runs two reads in issue order instead of refusing the second', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write('INSERT INTO t (n) VALUES (1), (2), (3)');

      const rows = await db.transaction(async (tx) => {
        const [a, b] = await Promise.all([
          tx.read<{ n: number }>('SELECT n FROM t WHERE n = 1'),
          tx.read<{ n: number }>('SELECT n FROM t WHERE n = 2'),
        ]);
        return [a, b];
      });

      expect(rows[0]).toEqual([{ n: 1 }]);
      expect(rows[1]).toEqual([{ n: 2 }]);
    } finally {
      await db.close();
    }
  });
});
