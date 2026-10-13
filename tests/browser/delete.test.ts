import {
  createSQLiteClient,
  deleteDatabase,
  SQLiteError,
} from 'browser-sqlite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { initLockName } from '../../src/locks';
import { databasePath } from '../../src/utils';
import {
  createTestClient,
  longQuery,
  sharedDatabase,
  sleep,
  TEST_TARGET,
} from './helpers';
import type { TestTarget } from './target';

/**
 * The database is gone when a fresh client on the same name finds no table.
 * Asserted through the library rather than through OPFS, because half the VFS
 * do not keep a file at that name at all.
 */
const tableCount = async (file: string, { vfs, build }: TestTarget) => {
  const db = createSQLiteClient(file, { vfs, build });
  const rows = await db.read<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 't'",
  );
  await db.close();
  return rows[0].n;
};

describe('deleteDatabase', () => {
  // The deletion mechanism itself, on the pair the project runs: a delete that
  // finds a file to remove needs storage that outlives the client.
  it('removes a closed database', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const { vfs, build } = TEST_TARGET;
    const database = sharedDatabase();
    const file = database.name;
    const db = database.open();
    await db.write('CREATE TABLE t (a INTEGER)');
    await db.close();
    expect(await tableCount(file, { vfs, build })).toBe(1);

    await deleteDatabase(file, { vfs, build });

    expect(await tableCount(file, { vfs, build })).toBe(0);
  });

  // The deletion tests below follow their pair through TEST_TARGET, and
  // conformance invariant 7 deletes on every VFS. Deletion does not read the
  // build, so no test here varies it.

  it('rejects with INVALID_OPTION when vfs is missing', {
    tags: ['standalone'],
  }, async () => {
    await expect(
      // @ts-expect-error — the guard exists for JavaScript callers
      deleteDatabase('anything', {}),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  // `navigator.locks` is origin-wide, so this is the same lock a client in
  // another tab would hold while opening. Held here directly, because the point
  // is the lock and not the client that usually takes it.
  it('rejects with BUSY while the init lock is held', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const { vfs, build } = TEST_TARGET;
    const file = sharedDatabase().name;
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();

    void navigator.locks.request(
      initLockName(vfs, databasePath(vfs, file)),
      () => {
        held.resolve();
        return release.promise;
      },
    );
    await held.promise;

    const wasmUrl = vi.fn(() => 'https://example.test/wasm/');
    await expect(
      deleteDatabase(file, { vfs, build, wasmUrl }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    // Falsifiable: resolve the `.wasm` URL before the locks again.
    expect(wasmUrl).not.toHaveBeenCalled();

    release.resolve();
  });

  // Falsifiable: make the BUSY path return instead of throwing from inside
  // `tryWithLock`, and the second call finds a lock nobody released.
  it('releases the lock after a rejection, so a retry is possible', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const { vfs, build } = TEST_TARGET;
    const database = sharedDatabase();
    const file = database.name;
    // Create the database so the retry resolves rather than throwing DATABASE_NOT_FOUND.
    const db = database.open();
    await db.write('CREATE TABLE t (a INTEGER)');
    await db.close();

    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();

    void navigator.locks.request(
      initLockName(vfs, databasePath(vfs, file)),
      () => {
        held.resolve();
        return release.promise;
      },
    );
    await held.promise;
    await expect(deleteDatabase(file, { vfs, build })).rejects.toMatchObject({
      code: 'BUSY',
    });
    release.resolve();

    // No real caller releases a lock and retries in the same turn, but this
    // test does exactly that. Yield to the task queue (stronger than a single
    // microtask) so the Web Locks API has a chance to process the release
    // before the next ifAvailable check.
    await new Promise((r) => setTimeout(r, 0));

    await expect(deleteDatabase(file, { vfs, build })).resolves.toBeUndefined();
  });

  describe('deleteDatabase on a database that is not there', () => {
    // Falsifiable: remove the probe in deleteDatabaseFiles and this resolves
    // instead of throwing — that is what the code does today.
    it('throws DATABASE_NOT_FOUND when nothing was created', {
      tags: ['requires:shared-storage'],
    }, async () => {
      const { vfs, build } = TEST_TARGET;
      const dbName = `bsq-test-${crypto.randomUUID()}`;
      const error = await deleteDatabase(dbName, { vfs, build }).then(
        () => undefined,
        (e) => e,
      );
      expect(error).toBeInstanceOf(SQLiteError);
      expect((error as SQLiteError).code).toBe('DATABASE_NOT_FOUND');
    });

    // Nothing persisted, so there is nothing to find missing either: the
    // memory VFS return before any probe (src/delete.ts:80).
    it('resolves when nothing was created, where nothing is kept', {
      tags: ['excludes:shared-storage'],
    }, async () => {
      const { vfs, build } = TEST_TARGET;
      const dbName = `bsq-test-${crypto.randomUUID()}`;
      await expect(
        deleteDatabase(dbName, { vfs, build }),
      ).resolves.toBeUndefined();
    });

    it('deletes, then reports the second attempt', {
      tags: ['requires:shared-storage'],
    }, async () => {
      const { vfs, build } = TEST_TARGET;
      const dbName = `bsq-test-${crypto.randomUUID()}`;
      const db = createSQLiteClient(dbName, { vfs, build, poolSize: 1 });
      await db.write('CREATE TABLE t (n)');
      await db.close();

      await expect(
        deleteDatabase(dbName, { vfs, build }),
      ).resolves.toBeUndefined();

      const error = await deleteDatabase(dbName, { vfs, build }).then(
        () => undefined,
        (e) => e,
      );
      expect((error as SQLiteError).code).toBe('DATABASE_NOT_FOUND');
    });

    it('deletes, then deletes again without error, where nothing is kept', {
      tags: ['excludes:shared-storage'],
    }, async () => {
      const { vfs, build } = TEST_TARGET;
      const dbName = `bsq-test-${crypto.randomUUID()}`;
      const db = createSQLiteClient(dbName, { vfs, build, poolSize: 1 });
      await db.write('CREATE TABLE t (n)');
      await db.close();

      await expect(
        deleteDatabase(dbName, { vfs, build }),
      ).resolves.toBeUndefined();
      await expect(
        deleteDatabase(dbName, { vfs, build }),
      ).resolves.toBeUndefined();
    });

    // A database opened but never written is still a database: the file
    // exists, it is merely empty. Red on OPFSCoopSyncVFS, whose
    // #createPersistentFile only adds a path to `accessiblePaths` when the
    // file has a size, so jOpen without SQLITE_OPEN_CREATE throws
    // `File ... not found` and returns SQLITE_CANTOPEN — which the probe in
    // deleteDatabaseFiles reads as absence.
    it('deletes a database that was opened but never written', async () => {
      const { vfs, build } = TEST_TARGET;
      const dbName = `bsq-test-${crypto.randomUUID()}`;
      const db = createSQLiteClient(dbName, { vfs, build, poolSize: 1 });
      // No write, so SQLite lays down no page and the file stays at 0 bytes.
      await db.read('SELECT 1');
      await db.close();

      await expect(
        deleteDatabase(dbName, { vfs, build }),
      ).resolves.toBeUndefined();
    });

    // Falsifiable: drop `...VFS_CAPABILITIES[vfs].extraFileSuffixes` from the
    // OPFS pass for a VFS with a folder in deleteDatabaseFiles — OPFSWriteAheadVFS
    // leaves `-wa0` and `-wa1` behind, and this goes red on that target.
    it('leaves no OPFS entry named after the database', {
      tags: ['requires:opfs-file'],
    }, async () => {
      const { vfs, build } = TEST_TARGET;
      const dbName = `bsq-test-${crypto.randomUUID()}`;
      const db = createSQLiteClient(dbName, { vfs, build, poolSize: 1 });
      await db.write('CREATE TABLE t (n)');
      await db.close();

      await expect(
        deleteDatabase(dbName, { vfs, build }),
      ).resolves.toBeUndefined();

      // The folder of databasePath(vfs, dbName) — the root when the VFS
      // has no folder.
      const path = databasePath(vfs, dbName);
      const segments = path.split('/');
      const base = segments.pop() as string;
      let dir = await navigator.storage.getDirectory();
      for (const segment of segments) {
        dir = await dir.getDirectoryHandle(segment);
      }
      const remaining: string[] = [];
      for await (const name of (dir as any).keys()) {
        if (name.startsWith(base)) remaining.push(name);
      }
      expect(remaining).toEqual([]);
    });
  });
});

describe('deleteDatabase under a live connection', () => {
  const liveClient = () => {
    const { vfs, build } = TEST_TARGET;
    const dbName = `bsq-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(dbName, { vfs, build, poolSize: 1 });
    onTestFinished(async () => {
      try {
        await db.close();
      } catch {
        /* a failed client has nothing to close */
      }
      try {
        await deleteDatabase(dbName, { vfs, build });
      } catch {
        /* best-effort cleanup */
      }
    });
    return { db, dbName };
  };

  // Falsifiable: remove the connection-lock acquisition in delete.ts and this
  // goes red — by resolving where the VFS shares its store, and with
  // WORKER_CRASHED instead of DATABASE_IN_USE on OPFSAdaptiveVFS.
  it('refuses with DATABASE_IN_USE while a client is live', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const { vfs, build } = TEST_TARGET;
    const { db, dbName } = liveClient();
    await db.write('CREATE TABLE t (n)');
    await db.write('INSERT INTO t VALUES (1)');

    const error = await deleteDatabase(dbName, { vfs, build }).then(
      () => undefined,
      (e) => e,
    );
    expect(error).toBeInstanceOf(SQLiteError);
    expect((error as SQLiteError).code).toBe('DATABASE_IN_USE');

    // The live client is untouched — this is the whole point.
    const rows = await db.read<{ n: number }>('SELECT n FROM t');
    expect(rows.map((r) => r.n)).toEqual([1]);
  });

  it('deletes once the client has closed', async () => {
    const { vfs, build } = TEST_TARGET;
    const { db, dbName } = liveClient();
    await db.write('CREATE TABLE t (n)');
    await db.close();
    await expect(
      deleteDatabase(dbName, { vfs, build }),
    ).resolves.toBeUndefined();
  });

  // The subject is the absence of any shared connection lock, as on the
  // memory VFS.
  it('still deletes with a client open where nothing is shared', {
    tags: ['excludes:shared-storage'],
  }, async () => {
    const target = { vfs: TEST_TARGET.vfs, build: TEST_TARGET.build };
    const dbName = `bsq-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(dbName, { ...target, poolSize: 1 });
    onTestFinished(async () => {
      try {
        await db.close();
      } catch {
        /* a failed client has nothing to close */
      }
    });
    await db.write('CREATE TABLE t (n)');
    await expect(deleteDatabase(dbName, target)).resolves.toBeUndefined();
  });

  it('refuses a delete issued in the same task as a client construction', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const { vfs, build } = TEST_TARGET;
    const database = sharedDatabase();
    const dbName = database.name;

    // Both requests are issued in this one task, client first. Per the Web Locks
    // specification the queue is FIFO per name, so the client's shared request is
    // processed first and the delete's ifAvailable request meets it pending.
    const db = database.open({ poolSize: 1 });
    const attempt = deleteDatabase(dbName, { vfs, build }).then(
      () => undefined,
      (e) => e,
    );

    const error = await attempt;
    expect(error).toBeInstanceOf(SQLiteError);
    expect((error as SQLiteError).code).toBe('DATABASE_IN_USE');

    // And the client that won the race is usable.
    await db.write('CREATE TABLE t (n)');
    const rows = await db.read('SELECT n FROM t');
    expect(rows).toEqual([]);
  });
});

