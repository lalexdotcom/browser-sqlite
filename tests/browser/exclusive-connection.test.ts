import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { SQLiteError } from '../../src/errors';

/**
 * Guard against AHP-2TAB: two clients on `AccessHandlePoolVFS` silently break
 * each other (measured 2026-09-01, n=3, both engines). The second resolves
 * `SELECT 1` but cannot read any table. The guard enforces an origin-wide
 * exclusive connection lock for the client's lifetime.
 *
 * Everything here is about multi-tab behaviour exercised within one page: Web
 * Locks and OPFS access handles are both origin-wide, so two clients here
 * contend exactly as two tabs would.
 */

/** Unique database name for each test. */
const dbName = () => `browser-sqlite-test-${crypto.randomUUID()}`;

/** Clean up an AccessHandlePoolVFS database. Its files live in a pool
 *  directory named after the VFS class, not directly at the dbName path, so
 *  OPFS cleanup is not useful here — just close the clients. */
const closeAll = async (
  ...clients: ReturnType<typeof createSQLiteClient>[]
) => {
  for (const client of clients) {
    try {
      await client.close();
    } catch {
      /* a BUSY client was never open — nothing to drain */
    }
  }
};

describe('AccessHandlePoolVFS exclusive connection guard', () => {
  // -------------------------------------------------------------------------
  // Core assertion: a second client fails BUSY on its first query, fast.
  //
  // Falsifiable: delete (or comment out) the `if (connLockPromise !== undefined)`
  // block in `acquireInstrumented` in src/client.ts, then run this test.
  // Without the guard, the second client resolves SELECT 1 (touching no file)
  // and appears healthy, so `error` comes back undefined and the test goes RED.
  // Restore the block and the test goes GREEN.
  // -------------------------------------------------------------------------
  it('makes the second client fail BUSY on its first query, not silently succeed', async () => {
    const name = dbName();
    const opts = { vfs: 'AccessHandlePoolVFS' as const, poolSize: 1 };

    const a = createSQLiteClient(name, opts);
    const b = createSQLiteClient(name, opts);

    onTestFinished(() => closeAll(a, b));

    // A uses the database. Workers start lazily so the first query is the
    // choke point — the connection lock settles before or at this await.
    await a.write('CREATE TABLE t (n)');
    await a.write('INSERT INTO t VALUES (42)');

    // B's first query must fail with BUSY, not pass. Timing: the lock guard
    // resolves with `ifAvailable: true` before the first `acquireInstrumented`
    // is awaited, so the error surfaces promptly.
    let error: unknown;
    try {
      await b.read('SELECT n FROM t');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(SQLiteError);
    expect((error as SQLiteError).code).toBe('BUSY');
    // The message must name the VFS and explain what to do.
    expect((error as SQLiteError).message).toMatch(/AccessHandlePoolVFS/);
    expect((error as SQLiteError).message).toMatch(/one connection at a time/);
    expect((error as SQLiteError).message).toMatch(/Close that client/);
  });

  // The BUSY error must arrive quickly — not after a 30-second stall, which
  // is what happens without the guard when an exclusive handle is already held.
  it('fails fast — within 3 seconds, not after a timeout stall', async () => {
    const name = dbName();
    const opts = { vfs: 'AccessHandlePoolVFS' as const, poolSize: 1 };

    const a = createSQLiteClient(name, opts);
    const b = createSQLiteClient(name, opts);

    onTestFinished(() => closeAll(a, b));

    await a.write('CREATE TABLE t (n)');

    const start = Date.now();
    let error: unknown;
    try {
      await b.read('SELECT 1');
    } catch (e) {
      error = e;
    }
    const elapsed = Date.now() - start;

    expect(error).toBeInstanceOf(SQLiteError);
    expect((error as SQLiteError).code).toBe('BUSY');
    // Must be fast — well under the default 30-second open timeout.
    expect(elapsed).toBeLessThan(3000);
  });

  // -------------------------------------------------------------------------
  // Recovery: closing the first client releases the lock so a new client can
  // open the same database. This is the consumer's expected flow.
  //
  // Falsifiable: remove `connRelease?.()` from `close()` in src/client.ts.
  // Without it the lock is never released, the second client always gets BUSY,
  // and this test goes RED at the `await c.read(...)` assertion.
  // -------------------------------------------------------------------------
  it('allows a new client after the first is closed', async () => {
    const name = dbName();
    const opts = { vfs: 'AccessHandlePoolVFS' as const, poolSize: 1 };

    const a = createSQLiteClient(name, opts);
    await a.write('CREATE TABLE t (n)');
    await a.write('INSERT INTO t VALUES (99)');

    // Close A — this must release the connection lock.
    await a.close();

    // C opens after A is fully closed; it must succeed.
    const c = createSQLiteClient(name, opts);
    onTestFinished(() => closeAll(c));

    const rows = await c.read<{ n: number }>('SELECT n FROM t');
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(99);
  });

  // -------------------------------------------------------------------------
  // Orphan-worker race (AHP-CLOSE-RACE): if close() is called before any
  // query — before the lock even settles — the deferred-spawn callback fires
  // as a microtask when `close()` awaits connLockPromise. At that point
  // `pool.length = 0` has already run, so any worker spawned there is
  // orphaned: close() will never terminate it. The orphan holds OPFS access
  // handles; a new client on the same name gets WORKER_CRASHED instead of
  // opening cleanly.
  //
  // The fix: `else if (!closing)` in the deferred-spawn callback — don't
  // start workers if close() has already been called.
  //
  // Falsifiable: replace `else if (!closing)` with `else` in the deferred-
  // spawn block in src/client.ts. Then this test goes RED on Firefox: the
  // orphaned worker has a head start over B's worker (it was spawned while
  // close() awaited connLockPromise, before the lock was released) and opens
  // the OPFS handles first, causing B's worker to get WORKER_CRASHED.
  // On Chromium the timing is tighter and B may win the race, so falsifying
  // there is less reliable. Firefox is the authoritative engine for this test.
  //
  // No wall-clock dependency: the test waits on `a.close()` (a concrete
  // observable) before constructing B. If the orphan is present, B's worker
  // crashes deterministically on Firefox because the orphan already holds the
  // OPFS handles by the time B's workers start.
  // -------------------------------------------------------------------------
  it('does not orphan workers when close() is called before any query', async () => {
    const name = dbName();
    const opts = { vfs: 'AccessHandlePoolVFS' as const, poolSize: 1 };

    // Create A and close it immediately — before any query forces the lock
    // to settle. This is the path that previously orphaned a worker.
    const a = createSQLiteClient(name, opts);
    await a.close();

    // B opens cleanly: no orphaned worker should be holding OPFS handles.
    const b = createSQLiteClient(name, opts);
    onTestFinished(() => closeAll(b));

    // If an orphan holds the handles, this write fails with WORKER_CRASHED.
    await b.write('CREATE TABLE t (n)');
    await b.write('INSERT INTO t VALUES (1)');
    const rows = await b.read<{ n: number }>('SELECT n FROM t');
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Control: the guard must not over-reach. OPFSAdaptiveVFS supports multiple
  // connections, so two clients on the same database must both work.
  //
  // Falsifiable: set `exclusiveConnection: true` on OPFSAdaptiveVFS in
  // VFS_CAPABILITIES. The second client then gets BUSY and this goes RED.
  // -------------------------------------------------------------------------
  it('does not block a second client on OPFSAdaptiveVFS (control)', async () => {
    const name = dbName();
    const opts = { vfs: 'OPFSAdaptiveVFS' as const, poolSize: 1 };

    const a = createSQLiteClient(name, opts);
    const b = createSQLiteClient(name, opts);

    onTestFinished(async () => {
      await closeAll(a, b);
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(name, { recursive: true });
      } catch {
        /* may not exist if the test failed early */
      }
    });

    await a.write('CREATE TABLE t (n)');
    await a.write('INSERT INTO t VALUES (7)');

    // B must succeed on a VFS that supports multiple connections.
    const rows = await b.read<{ n: number }>('SELECT n FROM t');
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(7);
  });
});
