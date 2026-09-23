import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { inspectDatabase } from '../../src/inspect';
import { VFS_CAPABILITIES } from '../../src/types';
import { databasePath } from '../../src/utils';
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
});
