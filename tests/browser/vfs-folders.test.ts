import { describe, expect, it, onTestFinished, rstest } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { inspectDatabase } from '../../src/inspect';
import { VFS_CAPABILITIES } from '../../src/types';
import { databasePath, MAX_DATABASE_PATH } from '../../src/utils';
import { TEST_TARGET } from './helpers';

const { vfs, build } = TEST_TARGET;
const persistent = VFS_CAPABILITIES[vfs].storage !== 'memory';

describe('the name a consumer uses', () => {
  (persistent ? it : it.skip)(
    'hands db.file back to deleteDatabase and inspectDatabase as the same database',
    async () => {
      const name = `vfs-folders-${crypto.randomUUID()}`;
      const db = createSQLiteClient(name, { vfs, build, poolSize: 1 });
      await db.write('CREATE TABLE t (a INTEGER)');
      // Falsifiable: return the path from `get file()` and the name becomes
      // `ad/ad/…` on a folder VFS — inspectDatabase then finds no client.
      expect(db.file).toBe(name);
      expect((await inspectDatabase(db.file, { vfs })).clients.length).toBe(1);
      await db.close();
      await expect(
        deleteDatabase(db.file, { vfs, build }),
      ).resolves.toBeUndefined();
    },
  );

  (persistent ? it : it.skip)(
    'opens, writes and deletes a name with a slash',
    async () => {
      const name = `vf-${crypto.randomUUID()}/nested`;
      const db = createSQLiteClient(name, { vfs, build, poolSize: 1 });
      onTestFinished(() =>
        deleteDatabase(name, { vfs, build }).catch(() => {}),
      );
      await db.write('CREATE TABLE t (a INTEGER)');
      expect(db.files[0]).toBe(databasePath(vfs, name));
      await db.close();
      await expect(
        deleteDatabase(name, { vfs, build }),
      ).resolves.toBeUndefined();
    },
  );

  (persistent ? it : it.skip)(
    'opens and persists a path exactly at the bound',
    async () => {
      const folder = databasePath(vfs, '').length; // 3 on a folder VFS, 0 elsewhere
      const name = 'b'.repeat(MAX_DATABASE_PATH - folder);
      onTestFinished(() =>
        deleteDatabase(name, { vfs, build }).catch(() => {}),
      );
      const db = createSQLiteClient(name, { vfs, build, poolSize: 1 });
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.close();
      const reopened = createSQLiteClient(name, { vfs, build, poolSize: 1 });
      const rows = await reopened.read<{ n: number }>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'",
      );
      expect(rows[0].n).toBe(1);
      await reopened.close();
    },
  );
});

describe('the path length guard', () => {
  // Synchronous, unlike the two below: createSQLiteClient never returns a
  // promise, so the refusal has to be a thrown error, not a rejection.
  it('refuses a too-long name synchronously, before any worker', () => {
    expect(() =>
      createSQLiteClient('n'.repeat(60), { vfs: TEST_TARGET.vfs }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_OPTION' }));
  });

  it('deleteDatabase refuses a too-long name before taking any lock', async () => {
    const request = rstest.spyOn(navigator.locks, 'request');
    onTestFinished(() => request.mockRestore());
    await expect(
      deleteDatabase('n'.repeat(60), { vfs: 'IDBBatchAtomicVFS' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
    expect(request).not.toHaveBeenCalled();
  });

  it('inspectDatabase refuses a too-long name before taking any lock', async () => {
    const request = rstest.spyOn(navigator.locks, 'request');
    onTestFinished(() => request.mockRestore());
    await expect(
      inspectDatabase('n'.repeat(60), { vfs: 'IDBBatchAtomicVFS' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
    expect(request).not.toHaveBeenCalled();
  });
});
