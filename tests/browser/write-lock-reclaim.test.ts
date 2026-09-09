import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { SQLiteError } from '../../src/errors';
import { createLocks, writeLockName } from '../../src/locks';
import { holdIn, makeRealm } from './helpers/realm';

/**
 * A transaction holds the origin's write lock for the whole of its callback —
 * documented, and the price of serializing writers across every tab. What was
 * not intended is that a callback which never returns holds it FOR EVER: its
 * lease is never released, so nothing releases the lock, and every write in
 * every tab blocks silently. Measured deterministically on both engines and on
 * both VFS families (`mem:measurements`, WRITELOCK-STUCK).
 *
 * `close()` is the escape a consumer has, and it did not work: it terminates
 * the workers and returns — reporting success — while still holding the lock.
 *
 * `IDBBatchAtomicVFS` on purpose: the defect is about a Web Lock and has
 * nothing to do with OPFS handles, so the VFS that cannot confuse the two is
 * the right one to pin it with.
 */

const VFS = 'IDBBatchAtomicVFS' as const;
const locks = createLocks();

const held = async (name: string) =>
  (await locks.entries()).held.some((entry) => entry.name === name);

/** A client whose transaction callback is inside and will never come back. */
const stuckTransaction = async (file: string) => {
  const db = createSQLiteClient(file, { vfs: VFS, drainTimeout: 500 });
  await db.write('CREATE TABLE IF NOT EXISTS t (v)');

  let entered!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  db.transaction(async (tx) => {
    await tx.write('INSERT INTO t VALUES (1)');
    entered();
    await new Promise<void>(() => {});
  }).catch(() => {});
  await inside;
  return db;
};

describe('the origin write lock is reclaimed', () => {
  it('close() releases the write lock a stuck transaction still holds', async () => {
    const file = `reclaim-${crypto.randomUUID()}.db`;
    onTestFinished(async () => {
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });

    const a = await stuckTransaction(file);
    expect(await held(writeLockName(VFS, file))).toBe(true);

    await a.close();

    expect(await held(writeLockName(VFS, file))).toBe(false);

    // Not merely absent from the registry: another client must be able to
    // write, which is the whole point of releasing it.
    const b = createSQLiteClient(file, { vfs: VFS });
    onTestFinished(async () => {
      await b.close().catch(() => {});
    });
    await expect(b.write('INSERT INTO t VALUES (2)')).resolves.toBeDefined();
  }, 30_000);
});

describe('a write that gives up says who was holding', () => {
  it('names another tab when the holder is in another realm', async () => {
    const file = `holder-other-${crypto.randomUUID()}.db`;
    onTestFinished(async () => {
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });

    const db = createSQLiteClient(file, { vfs: VFS });
    onTestFinished(async () => {
      await db.close().catch(() => {});
    });
    await db.write('CREATE TABLE IF NOT EXISTS t (v)');

    const realm = await makeRealm();
    const release = await holdIn(realm, writeLockName(VFS, file), 'exclusive');
    onTestFinished(() => release());

    const failure = await db
      .write('INSERT INTO t VALUES (1)', [], { timeout: 300 })
      .then(
        () => undefined,
        (error: unknown) => error as SQLiteError,
      );

    expect(failure).toBeInstanceOf(SQLiteError);
    expect(failure?.code).toBe('OPERATION_TIMEOUT');
    expect(failure?.timeout).toBe(300);
    expect(failure?.message).toContain('another tab');
  }, 30_000);

  it('names this tab when the holder is a transaction in this page', async () => {
    const file = `holder-self-${crypto.randomUUID()}.db`;
    onTestFinished(async () => {
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });

    const a = await stuckTransaction(file);
    onTestFinished(async () => {
      await a.close().catch(() => {});
    });

    const b = createSQLiteClient(file, { vfs: VFS });
    onTestFinished(async () => {
      await b.close().catch(() => {});
    });

    const failure = await b
      .write('INSERT INTO t VALUES (2)', [], { timeout: 300 })
      .then(
        () => undefined,
        (error: unknown) => error as SQLiteError,
      );

    expect(failure?.code).toBe('OPERATION_TIMEOUT');
    expect(failure?.message).toContain('this tab');
  }, 30_000);
});
