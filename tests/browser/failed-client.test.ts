import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { connectionLockName } from '../../src/locks';
import { databasePath } from '../../src/utils';
import { interceptWorkers, pairFor, type Skip, sleep } from './helpers';

/**
 * A client that failed holds nothing: its workers are terminated and nothing
 * revives it, so the database is free before anyone calls `close()`.
 *
 * Declared `shared-storage`: a memory VFS has no connection lock to keep.
 */

/** A client whose only worker died with no restart left. */
const failedClient = async (skip: Skip) => {
  const pair = pairFor(['shared-storage'], skip);
  const name = `bsq-test-${crypto.randomUUID()}`;
  const options = { ...pair, poolSize: 1, maxWorkerRestarts: 0 };
  const records = interceptWorkers();
  const db = createSQLiteClient(name, options);
  onTestFinished(async () => {
    await db.close().catch(() => {});
    await deleteDatabase(name, pair).catch(() => {});
  });
  await db.write('CREATE TABLE t (a)');
  records[0]?.worker.dispatchEvent(new ErrorEvent('error'));
  await expect(db.read('SELECT 1')).rejects.toMatchObject({
    code: 'WORKER_CRASHED',
  });
  return { name, options, pair };
};

describe('a client that failed', () => {
  // Falsifiable: drop the connection release from failClient (src/client.ts) —
  // the delete is refused with DATABASE_IN_USE until the client is closed.
  it('lets the database be deleted, before close', async ({ skip }) => {
    const { name, pair } = await failedClient(skip);

    await expect(deleteDatabase(name, pair)).resolves.toBeUndefined();
  });

  // Falsifiable: the same — where the connection is exclusive, the next
  // client is refused with DATABASE_IN_USE.
  it('lets a new client open, before close', async ({ skip }) => {
    const { name, options } = await failedClient(skip);

    const next = createSQLiteClient(name, options);
    onTestFinished(() => next.close().catch(() => {}));
    const rows = await next.read<{ n: number }>(
      'SELECT count(*) AS n FROM sqlite_master',
    );
    expect(rows[0]?.n).toBe(1);
    // Closed here, so the failed client's cleanup can delete the database.
    await next.close();
  });

  // Falsifiable: in failClient, release the connection without refusing a
  // grant that lands after the failure — it is then held until close.
  // `shared-second-client`: an exclusive VFS starts its workers after the
  // grant, so a failure cannot race it there.
  it('holds no connection lock when the failure races its grant', async ({
    skip,
  }) => {
    const pair = pairFor(['shared-second-client'], skip);
    const name = `bsq-test-${crypto.randomUUID()}`;

    // Defers bsq:conn: grants until signaled.
    const originalRequest = (
      navigator.locks.request as (...args: unknown[]) => unknown
    ).bind(navigator.locks);
    let triggerGrant: () => void = () => {};
    const grantDeferred = new Promise<void>((resolve) => {
      triggerGrant = resolve;
    });
    (navigator.locks as unknown as Record<string, unknown>).request = (
      lockName: string,
      ...args: unknown[]
    ) => {
      if (lockName.startsWith('bsq:conn:')) {
        return grantDeferred.then(() => originalRequest(lockName, ...args));
      }
      return originalRequest(lockName, ...args);
    };
    onTestFinished(() => {
      (navigator.locks as unknown as Record<string, unknown>).request =
        originalRequest;
    });

    interceptWorkers({ url: '/definitely-missing-worker.js' });
    const db = createSQLiteClient(name, pair);
    onTestFinished(() => db.close().catch(() => {}));
    await expect(db.ready).rejects.toMatchObject({ code: 'WORKER_CRASHED' });

    triggerGrant();
    // A turn for the grant to land and be given back.
    await sleep(50);

    const { held = [] } = await navigator.locks.query();
    expect(held.map((lock) => lock.name)).not.toContain(
      connectionLockName(pair.vfs, databasePath(pair.vfs, name)),
    );
  });
});
