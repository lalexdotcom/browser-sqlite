import { deleteDatabase } from 'browser-sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { SQLiteError } from '../../../src/types/errors';
import { sharedDatabase, TEST_TARGET } from '../helpers';

/**
 * `sharedDatabase()` is how a test opens several clients on one database
 * (plan C, decision 4). Its cleanup is what the per-file storage wipe relies
 * on: an IndexedDB database or an AccessHandlePoolVFS slot it left behind
 * would fail the next file.
 */
describe('sharedDatabase', () => {
  it('opens every client on the same database', {
    tags: ['requires:shared-second-client'],
  }, async () => {
    // Falsifiable: give `open` a fresh name per call and B sees no table.
    const db = sharedDatabase();
    const a = db.open({ poolSize: 1 });
    await a.write('CREATE TABLE t (x)');
    await a.write('INSERT INTO t VALUES (7)');
    const b = db.open({ poolSize: 1 });
    expect(await b.read('SELECT x FROM t')).toEqual([{ x: 7 }]);
  });

  it('deletes the database once the test is over', {
    tags: ['requires:shared-storage'],
  }, async () => {
    // Falsifiable: drop the deleteDatabase from the cleanup and this goes red
    // on the IndexedDB and AccessHandlePoolVFS pairs (the folder-based OPFS
    // VFS are cleaned by removing files, which this test cannot tell apart).
    // Registered first, so it runs after sharedDatabase's own cleanup
    // (onTestFinished hooks run in reverse).
    const { vfs, build } = TEST_TARGET;
    let name = '';
    onTestFinished(async () => {
      const error = await deleteDatabase(name, { vfs, build }).catch(
        (e: unknown) => e,
      );
      expect((error as SQLiteError)?.code).toBe('DATABASE_NOT_FOUND');
    });
    const db = sharedDatabase();
    name = db.name;
    await db.open({ poolSize: 1 }).write('CREATE TABLE t (x)');
  });
});
