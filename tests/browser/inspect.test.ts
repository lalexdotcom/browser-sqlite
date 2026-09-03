import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { inspectDatabase } from '../../src/inspect';
import { clientMarkerName } from '../../src/locks';
import { holdIn, makeRealm } from './helpers/realm';

const VFS = 'IDBBatchAtomicVFS' as const;

describe('inspectDatabase', () => {
  it('reports nobody on a database nothing holds', async () => {
    const result = await inspectDatabase('nobody.db', { vfs: VFS });
    expect(result.clients).toEqual([]);
    expect(result.tabs).toBe(0);
  });

  it('normalizes the file the way the client does', async () => {
    const db = createSQLiteClient('norm.db', { vfs: VFS });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase('norm.db', { vfs: VFS }).catch(() => {});
    });
    await db.read('SELECT 1');
    const viaDotSlash = await inspectDatabase('./norm.db', { vfs: VFS });
    expect(viaDotSlash.clients).toHaveLength(1);
  });

  it('separates tabs and marks only the caller as sameTab', async () => {
    const file = 'two-tabs.db';
    const db = createSQLiteClient(file, { vfs: VFS });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });
    await db.read('SELECT 1');

    // A marker held from a second realm, built with the same rule the client
    // uses. `holdIn` is the existing helper; the iframe is what makes the
    // clientId differ, and that is the whole of what `sameTab` reads.
    const foreign = clientMarkerName(
      VFS,
      file,
      '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a99',
      'SQLite 1',
    );
    const realm = await makeRealm();
    const release = await holdIn(realm, foreign, 'shared');
    onTestFinished(() => release());

    const result = await inspectDatabase(file, { vfs: VFS });
    expect(result.clients).toHaveLength(2);
    expect(result.tabs).toBe(2);
    expect(result.clients.filter((c) => c.sameTab)).toHaveLength(1);
    expect(result.clients.find((c) => !c.sameTab)?.id).toBe(
      '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a99',
    );
  });

  it('drops a marker whose realm was torn down without closing', async () => {
    const file = 'torn-down.db';
    const foreign = clientMarkerName(
      VFS,
      file,
      '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a98',
      'SQLite 1',
    );
    const realm = await makeRealm();
    await holdIn(realm, foreign, 'shared');
    expect((await inspectDatabase(file, { vfs: VFS })).clients).toHaveLength(1);

    // No release() and no close(): the iframe simply goes, the way a tab does.
    // The browser reclaiming the lock is the whole reason this is a lock and
    // not a registry entry with a timestamp.
    realm.frameElement?.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await inspectDatabase(file, { vfs: VFS })).clients).toHaveLength(0);
  });
});
