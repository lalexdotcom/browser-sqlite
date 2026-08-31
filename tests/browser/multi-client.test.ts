import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { SQLiteBulkWriteError, SQLiteError } from '../../src/errors';
import { HAS_UNSAFE_HANDLES } from '../conformance/helpers';

/**
 * What two clients writing at once actually do — on both regimes.
 *
 * Nothing here mentions tabs and everything here is about them: Web Locks and
 * OPFS access handles are both origin-wide, so two clients in this one page
 * contend exactly as two tabs would. That is what lets the Known Limitations
 * entry these tests back speak about tabs while being exercised in one.
 *
 * **The engine is never named.** What splits the behaviour is
 * `readwrite-unsafe`: with it, a VFS holds one access handle per connection and
 * the conflict reaches SQLite's Web Locks, which this library asks for with
 * `ifAvailable: true` — so the loser is turned away at once. Without it, the VFS
 * rotates ONE exclusive handle and the loser blocks in the scheduler before Web
 * Locks is ever consulted. Same limitation, two shapes, and a consumer meets
 * whichever their user's browser gives them.
 *
 * Every wait here is BOUNDED, and that is not decoration: the first version of
 * this file awaited B inside A's transaction callback, so on any engine where B
 * waits the two deadlocked — the test presupposed the fail-fast behaviour it
 * was written to observe.
 */
const twoClients = () => {
  const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
  const options = { vfs: 'OPFSAdaptiveVFS' as const, poolSize: 2 };
  const a = createSQLiteClient(dbName, options);
  const b = createSQLiteClient(dbName, options);
  onTestFinished(async () => {
    for (const client of [a, b]) {
      try {
        await client.close();
      } catch {
        /* a failed client has nothing to close */
      }
    }
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dbName, { recursive: true });
    } catch {
      /* the entry may not exist if the test failed before creation */
    }
  });
  return { a, b };
};

/** Resolves to the rejection, or `undefined` when the promise resolved. */
const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error) => error,
  );

/** How long a turned-away writer gets before we call it "waiting". */
const TURNED_AWAY_WITHIN = 1500;

