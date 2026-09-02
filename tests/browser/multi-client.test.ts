import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';

/**
 * What two clients writing at once actually do.
 *
 * Nothing here mentions tabs and everything here is about them: Web Locks and
 * OPFS access handles are both origin-wide, so two clients in this one page
 * contend exactly as two tabs would.
 *
 * **There is one behaviour now, not two.** Before the origin-wide write lock,
 * `readwrite-unsafe` split these tests down the middle: with it the second
 * writer was refused at once with BUSY, without it it waited for the rotated
 * exclusive handle and went through late. The lock puts the queue in front of
 * SQLite's locking on both regimes, so B always waits and always goes through.
 * `HAS_UNSAFE_HANDLES` is deliberately no longer consulted here — if a
 * regime-dependent assertion comes back, the lock has stopped covering a path.
 *
 * Every wait here is BOUNDED, and that is not decoration: the first version of
 * this file awaited B inside A's transaction callback, so on any engine where
 * B waits the two deadlocked — the test presupposed the fail-fast behaviour it
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
  // Falsifiable: delete the `locks.hold(writeLock, …)` line in
  // `acquireInstrumented` and this goes red on `settled` where handles are
  // per-connection — B is refused with BUSY instead of waiting.
  it('makes the second writer wait, on both regimes', async () => {
    const { a, b } = twoClients();
    await a.write('CREATE TABLE t (n)');

    let settled = false;
    let attempt!: Promise<unknown>;
    await a.transaction(async (tx) => {
      // A holds the write lock from here until this callback returns.
      await tx.write('INSERT INTO t VALUES (1)');
      attempt = rejectionOf(b.write('INSERT INTO t VALUES (2)'));
      settled = await settledWithin(attempt, TURNED_AWAY_WITHIN);
    });
    const error = await attempt;

    expect(settled).toBe(false);
    expect(error).toBeUndefined();

    // The invariant a consumer cares about: exactly the writes that were
    // accepted are in the database, and now BOTH are accepted.
    const rows = await a.read<{ n: number }>('SELECT n FROM t ORDER BY n');
    expect(rows.map((row) => row.n)).toEqual([1, 2]);
  });

  // I13: B is never awaited to completion inside A's callback. In reduced mode
  // a read waits for the rotated exclusive handle, so awaiting it there
  // deadlocks the test rather than failing it — which is precisely how the
  // first version of this file was written, and why it is called out.
  //
  // So what is asserted is the claim our lock actually makes: a read-only
  // transaction is never REFUSED by it. Whether it also completes promptly is
  // the VFS's business, and differs by regime.
  //
  // Falsifiable: give the readOnly branch a write lock too, and `error` becomes
  // an AbortError once the budget's signal fires — or the test times out where
  // no signal is passed. Verify by making the change, not by reasoning.
  it('never refuses a read-only transaction opened under a writer', async () => {
    const { a, b } = twoClients();
    await a.write('CREATE TABLE t (n)');
    await a.write('INSERT INTO t VALUES (1)');

    let attempt!: Promise<unknown>;
    await a.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (2)');
      attempt = rejectionOf(
        b.transaction(
          async (btx) => {
            await btx.read<{ n: number }>('SELECT n FROM t');
          },
          { readOnly: true },
        ),
      );
      // Bounded, and the result is deliberately not asserted: on one regime it
      // settles here, on the other it is still waiting on the OPFS handle.
      await settledWithin(attempt, TURNED_AWAY_WITHIN);
    });

    // Awaited to completion only now that A has let the file go.
    expect(await attempt).toBeUndefined();
  });

  // `bulkWrite` still commits PER BATCH and still takes one lock per batch —
  // `bulk.ts` calls the public `write`. So another client's write can still
  // land between two batches; what changed is that neither side is refused.
  //
  // Falsifiable by its own middle assertion: if `bulkWrite` did not commit per
  // batch, the first batch would be invisible to A until `close()` and
  // `committed` would stay 0 through all hundred polls.
  it('interleaves a bulkWrite with another client, refusing neither', async () => {
    const { a, b } = twoClients();
    const keys = Array.from({ length: 16 }, (_, i) => `c${i}`);
    await a.write(`CREATE TABLE t (${keys.join(', ')})`);

    const batch = Math.floor(32766 / keys.length);
    const row = (n: number) =>
      Object.fromEntries(keys.map((k) => [k, n])) as Record<string, number>;

    const writer = b.bulkWrite('t', keys);
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

    await a.write(`INSERT INTO t (${keys[0]}) VALUES (-1)`);
    for (let i = 0; i < batch; i += 1) await writer.enqueue(row(i));
    await writer.close();

    const [after] = await a.read<{ n: number }>(
      'SELECT count(*) AS n FROM t WHERE c0 >= 0',
    );
    expect(after?.n).toBe(batch * 2);
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
