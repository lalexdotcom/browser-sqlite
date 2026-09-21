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

  it('runs a read issued while a for-await loop drains a generator', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write('INSERT INTO t (n) VALUES (1), (2), (3), (4)');

      const seen: number[] = [];
      const counted = await db.transaction(async (tx) => {
        // The loop is ACTIVELY pulling: this is not an abandoned generator,
        // it is a second statement created in the same tick as the first.
        const [, rows] = await Promise.all([
          (async () => {
            for await (const batch of tx.chunk<{ n: number }>(
              'SELECT n FROM t ORDER BY n',
              [],
              { chunkSize: 1 },
            )) {
              seen.push(...batch.map((r) => r.n));
            }
          })(),
          tx.read<{ c: number }>('SELECT COUNT(*) AS c FROM t'),
        ]);
        return rows;
      });

      expect(seen).toEqual([1, 2, 3, 4]);
      expect(counted).toEqual([{ c: 4 }]);
    } finally {
      await db.close();
    }
  });

  it('runs a bulkWrite close() issued in the same tick as a read', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write('INSERT INTO t (n) VALUES (1), (2)');

      const [affected, rows] = await db.transaction(async (tx) => {
        const bulk = tx.bulkWrite('t', ['n']);
        bulk.enqueue({ n: 3 });
        bulk.enqueue({ n: 4 });
        // close() posts the batch; the read is created in the same tick.
        return Promise.all([
          bulk.close(),
          tx.read<{ c: number }>('SELECT COUNT(*) AS c FROM t'),
        ]);
      });

      expect(affected).toBe(2);
      // Issue order: the batch was posted first, so the count sees it.
      expect(rows).toEqual([{ c: 4 }]);
    } finally {
      await db.close();
    }
  });
});
