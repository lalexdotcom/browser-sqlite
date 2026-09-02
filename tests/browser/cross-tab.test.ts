import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { BARRIER_SQL, epochLockName } from '../../src/epochs';
import { namespaceFor } from '../../src/locks';
import { heldNamesIn, holdIn, makeRealm } from './helpers/realm';

const VFS = 'OPFSAdaptiveVFS' as const;

const oneClient = () => {
  const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
  const db = createSQLiteClient(dbName, { vfs: VFS, poolSize: 2 });
  onTestFinished(async () => {
    try {
      await db.close();
    } catch {
      /* a failed client has nothing to close */
    }
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dbName, { recursive: true });
    } catch {
      /* the entry may not exist if the test failed before creation */
    }
  });
  return { db, dbName };
};

const countBarrierStatements = (
  db: ReturnType<typeof createSQLiteClient>,
): number =>
  (db.debug?.workers ?? [])
    .flatMap((worker) => worker.requests)
    .flatMap((request) => request.queries)
    .filter((query) => query.sql === BARRIER_SQL).length;

describe('an epoch published by another realm', () => {
  // poolSize: 1 makes the control direction deterministic: after the writes
  // the single worker is current (seen = local epoch) and a read runs no
  // barrier. Holding a foreign marker far ahead then forces exactly one.
  //
  // Falsifiable: drop the `await epochs.originMax(); epochs.raiseTo(origin);`
  // lines in `applyBarrier` and this goes red — the local cell never hears
  // about the foreign epoch, so barriers stays 0.
  it('makes this client run the barrier it would otherwise skip', async () => {
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(dbName, {
      vfs: VFS,
      poolSize: 1,
      debug: true,
    });
    onTestFinished(async () => {
      try {
        await db.close();
      } catch {
        /* a failed client has nothing to close */
      }
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(dbName, { recursive: true });
      } catch {
        /* the entry may not exist if the test failed before creation */
      }
    });

    await db.write('CREATE TABLE t (n)');
    await db.write('INSERT INTO t VALUES (1)');
    // The single worker is now current with the local epoch. A read here
    // will not run a barrier — seen equals target, no foreign marker.
    await db.read('SELECT n FROM t');

    // Control direction: no foreign marker → read adds no barrier statements.
    const noMarkerBefore = countBarrierStatements(db);
    await db.read('SELECT n FROM t');
    expect(countBarrierStatements(db)).toBe(noMarkerBefore);

    // Hold a marker far ahead of the local epoch from another realm, exactly
    // as a foreign tab would after committing at epoch 9999.
    const realm = await makeRealm();
    const marker = epochLockName(namespaceFor(VFS), dbName, 9_999);
    const release = await holdIn(realm, marker, 'shared');

    // Foreign-marker direction: originMax() now reports 9999, raiseTo raises
    // the local floor, and every worker's seen (≤ 2) is below the new target.
    const withMarkerBefore = countBarrierStatements(db);
    await db.read('SELECT n FROM t');
    expect(countBarrierStatements(db)).toBeGreaterThan(withMarkerBefore);

    release();
  });

  it('never lets the target go backwards when the marker disappears', async () => {
    const { db, dbName } = oneClient();
    await db.write('CREATE TABLE t (n)');

    const realm = await makeRealm();
    const marker = epochLockName(namespaceFor(VFS), dbName, 4_242);
    const release = await holdIn(realm, marker, 'shared');
    await db.read('SELECT n FROM t');
    release();

    // The origin now reports nothing, but the local floor holds 4242. A write
    // must produce 4243, never 1 — a restarted counter is the one class of bug
    // this design has to make impossible (epochs.ts:51-53).
    await db.write('INSERT INTO t VALUES (1)');
    const published = (await heldNamesIn(window)).filter((name) =>
      name.startsWith(`bsq:epoch:${namespaceFor(VFS)}:${dbName}:`),
    );
    expect(published).toEqual([
      epochLockName(namespaceFor(VFS), dbName, 4_243),
    ]);
  });

  it('blocks transaction() until the epoch marker is granted', async () => {
    // Falsifiable: remove the `await` before `deps.afterWrite(worker)` in
    // transaction.ts's finally and this goes red — transaction() resolves
    // before publish() grants the shared lock, so txResolved is true while
    // our exclusive lock still blocks the grant.
    //
    // The simpler heldNamesIn shape (check after await transaction()) was
    // attempted first and found non-falsifiable on both engines: the `await`
    // in heldNamesIn itself yields to the browser, which grants the shared
    // lock before the query() snapshot runs.
    //
    // A pre-held exclusive lock on epoch 1 was tried second and also failed
    // WITH the fix: applyBarrier (run before the callback) calls originMax(),
    // sees the pre-held lock, calls raiseTo(1), then afterWrite bumps to 2
    // and publishes epoch 2 — bypassing the blocked epoch 1 entirely.
    //
    // This version holds the exclusive lock INSIDE the callback, AFTER tx.write().
    // applyBarrier runs before the callback and cannot see it. The epoch
    // counter stays at 0, so afterWrite will publish epoch 1 and be blocked.
    // A realm (iframe) is used for the hold so the exclusive and shared
    // requests come from different JS contexts, guaranteeing contention.
    //
    // ORDERING HAZARD (fixed): releaseExclusive was assigned inside the
    // callback after an async write. Under a loaded suite the write can take
    // longer than the 400 ms budget, so the finally ran while releaseExclusive
    // was still undefined. The ?.() no-op skipped the release; the exclusive
    // lock was never freed; afterWrite hung waiting for the shared-lock grant;
    // txDone never settled. Fix: a lockHeld promise is resolved from inside
    // the callback the moment holdIn() returns. The body awaits that promise
    // before starting the race, so the 400 ms budget measures only what it
    // claims — whether transaction() is blocked by the lock — not the write
    // round-trip time. Never use a wall-clock budget to order two async events.
    const { db, dbName } = oneClient();
    const realm = await makeRealm();
    // The first commit in a fresh client publishes epoch 1.
    const marker = epochLockName(namespaceFor(VFS), dbName, 1);
    let releaseExclusive: (() => void) | undefined;

    // Resolves the moment holdIn() returns — i.e., the exclusive lock is actually held.
    let signalHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });

    let txResolved = false;
    const txDone = db
      .transaction(async (tx) => {
        await tx.write('CREATE TABLE t (n)');
        // applyBarrier ran before this callback — it does not see this lock.
        // The epoch counter is still 0. afterWrite will bump to 1 and try
        // to hold epoch 1 as shared; our exclusive blocks that grant.
        releaseExclusive = await holdIn(realm, marker);
        signalHeld();
      })
      .then(() => {
        txResolved = true;
      });

    // Wait until the exclusive lock is actually held before starting the race.
    // If txDone settles first, the callback never reached holdIn (lock never
    // taken), and releaseExclusive?.() in the finally is a correct no-op.
    await Promise.race([lockHeld, txDone]);

    try {
      // 400 ms is far longer than the write round-trip. If transaction() has
      // not resolved by then it is genuinely waiting for the lock grant.
      const winner = await Promise.race([
        txDone.then(() => 'tx' as const),
        new Promise<'timeout'>((r) => setTimeout(r, 400, 'timeout')),
      ]);
      // With fix: transaction blocked → timeout wins.
      // Without fix: transaction resolves early → tx wins.
      expect(winner).toBe('timeout');
      expect(txResolved).toBe(false);
    } finally {
      releaseExclusive?.();
      await txDone;
    }
  });

  it('publishes exactly one marker per realm, whatever the pool size', async () => {
    const { db, dbName } = oneClient();
    await db.write('CREATE TABLE t (n)');
    await db.write('INSERT INTO t VALUES (1)');
    await db.write('INSERT INTO t VALUES (2)');
    await db.write('INSERT INTO t VALUES (3)');

    const prefix = `bsq:epoch:${namespaceFor(VFS)}:${dbName}:`;
    const published = (await heldNamesIn(window)).filter((name) =>
      name.startsWith(prefix),
    );
    // Three commits, one marker: the previous is released as the next is taken.
    expect(published.length).toBe(1);
  });
});
