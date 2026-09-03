import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { resolveRealmId } from '../../src/inspect';
import { createLocks } from '../../src/locks';

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
    const db = createSQLiteClient(file, { vfs: 'IDBBatchAtomicVFS' });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs: 'IDBBatchAtomicVFS' }).catch(() => {});
    });
    await db.read('SELECT 1');

    const snapshot = await locks.entries();
    const mine = snapshot.held.find((e) => e.name.startsWith('bsq:client:'));
    expect(mine).toBeDefined();
    expect(await resolveRealmId(locks, snapshot)).toBe(mine?.clientId);
  });
});
