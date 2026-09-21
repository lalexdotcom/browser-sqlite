import { describe, expect, it } from '@rstest/core';
import { createTestClient, longQuery } from './helpers';

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

  it('commits after the write issued in the same tick, never before it', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');

      await db.transaction(async (tx) => {
        // An explicit commit created alongside the write it is meant to
        // conclude. COMMIT is a statement on the same worker like any other.
        await Promise.all([
          tx.write('INSERT INTO t (n) VALUES (1)'),
          tx.commit(),
        ]);
      });

      expect(await db.read<{ n: number }>('SELECT n FROM t')).toEqual([
        { n: 1 },
      ]);
    } finally {
      await db.close();
    }
  });

  it('rejects a statement aborted while it waits its turn, and keeps the queue', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      const controller = new AbortController();

      const outcome = await db.transaction(async (tx) => {
        // First holds the connection; the other two are created behind it.
        const first = tx.read(longQuery(2_000_000));
        const queued = tx.read('SELECT 1 AS one', [], {
          signal: controller.signal,
        });
        const after = tx.read<{ two: number }>('SELECT 2 AS two');
        // The abort lands while `queued` is still waiting its turn, so the
        // statement never reaches the database. Falsifiable: pass `undefined`
        // instead of the statement's signal to the queue wait in
        // src/transaction.ts — `queued` then waits its turn and resolves.
        controller.abort(new Error('the caller changed its mind'));
        const settled = await Promise.allSettled([first, queued, after]);
        return settled.map((s) =>
          s.status === 'rejected'
            ? `rejected:${(s.reason as { code?: string; message?: string }).code ?? (s.reason as Error).message}`
            : s.status,
        );
      });

      // Rejected alone, with its OWN reason, and the queue goes on: the
      // statement behind it still runs. A place left early is handed on, not
      // cancelled — releasing it outright let `after` start while the FIRST
      // statement was still in flight, and it met the reuse guard.
      expect(outcome).toEqual([
        'fulfilled',
        'rejected:the caller changed its mind',
        'fulfilled',
      ]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("gives a queued statement the transaction's reason when the transaction aborts", async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      const controller = new AbortController();
      const reason = new Error('the whole transaction');
      let queuedError: unknown;

      await expect(
        db.transaction(
          async (tx) => {
            const first = tx.read(longQuery(2_000_000));
            const queued = tx.read('SELECT 1 AS one').catch((e: unknown) => {
              queuedError = e;
              throw e;
            });
            controller.abort(reason);
            await Promise.all([first, queued]);
          },
          { signal: controller.signal },
        ),
      ).rejects.toBe(reason);

      // Not a bare abort: the statement waiting its turn carries the cause.
      expect(queuedError).toBe(reason);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('runs two savepointed writes in issue order', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      // A write carrying its OWN signal takes the savepointed branch of
      // settled() (`opensSavepoint`), which has its own abort handling — so
      // the queue has to hold there too, not only on the plain path.
      const first = new AbortController();
      const second = new AbortController();

      await db.transaction(async (tx) => {
        await Promise.all([
          tx.write('INSERT INTO t (n) VALUES (1)', [], {
            signal: first.signal,
          }),
          tx.write('INSERT INTO t (n) VALUES (2)', [], {
            signal: second.signal,
          }),
        ]);
      });

      expect(
        await db.read<{ n: number }>('SELECT n FROM t ORDER BY n'),
      ).toEqual([{ n: 1 }, { n: 2 }]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('keeps the queue when a savepointed write is abandoned by its own signal', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      const controller = new AbortController();

      const outcome = await db.transaction(async (tx) => {
        // Abandoned mid-flight, the savepointed write resolves its caller at
        // once and runs on; the wait moves to `abandoned`, which the statement
        // behind it must still observe through the queue.
        const abandonedWrite = tx.write(
          `INSERT INTO t (n) SELECT 1 FROM (${longQuery(2_000_000)})`,
          [],
          { signal: controller.signal },
        );
        const behind = tx.read<{ c: number }>('SELECT COUNT(*) AS c FROM t');
        controller.abort(new Error('the write is abandoned'));
        const settled = await Promise.allSettled([abandonedWrite, behind]);
        return settled.map((s) => s.status);
      });

      expect(outcome[0]).toBe('rejected');
      // The statement behind it still ran: no guard, no eviction.
      expect(outcome[1]).toBe('fulfilled');
    } finally {
      await db.close();
    }
  }, 60_000);
});
