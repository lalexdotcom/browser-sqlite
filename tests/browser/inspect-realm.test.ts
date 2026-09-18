import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { resolveRealmId } from '../../src/inspect';
import { createLocks } from '../../src/locks';
import { pairFor } from './helpers';

// resolveRealmId reads Web Lock entries generically — nothing here is
// specific to one VFS family. The second test still needs a database that
// outlives its worker, which it declares rather than pins.
const locks = createLocks();

describe('resolveRealmId', () => {
  it('is stable across calls', async () => {
    const first = await resolveRealmId(locks, await locks.entries());
    const second = await resolveRealmId(locks, await locks.entries());
    expect(first).toBe(second);
    expect(first).not.toBe('');
  });

  it('matches the realm holding our own client marker', async () => {
    const file = 'realm-id.db';
    // A marker only reaches the registry for a database that outlives the
    // worker holding it: on a memory VFS there is nothing to mark, so the
    // pair resolver supplies the nearest pair of this browser that shares.
    const pair = pairFor(['shared-storage']);
    const db = createSQLiteClient(file, {
      vfs: pair.vfs,
      build: pair.build,
    });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs: pair.vfs }).catch(() => {});
    });
    await db.read('SELECT 1');

    const snapshot = await locks.entries();
    const mine = snapshot.held.find((e) => e.name.startsWith('bsq:client:'));
    expect(mine).toBeDefined();
    expect(await resolveRealmId(locks, snapshot)).toBe(mine?.clientId);
  });
});
