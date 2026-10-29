import { describe, expect, it } from 'vitest';
import { createTestClient, longQuery } from '../helpers';

describe('query timeout', () => {
  it('rejects with OPERATION_TIMEOUT and leaves the client usable', {
    tags: ['requires:interruptible'],
  }, async () => {
    // Needs interruptible: without it the next read would wait out the whole
    // query — 4 s on Chromium, 22 s on Firefox, past this test's 30 s on a CI
    // runner (mem:measurements, CI-QUERY-TIMEOUT).
    const db = await createTestClient({ poolSize: 1, debug: true });
    try {
      // Run to its end, minutes on either engine: past this test's timeout,
      // which is the bound when the statement is not stopped.
      const slow = longQuery(2_000_000_000);
      // A fresh client's first call can time out while it waits for the worker
      // to start, and then no statement ever runs. Start the worker, then warm
      // the statement, so the timeout below lands inside step() (mem:lessons,
      // 2026-09-05).
      await db.all('SELECT 1');
      await db.all(slow, [], { timeout: 50 }).catch(() => {});
      await expect(db.all(slow, [], { timeout: 200 })).rejects.toMatchObject({
        code: 'OPERATION_TIMEOUT',
      });
      // Immediate by contract, whether the statement stopped or not: rejected
      // before the worker has answered, which only a later message can report.
      expect(db.debug?.workers[0]?.status).not.toBe('READY');
      // What proves the statement stopped: the next read does not wait it out.
      // Falsifiable: create this client on the `sync` build — the read then
      // waits for the query's natural end, past the test's timeout.
      expect(await db.all('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('charges the consumer for its own slowness', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.run('CREATE TABLE t (x INTEGER)');
      await db.run(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1001) ` +
          `INSERT INTO t SELECT x FROM c`,
      );
      // The budget is wall clock from the call, so the consumer's own pauses
      // spend it. Falsifier: count the budget inside step() again and the
      // 100 ms is never reached, because stepping 1001 rows takes well under a
      // millisecond on any target — the sleeping is the only thing that can
      // exceed it.
      const iterate = async () => {
        for await (const rows of db.chunk<{ x: number }>(
          'SELECT x FROM t',
          [],
          {
            timeout: 100,
          },
        )) {
          void rows;
          await new Promise((r) => setTimeout(r, 150));
        }
      };
      await expect(iterate()).rejects.toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 100,
      });
    } finally {
      await db.close();
    }
  });

  it('lets the caller signal win, with its own reason', {
    tags: ['requires:interruptible'],
  }, async () => {
    // Needs interruptible: the abandoned long query must not keep close()
    // waiting for its natural length after the signal wins.
    const db = await createTestClient({ poolSize: 1 });
    try {
      const controller = new AbortController();
      const mine = new Error('mine');
      // Both are live and the caller's fires first. This pins D3 against a
      // future edit that "unifies" the two errors. Falsifier: make withDeadline
      // return its own controller's signal instead of the merged one and the
      // rejection becomes OPERATION_TIMEOUT, or never arrives at all.
      const promise = db.all(longQuery(20_000_000), [], {
        signal: controller.signal,
        timeout: 30_000,
      });
      promise.catch(() => {});
      controller.abort(mine);
      await expect(promise).rejects.toBe(mine);
    } finally {
      await db.close();
    }
  });

  it('spends the budget while the call is still queued', {
    tags: ['requires:interruptible'],
  }, async () => {
    // Needs interruptible: on a build that cannot stop a statement, the holder
    // keeps its worker to its natural end, and close() waits it out — 31.6 s on
    // Firefox, 22 s on the `sync` build, past this test's 30 s
    // (mem:measurements, CI-QUERY-TIMEOUT). It is abandoned at the end, as in
    // concurrency.test.ts.
    const db = await createTestClient({ poolSize: 1 });
    try {
      // The worker must be up, so the long read below occupies it rather than
      // waiting for it to start alongside the call under test.
      await db.all('SELECT 1');
      // The only worker is busy for seconds; the second call never reaches a
      // step() and must still time out. Falsifier: create the controller below
      // the lease acquisition and this goes green for the wrong reason — the
      // clock must run during the wait, which is what the assertion pins.
      const holder = new AbortController();
      let longSettled = false;
      const long = db.all(longQuery(20_000_000), [], {
        signal: holder.signal,
      });
      long.then(
        () => {
          longSettled = true;
        },
        () => {
          longSettled = true;
        },
      );
      try {
        await expect(
          db.all('SELECT 1 AS one', [], { timeout: 150 }),
        ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
        // While the holder still runs: the timeout fired during the wait, not
        // once the worker came free.
        expect(longSettled).toBe(false);
      } finally {
        holder.abort();
      }
    } finally {
      await db.close();
    }
  });

  it('bounds a transaction, including the callback between its statements', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.run('CREATE TABLE t (a INTEGER)');
      // The callback runs no long statement: it sleeps. Only a wall-clock
      // deadline can end this, which is what the test pins. Falsifier: remove
      // the withDeadline composition in transaction.ts and the promise
      // resolves after the sleep instead of rejecting.
      await expect(
        db.transaction(
          async (tx) => {
            await tx.run('INSERT INTO t VALUES (1)');
            await new Promise((r) => setTimeout(r, 600));
            await tx.run('INSERT INTO t VALUES (2)');
          },
          { timeout: 200 },
        ),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 200 });
      // It rolled back: neither row survived.
      expect(await db.all('SELECT a FROM t')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('bounds a bulkWrite from the call, not from close()', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.run('CREATE TABLE t (a INTEGER)');
      const { enqueue, close } = db.bulkWrite('t', ['a'], { timeout: 200 });
      await enqueue({ a: 1 });
      // The producer is slow, which is the whole case: nothing is executing in
      // SQLite while it sleeps. Falsifier: remove the withDeadline composition
      // in bulk.ts and close() resolves.
      await new Promise((r) => setTimeout(r, 600));
      await expect(close()).rejects.toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 200,
      });
    } finally {
      await db.close();
    }
  });

  // The budget a caller gives is counted from the call, like every other
  // method's, not from the first next(). Falsifier: start withDeadline inside
  // chunkRows in src/client.ts, as before — both first next() calls resolve.
  it('bounds a stream() and a chunk() from the call, not from the first next()', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.all('SELECT 1');
      const rows = db.stream('SELECT 1 AS one', [], { timeout: 200 });
      const chunks = db.chunk('SELECT 1 AS one', [], { timeout: 200 });
      await new Promise((r) => setTimeout(r, 600));
      await expect(rows.next()).rejects.toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 200,
      });
      await expect(chunks.next()).rejects.toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 200,
      });
      expect(await db.all('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('bounds an output() the same way, leaving the target untouched', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.run('CREATE TABLE dest (a INTEGER)');
      await db.run('INSERT INTO dest VALUES (42)');
      const { enqueue, close } = db.output(
        'dest',
        { a: 'INTEGER' },
        { timeout: 200 },
      );
      await enqueue({ a: 99 });
      await new Promise((r) => setTimeout(r, 600));
      await expect(close()).rejects.toMatchObject({
        code: 'OPERATION_TIMEOUT',
      });
      // An aborted output() is observationally a no-op: the previous target
      // stays intact and fully populated.
      expect(await db.all('SELECT a FROM dest')).toEqual([{ a: 42 }]);
    } finally {
      await db.close();
    }
  });
});
