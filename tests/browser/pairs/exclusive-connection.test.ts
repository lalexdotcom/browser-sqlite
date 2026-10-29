import { SQLiteError } from 'browser-sqlite';
import { describe, expect, it } from 'vitest';
import { connectionLockName } from '../../../src/locks';
import { databasePath } from '../../../src/utils';
import {
  createTestClient,
  scaled,
  sharedDatabase,
  TEST_TARGET,
} from '../helpers';

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

describe('the exclusive connection guard', () => {
  // -------------------------------------------------------------------------
  // Core assertion: a second client fails BUSY on its first query, fast.
  //
  // Falsifiable: delete (or comment out) the `if (connLockPromise !== undefined)`
  // block in `acquireInstrumented` in src/client.ts, then run this test.
  // Without the guard, the second client resolves SELECT 1 (touching no file)
  // and appears healthy, so `error` comes back undefined and the test goes RED.
  // Restore the block and the test goes GREEN.
  // -------------------------------------------------------------------------
  it('makes the second client fail BUSY on its first query, not silently succeed', {
    tags: ['requires:exclusive-connection'],
  }, async () => {
    const db = sharedDatabase();
    const a = db.open({ poolSize: 1 });
    const b = db.open({ poolSize: 1 });

    // A uses the database. Workers start lazily so the first query is the
    // choke point — the connection lock settles before or at this await.
    await a.run('CREATE TABLE t (n)');
    await a.run('INSERT INTO t VALUES (42)');

    // B's first query must fail with BUSY, not pass. Timing: the lock guard
    // resolves with `ifAvailable: true` before the first `acquireInstrumented`
    // is awaited, so the error surfaces promptly.
    let error: unknown;
    try {
      await b.all('SELECT n FROM t');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(SQLiteError);
    expect((error as SQLiteError).code).toBe('DATABASE_IN_USE');
    // The message must name the VFS and explain what to do.
    expect((error as SQLiteError).message).toMatch(new RegExp(TEST_TARGET.vfs));
    expect((error as SQLiteError).message).toMatch(/one connection at a time/);
    expect((error as SQLiteError).message).toMatch(/Close that client/);
  });

  // The BUSY error must arrive quickly — not after a 30-second stall, which
  // is what happens without the guard when an exclusive handle is already held.
  it('fails fast, not after a timeout stall', {
    tags: ['requires:exclusive-connection'],
  }, async () => {
    const db = sharedDatabase();
    const a = db.open({ poolSize: 1 });
    // An open timeout past the test's own: the stall this rules out then
    // fails the test on its timeout, whatever a slow runner's boot costs.
    const b = db.open({ poolSize: 1, openTimeout: scaled(120_000) });

    await a.run('CREATE TABLE t (n)');

    let error: unknown;
    try {
      await b.all('SELECT 1');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(SQLiteError);
    expect((error as SQLiteError).code).toBe('DATABASE_IN_USE');
  });

  // -------------------------------------------------------------------------
  // Recovery: closing the first client releases the lock so a new client can
  // open the same database. This is the consumer's expected flow.
  //
  // Falsifiable: remove `connRelease?.()` from `close()` in src/client.ts.
  // Without it the lock is never released, the second client always gets BUSY,
  // and this test goes RED at the `await c.all(...)` assertion.
  // -------------------------------------------------------------------------
  it('allows a new client after the first is closed', {
    tags: ['requires:exclusive-connection'],
  }, async () => {
    const db = sharedDatabase();
    const a = db.open({ poolSize: 1 });
    await a.run('CREATE TABLE t (n)');
    await a.run('INSERT INTO t VALUES (99)');

    // Close A — this must release the connection lock.
    await a.close();

    // C opens after A is fully closed; it must succeed.
    const c = db.open({ poolSize: 1 });

    const rows = await c.all<{ n: number }>('SELECT n FROM t');
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
  // One VFS: the subject is AccessHandlePoolVFS's orphan-worker race
  // (AHP-CLOSE-RACE), specific to its pooled OPFS access handles.
  it('does not orphan workers when close() is called before any query', {
    tags: ['vfs:AccessHandlePoolVFS'],
  }, async () => {
    const database = sharedDatabase();
    const opts = { poolSize: 1 };

    // Create A and close it immediately — before any query forces the lock
    // to settle. This is the path that previously orphaned a worker.
    const a = database.open(opts);
    await a.close();

    // B opens cleanly: no orphaned worker should be holding OPFS handles.
    const b = database.open(opts);

    // If an orphan holds the handles, this write fails with WORKER_CRASHED.
    await b.run('CREATE TABLE t (n)');
    await b.run('INSERT INTO t VALUES (1)');
    const rows = await b.all<{ n: number }>('SELECT n FROM t');
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(1);
  });

  it('lets two clients coexist where the database is shared, and both hold the lock', {
    tags: ['requires:shared-second-client'],
  }, async () => {
    const db = sharedDatabase();
    const a = db.open({ poolSize: 1 });
    const b = db.open({ poolSize: 1 });

    await a.run('CREATE TABLE t (n)');
    await b.run('INSERT INTO t VALUES (1)');

    // Falsifiable: give the shared branch `ifAvailable: true` and one of these
    // two clients starts throwing DATABASE_IN_USE.
    const held = (await navigator.locks.query()).held ?? [];
    const { vfs } = TEST_TARGET;
    const name = connectionLockName(vfs, databasePath(vfs, db.name));
    expect(held.filter((lock) => lock.name === name).length).toBe(2);
    expect(
      held
        .filter((lock) => lock.name === name)
        .every((l) => l.mode === 'shared'),
    ).toBe(true);
  });

  // The subject is the absence of any connection lock where there is no
  // shared storage to guard, as on the memory VFS.
  it('takes no connection lock where nothing is shared', {
    tags: ['excludes:shared-storage'],
  }, async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.run('CREATE TABLE t (n)');

    const held = (await navigator.locks.query()).held ?? [];
    expect(held.some((lock) => (lock.name ?? '').startsWith('bsq:conn:'))).toBe(
      false,
    );
  });

  // -------------------------------------------------------------------------
  // Control: the guard must not over-reach. A VFS that supports multiple
  // connections must let two clients on the same database both work.
  //
  // Falsifiable: set `exclusiveConnection: true` on OPFSAdaptiveVFS in
  // VFS_CAPABILITIES. The second client then gets BUSY and this goes RED.
  // -------------------------------------------------------------------------
  it('does not block a second client where the database is shared (control)', {
    tags: ['requires:shared-second-client'],
  }, async () => {
    const db = sharedDatabase();
    const a = db.open({ poolSize: 1 });
    const b = db.open({ poolSize: 1 });

    await a.run('CREATE TABLE t (n)');
    await a.run('INSERT INTO t VALUES (7)');

    // B must succeed on a VFS that supports multiple connections.
    const rows = await b.all<{ n: number }>('SELECT n FROM t');
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(7);
  });
});
