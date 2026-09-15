import { describe, expect, it } from '@rstest/core';
import { createTestClient, longQuery } from './helpers';

describe('query timeout', () => {
  it('rejects with OPERATION_TIMEOUT and leaves the client usable', async () => {
    // `async`, not MemoryVFS's default `sync`: without cross-origin isolation the
    // sync build cannot cut a running statement, so the next read would wait out
    // the whole query — 4 s on Chromium, 22 s on Firefox, past this test's 30 s on
    // a CI runner (mem:measurements, CI-QUERY-TIMEOUT).
    const db = await createTestClient({
      vfs: 'MemoryVFS',
      build: 'async',
      poolSize: 1,
    });
    try {
      const slow = longQuery(20_000_000);
      // A fresh client's first call can time out while it waits for the worker
      // to start, and then no statement ever runs. Start the worker, then warm
      // the statement, so the timeout below lands inside step() (mem:lessons,
      // 2026-09-05).
      await db.read('SELECT 1');
      await db.read(slow, [], { timeout: 50 }).catch(() => {});
      const started = performance.now();
      await expect(db.read(slow, [], { timeout: 200 })).rejects.toMatchObject({
        code: 'OPERATION_TIMEOUT',
      });
      // The rejection is immediate by contract, whether the statement stopped or
      // not; this bounds only the contract.
      expect(performance.now() - started).toBeLessThan(1500);
      // What proves the statement stopped: the next read does not wait it out.
      // Falsifiable: create this client on the `sync` build — the read then
      // waits for the query's natural end, seconds on either engine.
      const next = performance.now();
      expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      expect(performance.now() - next).toBeLessThan(2000);
    } finally {
      await db.close();
    }
  });

  it('spends the budget over the whole call, not per statement', async () => {
    // `async`, so the write is really cut and close() does not wait it out on
    // Firefox (mem:measurements, CI-QUERY-TIMEOUT).
    const db = await createTestClient({
      vfs: 'MemoryVFS',
      build: 'async',
      poolSize: 1,
    });
    try {
      await db.read('SELECT 1');
      // Two statements, each shorter than the budget, whose sum is not.
      const half = `${longQuery(8_000_000)};`;
      await expect(
        db.write(`${half} ${half}`, [], { timeout: 400 }),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    } finally {
      await db.close();
    }
  });

  it('charges the consumer for its own slowness', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (x INTEGER)');
      await db.write(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1001) ` +
          `INSERT INTO t SELECT x FROM c`,
      );
      // The budget is wall clock from the call, so the consumer's own pauses
      // spend it. Falsifier: count the budget inside step() again and the
      // 100 ms is never reached, because MemoryVFS steps 1001 rows in
      // microseconds — the sleeping is the only thing that can exceed it.
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

  it('lets the caller signal win, with its own reason', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      const controller = new AbortController();
      const mine = new Error('mine');
      // Both are live and the caller's fires first. This pins D3 against a
      // future edit that "unifies" the two errors. Falsifier: make withDeadline
      // return its own controller's signal instead of the merged one and the
      // rejection becomes OPERATION_TIMEOUT, or never arrives at all.
      const promise = db.read(longQuery(20_000_000), [], {
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

  it('spends the budget while the call is still queued', async () => {
    // `async`, and a holder that carries a signal. A statement yields only when
    // it is abortable, so an unsignalled holder keeps its worker to its natural
    // end even on `async`, and close() waits it out — 31.6 s on Firefox, 22 s on
    // the `sync` build, past this test's 30 s (mem:measurements,
    // CI-QUERY-TIMEOUT). It is abandoned at the end, as in concurrency.test.ts.
    const db = await createTestClient({
      vfs: 'MemoryVFS',
      build: 'async',
      poolSize: 1,
    });
    try {
      // The worker must be up, so the long read below occupies it rather than
      // waiting for it to start alongside the call under test.
      await db.read('SELECT 1');
      // The only worker is busy for seconds; the second call never reaches a
      // step() and must still time out. Falsifier: create the controller below
      // the lease acquisition and this goes green for the wrong reason — the
      // clock must run during the wait, which is what the assertion pins.
      const holder = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: holder.signal,
      });
      long.catch(() => {});
      try {
        const started = performance.now();
        await expect(
          db.read('SELECT 1 AS one', [], { timeout: 150 }),
        ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
        expect(performance.now() - started).toBeLessThan(1000);
      } finally {
        holder.abort();
      }
    } finally {
      await db.close();
    }
  });

  it('bounds a transaction, including the callback between its statements', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      // The callback runs no long statement: it sleeps. Only a wall-clock
      // deadline can end this, which is what the test pins. Falsifier: remove
      // the withDeadline composition in transaction.ts and the promise
      // resolves after the sleep instead of rejecting.
      await expect(
        db.transaction(
          async (tx) => {
            await tx.write('INSERT INTO t VALUES (1)');
            await new Promise((r) => setTimeout(r, 600));
            await tx.write('INSERT INTO t VALUES (2)');
          },
          { timeout: 200 },
        ),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 200 });
      // It rolled back: neither row survived.
      expect(await db.read('SELECT a FROM t')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('bounds a bulkWrite from the call, not from close()', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
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

  it('bounds an output() the same way, leaving the target untouched', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE dest (a INTEGER)');
      await db.write('INSERT INTO dest VALUES (42)');
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
      expect(await db.read('SELECT a FROM dest')).toEqual([{ a: 42 }]);
    } finally {
      await db.close();
    }
  });
});
