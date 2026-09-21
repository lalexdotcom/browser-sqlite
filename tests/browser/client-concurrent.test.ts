import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * Calls created in the SAME tick at the CLIENT level — `Promise.all`, which is
 * how a consumer of a concurrency library naturally writes two queries that do
 * not depend on each other.
 *
 * Until 2026-09-21 `concurrency.test.ts` was the only file doing this, and only
 * for `read()`: the other six surfaces had never been issued concurrently, and
 * neither had any of them inside a transaction (see `tx-concurrent.test.ts`,
 * which is where that gap turned out to be a defect).
 *
 * **Pinned at `poolSize: 1` on purpose.** With several workers the scheduler
 * spreads the calls and nothing is serialized; one worker is what forces every
 * surface through the same connection, which is where overlapping would show.
 *
 * **Characterization: every test here passed on arrival**, which is the result
 * — the client path was already sound, because a lease is held until the worker
 * is idle and only then returned. They guard that: a scheduler that handed out
 * a second lease for a busy worker would redden this file, and the transaction
 * surface has just shown what that class of defect looks like.
 */
const ONE_WORKER = { poolSize: 1 } as const;

describe('calls issued in the same tick on one worker', () => {
  it('runs two first() calls', async () => {
    const db = await createTestClient(ONE_WORKER);
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write('INSERT INTO t (n) VALUES (1), (2)');

      const [a, b] = await Promise.all([
        db.first<{ n: number }>('SELECT n FROM t WHERE n = 1'),
        db.first<{ n: number }>('SELECT n FROM t WHERE n = 2'),
      ]);

      expect(a).toEqual({ n: 1 });
      expect(b).toEqual({ n: 2 });
    } finally {
      await db.close();
    }
  }, 60_000);

  it('runs two writes and keeps both', async () => {
    const db = await createTestClient(ONE_WORKER);
    try {
      await db.write('CREATE TABLE t (n INTEGER)');

      await Promise.all([
        db.write('INSERT INTO t (n) VALUES (1)'),
        db.write('INSERT INTO t (n) VALUES (2)'),
      ]);

      expect(
        await db.read<{ n: number }>('SELECT n FROM t ORDER BY n'),
      ).toEqual([{ n: 1 }, { n: 2 }]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('drains two chunk() generators', async () => {
    const db = await createTestClient(ONE_WORKER);
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write('INSERT INTO t (n) VALUES (1), (2), (3), (4)');

      const drain = async (sql: string) => {
        const seen: number[] = [];
        for await (const batch of db.chunk<{ n: number }>(sql, [], {
          chunkSize: 1,
        })) {
          seen.push(...batch.map((r) => r.n));
        }
        return seen;
      };

      const [odd, even] = await Promise.all([
        drain('SELECT n FROM t WHERE n % 2 = 1 ORDER BY n'),
        drain('SELECT n FROM t WHERE n % 2 = 0 ORDER BY n'),
      ]);

      expect(odd).toEqual([1, 3]);
      expect(even).toEqual([2, 4]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('drains two stream() generators', async () => {
    const db = await createTestClient(ONE_WORKER);
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write('INSERT INTO t (n) VALUES (1), (2), (3), (4)');

      const drain = async (sql: string) => {
        const seen: number[] = [];
        for await (const row of db.stream<{ n: number }>(sql)) {
          seen.push(row.n);
        }
        return seen;
      };

      const [odd, even] = await Promise.all([
        drain('SELECT n FROM t WHERE n % 2 = 1 ORDER BY n'),
        drain('SELECT n FROM t WHERE n % 2 = 0 ORDER BY n'),
      ]);

      expect(odd).toEqual([1, 3]);
      expect(even).toEqual([2, 4]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('closes two bulkWrite buffers', async () => {
    const db = await createTestClient(ONE_WORKER);
    try {
      await db.write('CREATE TABLE a (n INTEGER)');
      await db.write('CREATE TABLE b (n INTEGER)');

      const one = db.bulkWrite('a', ['n']);
      const two = db.bulkWrite('b', ['n']);
      one.enqueue({ n: 1 });
      two.enqueue({ n: 2 });

      const [first, second] = await Promise.all([one.close(), two.close()]);

      expect(first).toBe(1);
      expect(second).toBe(1);
      expect(await db.read<{ n: number }>('SELECT n FROM a')).toEqual([
        { n: 1 },
      ]);
      expect(await db.read<{ n: number }>('SELECT n FROM b')).toEqual([
        { n: 2 },
      ]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('mixes a read with a transaction', async () => {
    const db = await createTestClient(ONE_WORKER);
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write('INSERT INTO t (n) VALUES (1)');

      const [rows] = await Promise.all([
        db.read<{ n: number }>('SELECT n FROM t'),
        db.transaction(async (tx) => {
          await tx.write('INSERT INTO t (n) VALUES (2)');
        }),
      ]);

      expect(rows).toEqual([{ n: 1 }]);
      expect(
        await db.read<{ n: number }>('SELECT n FROM t ORDER BY n'),
      ).toEqual([{ n: 1 }, { n: 2 }]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