/**
 * A worker killed while it was inside a statement holds its OPFS sync access
 * handles for far longer than an idle one — measured 2026-09-16 on Chromium:
 * ~2000 ms against ~65 ms. `AccessHandlePoolVFS` acquires every file in its
 * directory exclusively, so a delete issued in that window meets the corpse.
 *
 * `close()` then `deleteDatabase()` is the sequence a consumer writes, and
 * before the retry it failed with WORKER_CRASHED / NoModificationAllowedError.
 *
 * Falsifiable: make createVfsInstance in src/worker/worker.ts rethrow
 * instead of waiting (verified red, 2026-09-16).
 */
describe('deleting after a worker died inside a statement', () => {
  // One VFS: the subject IS AccessHandlePoolVFS's fixed handle pool. No other
  // VFS holds its whole directory, so none of them can show this.
  it('deletes a database whose worker was killed mid-statement', {
    tags: ['vfs:AccessHandlePoolVFS'],
    timeout: 60_000,
  }, async () => {
    const { vfs, build } = TEST_TARGET;
    const db = await createTestClient({ poolSize: 1, drainTimeout: 200 });
    await db.write('CREATE TABLE t (a)');

    // Abandoned on purpose: close() bounds the drain and terminates the worker
    // while it is still inside the statement.
    const running = db.read(longQuery(20_000_000)).catch(() => {});
    await sleep(100);
    await db.close();
    await running;

    await expect(
      deleteDatabase(db.file, { vfs, build }),
    ).resolves.toBeUndefined();
  });
});
