import { afterEach, describe, expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';

/**
 * The database is gone when a fresh client on the same name finds no table.
 * Asserted through the library rather than through OPFS, because half the VFS
 * do not keep a file at that name at all.
 */
const tableCount = async (file: string) => {
  const db = createSQLiteClient(file, { vfs: 'OPFSAdaptiveVFS' });
  const rows = await db.read<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 't'",
  );
  await db.close();
  return rows[0].n;
};

describe('deleteDatabase', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const file of created.splice(0)) {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(file, { recursive: true });
      } catch {
        // Already deleted by the test, which is the point of most of them.
      }
    }
  });

  const freshFile = () => {
    const file = `delete-${crypto.randomUUID()}`;
    created.push(file);
    return file;
  };

  it('removes a closed database', async () => {
    const file = freshFile();
    const db = createSQLiteClient(file, { vfs: 'OPFSAdaptiveVFS' });
    await db.write('CREATE TABLE t (a INTEGER)');
    await db.close();
    expect(await tableCount(file)).toBe(1);

    await deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' });

    expect(await tableCount(file)).toBe(0);
  });

  // SQLite's own xDelete is content with a missing file, and this is also what
  // makes the OPFS pass inert once upstream's jDelete is fixed.
  it('succeeds on a database that was never created', async () => {
    await expect(
      deleteDatabase(freshFile(), { vfs: 'OPFSAdaptiveVFS' }),
    ).resolves.toBeUndefined();
  });

  it('is idempotent', async () => {
    const file = freshFile();
    const db = createSQLiteClient(file, { vfs: 'OPFSAdaptiveVFS' });
    await db.write('CREATE TABLE t (a INTEGER)');
    await db.close();

    await deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' });
    await expect(
      deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' }),
    ).resolves.toBeUndefined();
  });

  it('rejects with INVALID_OPTION when vfs is missing', async () => {
    await expect(
      // @ts-expect-error — the guard exists for JavaScript callers
      deleteDatabase('anything', {}),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  it('rejects with INVALID_OPTION when the build is not one the VFS supports', async () => {
    await expect(
      deleteDatabase('anything', { vfs: 'OPFSAdaptiveVFS', build: 'sync' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  it('resolves without a worker for a memory VFS', async () => {
    await expect(
      deleteDatabase('anything', { vfs: 'MemoryVFS' }),
    ).resolves.toBeUndefined();
  });

  // `navigator.locks` is origin-wide, so this is the same lock a client in
  // another tab would hold while opening. Held here directly, because the point
  // is the lock and not the client that usually takes it.
  it('rejects with BUSY while the init lock is held', async () => {
    const file = freshFile();
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();

    void navigator.locks.request(`bsq:init:${file}`, () => {
      held.resolve();
      return release.promise;
    });
    await held.promise;

    await expect(
      deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' }),
    ).rejects.toMatchObject({ code: 'BUSY' });

    release.resolve();
  });

  // Falsifiable: make the BUSY path return instead of throwing from inside
  // `tryWithLock`, and the second call finds a lock nobody released.
  it('releases the lock after a rejection, so a retry is possible', async () => {
    const file = freshFile();
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();

    void navigator.locks.request(`bsq:init:${file}`, () => {
      held.resolve();
      return release.promise;
    });
    await held.promise;
    await expect(
      deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    release.resolve();

    await expect(
      deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' }),
    ).resolves.toBeUndefined();
  });
});
