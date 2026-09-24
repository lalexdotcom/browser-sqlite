import { afterEach, describe, expect, it } from '@rstest/core';
import { folderOf, type SQLiteVFS } from '../../src/const/vfs';
import { deleteDatabase } from '../../src/delete';
import { databasePath } from '../../src/utils';
import {
  ALL_VFS,
  conformanceClient,
  createReopened,
  expectNoWorkerLost,
  missingHere,
} from './helpers';

afterEach(expectNoWorkerLost);

const FOLDER_VFS = ALL_VFS.filter((vfs) => folderOf(vfs) !== undefined);

/** The entries of `path`'s folder whose name starts with the database's. */
const entriesBeside = async (path: string): Promise<string[]> => {
  const segments = path.split('/');
  const base = segments.pop() as string;
  let dir = await navigator.storage.getDirectory();
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
  const names: string[] = [];
  for await (const name of (dir as any).keys()) {
    if (name.startsWith(base)) names.push(`${segments.join('/')}/${name}`);
  }
  return names;
};

const tableCount = async (file: string, vfs: SQLiteVFS) => {
  const db = createReopened(file, vfs);
  try {
    const rows = await db.read<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'",
    );
    return rows[0].n;
  } finally {
    await db.close();
  }
};

// Each VFS writes once and reads once: ad→ac, ac→cs, cs→wa, wa→ad.
describe('a database belongs to the VFS that wrote it', () => {
  FOLDER_VFS.forEach((writer, i) => {
    const reader = FOLDER_VFS[(i + 1) % FOLDER_VFS.length];
    const missing = missingHere(writer) ?? missingHere(reader);
    if (missing) {
      it.skip(`${writer} → ${reader} — skipped, no ${missing} in this browser`, () => {});
      return;
    }
    it(`${writer} → ${reader}`, async () => {
      const { file, db } = conformanceClient(writer);
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.close();

      // Nothing exists yet at this name through the reader's VFS.
      await expect(deleteDatabase(file, { vfs: reader })).rejects.toMatchObject(
        { code: 'DATABASE_NOT_FOUND' },
      );
      // Falsifiable: make databasePath return `file` unchanged and the reader
      // opens the writer's file, finding one table.
      expect(await tableCount(file, reader)).toBe(0);
      expect(await tableCount(file, writer)).toBe(1);
      // Cleanup: the reader's (empty) database now exists too.
      await deleteDatabase(file, { vfs: reader });
      await deleteDatabase(file, { vfs: writer });
    });
  });
});

describe('db.files covers what the VFS writes', () => {
  for (const vfs of FOLDER_VFS) {
    const missing = missingHere(vfs);
    if (missing) {
      it.skip(`${vfs} — skipped, no ${missing} in this browser`, () => {});
      continue;
    }
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.transaction(async (tx) => {
        for (let i = 0; i < 50; i++)
          await tx.write('INSERT INTO t VALUES (?)', [i]);
      });
      const files = db.files;
      expect(files[0]).toBe(databasePath(vfs, db.file));
      // Falsifiable: drop extraFileSuffixes from databaseFiles and
      // OPFSWriteAheadVFS's -wa0 / -wa1 are found beside it but not listed.
      for (const entry of await entriesBeside(files[0])) {
        expect(files).toContain(entry);
      }
      await db.close();
    });
  }
});

describe('deleteDatabase leaves the VFS folder', () => {
  for (const vfs of FOLDER_VFS) {
    const missing = missingHere(vfs);
    if (missing) {
      it.skip(`${vfs} — skipped, no ${missing} in this browser`, () => {});
      continue;
    }
    it(`${vfs}`, async () => {
      const { file, db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');
      const files = db.files;
      await db.close();
      await deleteDatabase(file, { vfs });

      expect(await entriesBeside(files[0])).toEqual([]);
      const root = await navigator.storage.getDirectory();
      await expect(
        root.getDirectoryHandle(`.${folderOf(vfs)}`),
      ).resolves.toBeDefined();
    });
  }
});
