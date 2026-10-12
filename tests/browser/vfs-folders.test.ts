import {
  createSQLiteClient,
  deleteDatabase,
  inspectDatabase,
} from 'browser-sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { databasePath, MAX_DATABASE_NAME } from '../../src/utils';
import { TEST_TARGET } from './helpers';

const { vfs, build } = TEST_TARGET;

describe('the name a consumer uses', {
  tags: ['requires:shared-storage'],
}, () => {
  it('hands db.file back to deleteDatabase and inspectDatabase as the same database', async () => {
    const name = `vfs-folders-${crypto.randomUUID()}`;
    const db = createSQLiteClient(name, { vfs, build, poolSize: 1 });
    onTestFinished(() => deleteDatabase(name, { vfs, build }).catch(() => {}));
    await db.write('CREATE TABLE t (a INTEGER)');
    // Falsifiable: return the path from `get file()` and the name becomes
    // `.ad/.ad/…` on a folder VFS — inspectDatabase then finds no client.
    expect(db.file).toBe(name);
    expect((await inspectDatabase(db.file, { vfs })).clients.length).toBe(1);
    await db.close();
    await expect(
      deleteDatabase(db.file, { vfs, build }),
    ).resolves.toBeUndefined();
  });

  it('opens, writes and deletes a name with a slash', async () => {
    const name = `vf-${crypto.randomUUID()}/nested`;
    const db = createSQLiteClient(name, { vfs, build, poolSize: 1 });
    onTestFinished(() => deleteDatabase(name, { vfs, build }).catch(() => {}));
    await db.write('CREATE TABLE t (a INTEGER)');
    expect(db.files[0]).toBe(databasePath(vfs, name));
    await db.close();
    await expect(deleteDatabase(name, { vfs, build })).resolves.toBeUndefined();
  });

  it('opens and persists a name exactly at the bound', async () => {
    const name = 'b'.repeat(MAX_DATABASE_NAME);
    onTestFinished(() => deleteDatabase(name, { vfs, build }).catch(() => {}));
    // A residue from a killed run must not fail this run too.
    await deleteDatabase(name, { vfs, build }).catch(() => {});
    const db = createSQLiteClient(name, { vfs, build, poolSize: 1 });
    await db.write('CREATE TABLE IF NOT EXISTS t (a INTEGER)');
    await db.close();
    const reopened = createSQLiteClient(name, { vfs, build, poolSize: 1 });
    const rows = await reopened.read<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'",
    );
    expect(rows[0].n).toBe(1);
    await reopened.close();
  });
});
