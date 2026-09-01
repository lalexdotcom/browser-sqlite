import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { epochLockName } from '../../src/epochs';
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

describe('an epoch published by another realm', () => {
  // A foreign tab manifests to us ONLY as a held lock name, so holding that
  // name from the iframe is the whole of what a second tab does to us. It
  // isolates the mechanism rather than shortcutting it.
  //
  // Falsifiable: drop the `await epochs.originMax()` line in `applyBarrier`
  // and this goes red — `barriers` stays 0 because the local cell never hears
  // about the foreign commit.
  it('makes this client run the barrier it would otherwise skip', async () => {
    const { db, dbName } = oneClient();
    await db.write('CREATE TABLE t (n)');
    await db.write('INSERT INTO t VALUES (1)');
    // Every worker is now current with the local epoch, so a read here would
    // run no barrier at all.
    await db.read('SELECT n FROM t');

    const realm = await makeRealm();
    const marker = epochLockName(namespaceFor(VFS), dbName, 9_999);
    const release = await holdIn(realm, marker, 'shared');
    expect(await heldNamesIn(window)).toContain(marker);

    // The read must now go through BARRIER_SQL: the origin reports 9999 and
    // every worker's `seen` is far below it.
    const rows = await db.read<{ n: number }>('SELECT n FROM t');
    expect(rows.map((row) => row.n)).toEqual([1]);

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
