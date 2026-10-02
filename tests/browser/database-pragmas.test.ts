import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { VFS_CAPABILITIES } from '../../src/const/vfs';
import { deleteDatabase } from '../../src/delete';
import { pairFor, sleep } from './helpers';

/**
 * The pragmas that write the file — `user_version` here — run once per client,
 * through the write path, under the origin write lock. At open, on every
 * worker, they took the write lock of SQLite outside the library's own, and met
 * another client's write with `BUSY` (`mem:measurements`, PRAGMA-BUSY).
 *
 * `shared-second-client`: the collision needs two clients on one database.
 */
describe('a pragma that writes the database', () => {
  // Falsifiable: apply every pragma at open again (pass `pragmas` whole to the
  // workers) — B's worker meets A's open transaction, waits its busy_timeout
  // (100 ms, or none where the VFS refuses it), gets BUSY, and with no restart
  // left B fails.
  it("waits for another client's write instead of failing", async ({
    skip,
  }) => {
    const pair = pairFor(['shared-second-client'], skip);
    const name = `db-pragmas-${crypto.randomUUID()}`;
    onTestFinished(() => deleteDatabase(name, pair).catch(() => {}));

    const a = createSQLiteClient(name, { ...pair, poolSize: 1 });
    onTestFinished(() => a.close().catch(() => {}));
    await a.write('CREATE TABLE t (x)');

    // A holds its transaction open, past B's busy_timeout, after writing.
    const held = Promise.withResolvers<void>();
    const wrote = Promise.withResolvers<void>();
    const transaction = a.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
      wrote.resolve();
      await held.promise;
    });
    // Released and settled whatever fails below, so that closing A does not
    // reject a transaction nobody awaits.
    onTestFinished(async () => {
      held.resolve();
      await transaction.catch(() => {});
    });
    await wrote.promise;

    const b = createSQLiteClient(name, {
      ...pair,
      poolSize: 1,
      maxWorkerRestarts: 0,
      // Below A's hold, so that busy_timeout alone cannot be what passes.
      pragmas: {
        ...('busy_timeout' in VFS_CAPABILITIES[pair.vfs].refusedPragmas
          ? {}
          : { busy_timeout: '100' }),
        user_version: '7',
      },
    });
    onTestFinished(() => b.close().catch(() => {}));
    const read = b.read<{ user_version: number }>('PRAGMA user_version');

    await sleep(500);
    held.resolve();
    await transaction;

    expect((await read)[0]?.user_version).toBe(7);
  });

  // Falsifiable: let queries skip the wait for the client's database pragmas —
  // the first read can run before them and report 0.
  it("is in force before the client's first read", async ({ skip }) => {
    const pair = pairFor(['shared-second-client'], skip);
    const name = `db-pragmas-${crypto.randomUUID()}`;
    onTestFinished(() => deleteDatabase(name, pair).catch(() => {}));

    const db = createSQLiteClient(name, {
      ...pair,
      pragmas: { user_version: '7' },
    });
    onTestFinished(() => db.close().catch(() => {}));
    const rows = await db.read<{ user_version: number }>('PRAGMA user_version');
    expect(rows[0]?.user_version).toBe(7);
  });

  // A connection pragma applied at open, `query_only`, makes the write fail.
  // Falsifiable: rethrow from databaseSetup's catch instead of failing the
  // client — the query rejects, and `ready` never settles.
  it('fails the client with its statement error when SQLite refuses it', async ({
    skip,
  }) => {
    const pair = pairFor(['shared-second-client'], skip);
    const name = `db-pragmas-${crypto.randomUUID()}`;
    onTestFinished(() => deleteDatabase(name, pair).catch(() => {}));

    const db = createSQLiteClient(name, {
      ...pair,
      pragmas: { query_only: '1', user_version: '7' },
    });
    onTestFinished(() => db.close().catch(() => {}));
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'STATEMENT_FAILED',
    });
    await expect(db.ready).rejects.toMatchObject({ code: 'STATEMENT_FAILED' });
  });
});

/**
 * A pragma a VFS refuses: `busy_timeout` on OPFSCoopSyncVFS, whose `BUSY` asks
 * wa-sqlite to await a handle transfer that a busy wait never lets arrive — a
 * write after another client's schema change hung there (2026-10-01).
 */
describe('a pragma the VFS refuses', () => {
  const vfs = 'OPFSCoopSyncVFS';

  // Falsifiable: drop the check in createSQLiteClient.
  it('is refused at construction', () => {
    expect(() =>
      createSQLiteClient(`refused-${crypto.randomUUID()}`, {
        vfs,
        pragmas: { busy_timeout: '100' },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PRAGMA' }));
  });

  // Falsifiable: drop the check in write(), or in the transaction's checksql.
  it('is refused in a statement that sets it, in or out of a transaction', async () => {
    const name = `refused-${crypto.randomUUID()}`;
    onTestFinished(() => deleteDatabase(name, { vfs }).catch(() => {}));
    const db = createSQLiteClient(name, { vfs });
    onTestFinished(() => db.close().catch(() => {}));

    await expect(db.write('PRAGMA busy_timeout = 100')).rejects.toMatchObject({
      code: 'INVALID_PRAGMA',
    });
    await expect(
      db.transaction((tx) => tx.write('PRAGMA busy_timeout = 100')),
    ).rejects.toMatchObject({ code: 'INVALID_PRAGMA' });
    // Reading it is fine.
    await expect(db.read('PRAGMA busy_timeout')).resolves.toBeDefined();
  });
});