/** True when `promise` settled inside `ms`; false when it is still running. */
const settledWithin = (
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

describe('two clients writing at once', () => {
  // Falsifiable on either regime: give both clients
  // `pragmas: { busy_timeout: '5000' }`. Where the writer is turned away it
  // then WAITS instead — measured 5111 ms — and `settled` goes false. The
  // rejection survives that change, so the elapsed budget is what catches a
  // busy handler, never the error type. `busy_timeout` is on the performance
  // backlog, and this is the test that will notice the day it ships.
  it('turns the second writer away, and how depends on readwrite-unsafe', async () => {
    const { a, b } = twoClients();
    await a.write('CREATE TABLE t (n)');

    let settled = false;
    let attempt!: Promise<unknown>;
    await a.transaction(async (tx) => {
      // A holds the file from here until this callback returns.
      await tx.write('INSERT INTO t VALUES (1)');
      attempt = rejectionOf(b.write('INSERT INTO t VALUES (2)'));
      settled = await settledWithin(attempt, TURNED_AWAY_WITHIN);
    });
    const error = await attempt;

    if (HAS_UNSAFE_HANDLES) {
      // The conflict reaches Web Locks, asked for with `ifAvailable: true`.
      expect(settled).toBe(true);
      expect(error).toBeInstanceOf(SQLiteError);
      expect((error as SQLiteError).code).toBe('BUSY');
    } else {
      // Reduced mode: B is still queued for the one exclusive handle, held by
      // the scheduler — no error has been produced at all.
      expect(settled).toBe(false);
      // It goes through once A lets the file go. Late, never lost.
      expect(error).toBeUndefined();
    }

    // The invariant both regimes share, and the one a consumer cares about:
    // exactly the writes that were accepted are in the database. Never a
    // partial row, never a silent loss, never two winners.
    const rows = await a.read<{ n: number }>('SELECT n FROM t ORDER BY n');
    expect(rows.map((row) => row.n)).toEqual(HAS_UNSAFE_HANDLES ? [1] : [1, 2]);
  });

  // Falsifiable where the writer is turned away: ship `BEGIN IMMEDIATE` in
  // transaction.ts and B fails at the BEGIN instead — `entered` stays false.
  // Verified 2026-08-28. In reduced mode the BEGIN can itself block on the
  // file, so that regime pins only that B waits, which is why the assertions
  // below are split rather than shared.
  it('lets B open its transaction and fails on the first write inside it', async () => {
    const { a, b } = twoClients();
    await a.write('CREATE TABLE t (n)');

    let entered = false;
    let settled = false;
    let attempt!: Promise<unknown>;
    await a.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
      attempt = rejectionOf(
        b.transaction(async (btx) => {
          // Reached only if BEGIN took no lock of its own.
          entered = true;
          await btx.write('INSERT INTO t VALUES (2)');
        }),
      );
      settled = await settledWithin(attempt, TURNED_AWAY_WITHIN);
    });
    const error = await attempt;

    if (HAS_UNSAFE_HANDLES) {
      expect(entered).toBe(true);
      expect(settled).toBe(true);
      expect((error as SQLiteError).code).toBe('BUSY');
    } else {
      expect(settled).toBe(false);
      expect(error).toBeUndefined();
    }
  });

  // The shape a consumer is least likely to expect, and only one regime has
  // it: not "the load failed" but "the load half happened". `bulkWrite` commits
  // per batch, so a writer taking the file partway through leaves every earlier
  // batch behind.
  //
  // Falsifiable by its own middle assertion: if `bulkWrite` did not commit per
  // batch, the first batch would be invisible to A until `close()`, `committed`
  // would stay 0 through all hundred polls, and the run would stop there. The
  // consumer's remedy is the other API — `tx.bulkWrite` shares one transaction
  // across every batch, so a failure leaves nothing rather than half.
  it('leaves a bulkWrite half-loaded where a writer can take the file from it', async () => {
    const { a, b } = twoClients();
    // Sixteen columns so a batch is 32766/16 = 2047 rows rather than 32766:
    // the test needs TWO flushes and the first has to be affordable.
    const keys = Array.from({ length: 16 }, (_, i) => `c${i}`);
    await a.write(`CREATE TABLE t (${keys.join(', ')})`);

    const batch = Math.floor(32766 / keys.length);
    const row = (n: number) =>
      Object.fromEntries(keys.map((k) => [k, n])) as Record<string, number>;

    const writer = b.bulkWrite('t', keys);
    for (let i = 0; i < batch; i += 1) await writer.enqueue(row(i));

    // Wait for the first batch to be COMMITTED as the other client sees it —
    // an observation, not a guess about when a flush settles.
    let committed = 0;
    for (let poll = 0; poll < 100 && committed === 0; poll += 1) {
      const [count] = await a.read<{ n: number }>(
        'SELECT count(*) AS n FROM t',
      );
      committed = count?.n ?? 0;
      if (committed === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(committed).toBe(batch);

    let settled = false;
    let attempt!: Promise<unknown>;
    await a.transaction(async (tx) => {
      await tx.write(`INSERT INTO t (${keys[0]}) VALUES (-1)`);
      attempt = rejectionOf(
        (async () => {
          for (let i = 0; i < batch; i += 1) await writer.enqueue(row(i));
          return writer.close();
        })(),
      );
      settled = await settledWithin(attempt, TURNED_AWAY_WITHIN);
    });
    const error = await attempt;

    const [after] = await a.read<{ n: number }>(
      'SELECT count(*) AS n FROM t WHERE c0 >= 0',
    );

    if (HAS_UNSAFE_HANDLES) {
      expect(settled).toBe(true);
      expect(error).toBeInstanceOf(SQLiteBulkWriteError);
      // The first batch is still there: a failed bulk load is a PARTIAL load.
      expect(after?.n).toBe(batch);
    } else {
      // Reduced mode has no partial load to warn about — the remaining batches
      // wait for the file rather than being refused, and the load completes.
      expect(settled).toBe(false);
      expect(error).toBeUndefined();
      expect(after?.n).toBe(batch * 2);
    }
  });

  // The other half of the sentence the README puts in front of a consumer:
  // `tx.bulkWrite` is the all-or-nothing shape. Its batches run on the caller's
  // already-open transaction — `bulkFor` there is handed the transaction's own
  // `write` and a `transaction: (fn) => fn(db)` that opens nothing — so a flush
  // that has already happened is still uncommitted and goes back with the
  // rollback. Engine-independent: no second client, no contention, nothing that
  // depends on how handles are held.
  //
  // What this pins: batches flushed INSIDE a transaction do not survive its
  // rollback, where `db.bulkWrite`'s do — the test above measures that other
  // half. `tx.bulkWrite` runs its batches on the transaction's own worker and
  // is handed a `transaction: (fn) => fn(db)` that opens nothing, so a flush is
  // written but never committed.
  //
  // **No usable source falsifier**, and the obvious one is a trap: swapping to
  // `a.bulkWrite` here does go red, but by DEADLOCK, not by count — that writer
  // needs a second worker of A's pool, which contends for the file with the very
  // transaction under test. A red for the wrong reason proves nothing.
  //
  // The vacuity trap instead, verified: enqueue fewer than one batch and the
  // test stays GREEN and meaningless, nothing having been flushed for the
  // rollback to undo. The bounded queue is what keeps it honest — see the
  // comment at the writer.
  it('leaves nothing behind when a tx.bulkWrite is interrupted', async () => {
    const { a } = twoClients();
    const keys = Array.from({ length: 16 }, (_, i) => `c${i}`);
    await a.write(`CREATE TABLE t (${keys.join(', ')})`);
    const batch = Math.floor(32766 / keys.length);
    const row = (n: number) =>
      Object.fromEntries(keys.map((k) => [k, n])) as Record<string, number>;

    const boom = new Error('the caller gives up mid-load');
    const failure = await rejectionOf(
      a.transaction(async (tx) => {
        // `queueSize: 1` is the non-vacuity device, and it replaces a read that
        // could not be issued here: a batch of this writer is in flight on the
        // transaction's own worker, and a second query on that worker breaks
        // the one-query-per-lease invariant the statement cache rests on —
        // caught as "Previous query not finished on worker N" under load, after
        // passing in isolation. With the queue bounded at one, `enqueue`
        // resolves past the bound only once a batch has SETTLED, so awaiting
        // the last of 2 x batch rows proves a flush happened inside the
        // transaction, with nothing running concurrently.
        const writer = tx.bulkWrite('t', keys, { queueSize: 1 });
        for (let i = 0; i < 2 * batch; i += 1) await writer.enqueue(row(i));
        throw boom;
      }),
    );

    expect(failure).toBe(boom);

    // And none of them survived it. This is what `tx.bulkWrite` buys.
    const [after] = await a.read<{ n: number }>('SELECT count(*) AS n FROM t');
    expect(after?.n).toBe(0);
  });

  // The invariant the whole abort design exists for, observed under the
  // contention that only turned up on 2026-08-31: a caller who gives up must
  // never leave a worker holding an open transaction. It is held by
  // construction — `BEGIN`/`COMMIT`/`ROLLBACK` deliberately carry no signal so
  // their completion decides whether a rollback is owed, `begun` stops a
  // ROLLBACK reaching a connection that opened nothing, and the lease returns
  // only after `quiesce()`. None of that had ever been run against a second
  // client holding the file.
  //
  // The proof is the LAST assertion, not the rejection: if the abandoned
  // transaction had gone back to the pool still open, the next statement on
  // that client would fail or hang. It answers.
  //
  // Falsifiable: give `exec(worker, 'BEGIN')` the signal in transaction.ts.
  // The abort can then land between the worker opening the transaction and the
  // client learning it did, which is the state `onPoisoned` throws the worker
  // away for — the client survives, one worker poorer.
  it('gives back a usable client after a transaction is aborted mid-contention', async () => {
    const { a, b } = twoClients();
    await a.write('CREATE TABLE t (n)');

    let error: unknown;
    await a.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
      // B is refused at once or waits for the file, depending on the mode;
      // either way the signal is what ends it.
      error = await rejectionOf(
        b.transaction(
          async (btx) => {
            await btx.write('INSERT INTO t VALUES (2)');
          },
          { signal: AbortSignal.timeout(500) },
        ),
      );
    });

    expect(error).toBeInstanceOf(Error);

    // Nothing of B's abandoned transaction reached the database.
    const rows = await a.read<{ n: number }>('SELECT n FROM t ORDER BY n');
    expect(rows.map((row) => row.n)).toEqual([1]);

    // And B still works — the connection went back clean, not poisoned. A
    // worker returned mid-transaction would fail or hang here.
    await b.write('INSERT INTO t VALUES (3)');
    const after = await b.read<{ n: number }>('SELECT n FROM t ORDER BY n');
    expect(after.map((row) => row.n)).toEqual([1, 3]);
  });

  // Same invariant for the other long-running writer, plus the bound that
  // matters to a consumer: how much can still land AFTER they gave up.
  //
  // At most one batch — the one already handed to a worker. An abort abandons
  // the wait, never the work, so a statement already dispatched runs when the
  // file frees, and no client-side guard can recall it. Every batch behind it
  // is skipped by the `signal?.aborted` check in `bulk.ts`. Measured
  // 2026-08-31: with THREE batches queued behind the abort, exactly one landed.
  //
  // The bound is what is asserted, not a count, because the two modes differ
  // and neither is wrong: where the flush is refused outright nothing lands at
  // all, where it waits one batch does.
  //
  // Falsifiable: delete that `signal?.aborted` check in `bulk.ts` and all three
  // queued batches land instead of one.
  it('commits at most one more batch after a bulkWrite is aborted, and stays usable', async () => {
    const { a, b } = twoClients();
    const keys = Array.from({ length: 16 }, (_, i) => `c${i}`);
    await a.write(`CREATE TABLE t (${keys.join(', ')})`);
    const batch = Math.floor(32766 / keys.length);
    const row = (n: number) =>
      Object.fromEntries(keys.map((k) => [k, n])) as Record<string, number>;

    const writer = b.bulkWrite('t', keys, {
      signal: AbortSignal.timeout(2500),
    });
    for (let i = 0; i < batch; i += 1) await writer.enqueue(row(i));

    let committed = 0;
    for (let poll = 0; poll < 100 && committed === 0; poll += 1) {
      const [count] = await a.read<{ n: number }>(
        'SELECT count(*) AS n FROM t',
      );
      committed = count?.n ?? 0;
      if (committed === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(committed).toBe(batch);

    let error: unknown;
    await a.transaction(async (tx) => {
      await tx.write(`INSERT INTO t (${keys[0]}) VALUES (-1)`);
      error = await rejectionOf(
        (async () => {
          // Three batches behind the abort, so "one landed" cannot be read as
          // "everything queued landed".
          for (let i = 0; i < 3 * batch; i += 1) await writer.enqueue(row(i));
          return writer.close();
        })(),
      );
    });

    expect(error).toBeInstanceOf(Error);
    // Let anything still in flight settle before counting.
    await new Promise((r) => setTimeout(r, 1500));

    const [after] = await a.read<{ n: number }>(
      'SELECT count(*) AS n FROM t WHERE c0 >= 0',
    );
    const extra = ((after?.n ?? 0) - batch) / batch;
    expect(extra).toBeGreaterThanOrEqual(0);
    expect(extra).toBeLessThanOrEqual(1);

    // The client is still usable.
    await b.write(`INSERT INTO t (${keys[0]}) VALUES (-2)`);
    const [total] = await b.read<{ n: number }>('SELECT count(*) AS n FROM t');
    expect(total?.n).toBe((after?.n ?? 0) + 2);
  });
});
