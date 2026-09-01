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
