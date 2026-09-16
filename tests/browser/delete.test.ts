import { afterEach, describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { SQLiteError } from '../../src/errors';
import { initLockName } from '../../src/locks';

/**
 * The database is gone when a fresh client on the same name finds no table.
 * Asserted through the library rather than through OPFS, because half the VFS
 * do not keep a file at that name at all.
 */
// One VFS: any OPFS-backed VFS reads through the same file; OPFSAdaptiveVFS
// is the representative used to check "gone" through the library.
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

  // One VFS: the deletion mechanism itself, exercised on a single
  // representative OPFS VFS — the full cross-VFS sweep is below.
  it('removes a closed database', async () => {
    const file = freshFile();
    const db = createSQLiteClient(file, { vfs: 'OPFSAdaptiveVFS' });
    await db.write('CREATE TABLE t (a INTEGER)');
    await db.close();
    expect(await tableCount(file)).toBe(1);

    await deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' });

    expect(await tableCount(file)).toBe(0);
  });

  // No target-following deletion test lives here. One was written on
  // 2026-09-16 and deleted the same day: the cross-VFS sweep below and
  // conformance invariant 7 already delete on every VFS, and no mutation of
  // src/ reddened the target version without reddening one of those first —
  // including the one that stops the deletion from removing a VFS's own
  // sidecars, which the sweep catches and it did not. It varied the BUILD and
  // nothing else, and deletion does not read the build.

  it('rejects with INVALID_OPTION when vfs is missing', async () => {
    await expect(
      // @ts-expect-error — the guard exists for JavaScript callers
      deleteDatabase('anything', {}),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  // One VFS: the guard needs a concrete VFS whose declared builds exclude
  // 'sync' — OPFSAdaptiveVFS declares ['async', 'jspi'].
  it('rejects with INVALID_OPTION when the build is not one the VFS supports', async () => {
    await expect(
      deleteDatabase('anything', { vfs: 'OPFSAdaptiveVFS', build: 'sync' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  // One VFS: the subject is MemoryVFS's no-op delete (nothing persisted).
  it('resolves without a worker for a memory VFS', async () => {
    await expect(
      deleteDatabase('anything', { vfs: 'MemoryVFS' }),
    ).resolves.toBeUndefined();
  });

  // `navigator.locks` is origin-wide, so this is the same lock a client in
  // another tab would hold while opening. Held here directly, because the point
  // is the lock and not the client that usually takes it.
  // One VFS: the init lock's name and behaviour is OPFS-family; OPFSAdaptiveVFS
  // is the representative used to hold it directly.
  it('rejects with BUSY while the init lock is held', async () => {
    const file = freshFile();
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();

    void navigator.locks.request(initLockName('OPFSAdaptiveVFS', file), () => {
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
  // One VFS: same init lock as above, same representative.
  it('releases the lock after a rejection, so a retry is possible', async () => {
    const file = freshFile();
    // Create the database so the retry resolves rather than throwing DATABASE_NOT_FOUND.
    const db = createSQLiteClient(file, { vfs: 'OPFSAdaptiveVFS' });
    await db.write('CREATE TABLE t (a INTEGER)');
    await db.close();

    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();

    void navigator.locks.request(initLockName('OPFSAdaptiveVFS', file), () => {
      held.resolve();
      return release.promise;
    });
    await held.promise;
    await expect(
      deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    release.resolve();

    // No real caller releases a lock and retries in the same turn, but this
    // test does exactly that. Yield to the task queue (stronger than a single
    // microtask) so the Web Locks API has a chance to process the release
    // before the next ifAvailable check.
    await new Promise((r) => setTimeout(r, 0));

    await expect(
      deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' }),
    ).resolves.toBeUndefined();
  });

  describe('deleteDatabase on a database that is not there', () => {
    // One VFS (one per case): the subject is deletion across every VFS
    // family the client ships — each name in this list is its own case, not
    // a stand-in for the injected target.
    for (const vfs of [
      'OPFSAdaptiveVFS',
      'OPFSAnyContextVFS',
      'OPFSCoopSyncVFS',
      'OPFSWriteAheadVFS',
      'AccessHandlePoolVFS',
      'IDBBatchAtomicVFS',
      'IDBMirrorVFS',
    ] as const) {
      // Falsifiable: remove the probe in deleteDatabaseFiles and every one of
      // these resolves instead of throwing — that is what the code does today.
      it(`throws DATABASE_NOT_FOUND on ${vfs} when nothing was created`, async () => {
        const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
        const error = await deleteDatabase(dbName, { vfs }).then(
          () => undefined,
          (e) => e,
        );
        expect(error).toBeInstanceOf(SQLiteError);
        expect((error as SQLiteError).code).toBe('DATABASE_NOT_FOUND');
      });

      it(`deletes on ${vfs}, then reports the second attempt`, async () => {
        const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
        const db = createSQLiteClient(dbName, { vfs, poolSize: 1 });
        await db.write('CREATE TABLE t (n)');
        await db.close();

        await expect(deleteDatabase(dbName, { vfs })).resolves.toBeUndefined();

        const error = await deleteDatabase(dbName, { vfs }).then(
          () => undefined,
          (e) => e,
        );
        expect((error as SQLiteError).code).toBe('DATABASE_NOT_FOUND');
      });

      // Falsifiable: drop `...VFS_CAPABILITIES[vfs].extraFileSuffixes` from the opfs-path
      // pass in deleteDatabaseFiles — OPFSWriteAheadVFS leaves `-wa0` and `-wa1`.
      it(`leaves no OPFS root entry named after the database on ${vfs}`, async () => {
        const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
        const db = createSQLiteClient(dbName, { vfs, poolSize: 1 });
        await db.write('CREATE TABLE t (n)');
        await db.close();

        await expect(deleteDatabase(dbName, { vfs })).resolves.toBeUndefined();

        const root = await navigator.storage.getDirectory();
        const remaining: string[] = [];
        for await (const name of (root as any).keys()) {
          if (name.startsWith(dbName)) remaining.push(name);
        }
        expect(remaining).toEqual([]);
      });
    }

    // One VFS: the subject is MemoryVFS's no-op delete, completing the sweep.
    it('still resolves on the memory VFS, which persists nothing', async () => {
      await expect(
        deleteDatabase(`browser-sqlite-test-${crypto.randomUUID()}`, {
          vfs: 'MemoryVFS',
        }),
      ).resolves.toBeUndefined();
    });
  });
});

describe('deleteDatabase under a live connection', () => {
  const liveClient = (
    vfs:
      | 'OPFSAnyContextVFS'
      | 'IDBBatchAtomicVFS'
      | 'IDBMirrorVFS'
      | 'OPFSAdaptiveVFS',
  ) => {
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(dbName, { vfs, poolSize: 1 });
    onTestFinished(async () => {
      try {
        await db.close();
      } catch {
        /* a failed client has nothing to close */
      }
      try {
        await deleteDatabase(dbName, { vfs });
      } catch {
        /* best-effort cleanup */
      }
    });
    return { db, dbName };
  };

  // One VFS (one per case): the subject is the DATABASE_IN_USE guard across
  // every multi-connection VFS family — each name in this list is its own
  // case, not a stand-in for the injected target.
  for (const vfs of [
    'OPFSAnyContextVFS',
    'IDBBatchAtomicVFS',
    'IDBMirrorVFS',
    'OPFSAdaptiveVFS',
  ] as const) {
    // Falsifiable: remove the connection-lock acquisition in delete.ts and the
    // first three go red by resolving (they delete the database today), while
    // OPFSAdaptiveVFS goes red with WORKER_CRASHED instead of DATABASE_IN_USE.
    it(`refuses with DATABASE_IN_USE on ${vfs}`, async () => {
      const { db, dbName } = liveClient(vfs);
      await db.write('CREATE TABLE t (n)');
      await db.write('INSERT INTO t VALUES (1)');

      const error = await deleteDatabase(dbName, { vfs }).then(
        () => undefined,
        (e) => e,
      );
      expect(error).toBeInstanceOf(SQLiteError);
      expect((error as SQLiteError).code).toBe('DATABASE_IN_USE');

      // The live client is untouched — this is the whole point.
      const rows = await db.read<{ n: number }>('SELECT n FROM t');
      expect(rows.map((r) => r.n)).toEqual([1]);
    });

    it(`deletes on ${vfs} once the client has closed`, async () => {
      const { db, dbName } = liveClient(vfs);
      await db.write('CREATE TABLE t (n)');
      await db.close();
      await expect(deleteDatabase(dbName, { vfs })).resolves.toBeUndefined();
    });
  }

  // One VFS: the subject is MemoryVFS's lack of any shared connection lock.
  it('still deletes on the memory VFS with a client open — nothing is shared there', async () => {
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(dbName, { vfs: 'MemoryVFS', poolSize: 1 });
    onTestFinished(async () => {
      try {
        await db.close();
      } catch {
        /* a failed client has nothing to close */
      }
    });
    await db.write('CREATE TABLE t (n)');
    await expect(
      deleteDatabase(dbName, { vfs: 'MemoryVFS' }),
    ).resolves.toBeUndefined();
  });

  // One VFS: the connection lock and its FIFO ordering is OPFS-family;
  // OPFSAdaptiveVFS is the representative.
  it('refuses a delete issued in the same task as a client construction', async () => {
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
    const vfs = 'OPFSAdaptiveVFS' as const;

    // Both requests are issued in this one task, client first. Per the Web Locks
    // specification the queue is FIFO per name, so the client's shared request is
    // processed first and the delete's ifAvailable request meets it pending.
    const db = createSQLiteClient(dbName, { vfs, poolSize: 1 });
    const attempt = deleteDatabase(dbName, { vfs }).then(
      () => undefined,
      (e) => e,
    );

    onTestFinished(async () => {
      try {
        await db.close();
      } catch {
        /* a failed client has nothing to close */
      }
      try {
        await deleteDatabase(dbName, { vfs });
      } catch {
        /* best-effort cleanup */
      }
    });

    const error = await attempt;
    expect(error).toBeInstanceOf(SQLiteError);
    expect((error as SQLiteError).code).toBe('DATABASE_IN_USE');

    // And the client that won the race is usable.
    await db.write('CREATE TABLE t (n)');
    const rows = await db.read('SELECT n FROM t');
    expect(rows).toEqual([]);
  });
});
