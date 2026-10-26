import { createSQLiteClient, deleteDatabase } from 'browser-sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { connectionLockName } from '../../../src/locks';
import { databasePath } from '../../../src/utils';
import { interceptWorkers, sleep, TEST_TARGET, waitUntil } from '../helpers';

/**
 * A client that failed holds nothing: its workers are terminated and nothing
 * revives it, so the database is free before anyone calls `close()`.
 *
 * Tagged `requires:shared-storage`: a memory VFS has no connection lock to keep.
 */

/** A client whose only worker died with no restart left. */
const failedClient = async () => {
  const pair = { vfs: TEST_TARGET.vfs, build: TEST_TARGET.build };
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
  it('lets the database be deleted, before close', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const { name, pair } = await failedClient();

    await expect(deleteDatabase(name, pair)).resolves.toBeUndefined();
  });

  // Falsifiable: the same — where the connection is exclusive, the next
  // client is refused with DATABASE_IN_USE.
  it('lets a new client open, before close', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const { name, options } = await failedClient();

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
  // `requires:shared-second-client`: an exclusive VFS starts its workers after the
  // grant, so a failure cannot race it there.
  it('holds no connection lock when the failure races its grant', {
    tags: ['requires:shared-second-client'],
  }, async () => {
    const pair = { vfs: TEST_TARGET.vfs, build: TEST_TARGET.build };
    const name = `bsq-test-${crypto.randomUUID()}`;

    // A VFS whose exclusivity worker 0 probes (OPFSWriteAheadVFS) requests
    // bsq:conn only once the page knows the answer: from a worker 0, or from
    // the realm's memo. The failed client's worker never answers, so without
    // the memo no grant is ever requested and there is no race to test. A
    // healthy client on another database fills the memo first; the test no
    // longer depends on which tests ran before it in this page.
    const warmName = `bsq-test-${crypto.randomUUID()}`;
    const warm = createSQLiteClient(warmName, pair);
    await warm.read('SELECT 1');
    await warm.close();
    onTestFinished(() => deleteDatabase(warmName, pair).catch(() => {}));

    // Defers bsq:conn: grants until signaled, and records when one lands.
    const originalRequest = (
      navigator.locks.request as (...args: unknown[]) => unknown
    ).bind(navigator.locks);
    let triggerGrant: () => void = () => {};
    const grantDeferred = new Promise<void>((resolve) => {
      triggerGrant = resolve;
    });
    let grantLanded = false;
    (navigator.locks as unknown as Record<string, unknown>).request = (
      lockName: string,
      ...args: unknown[]
    ) => {
      if (lockName.startsWith('bsq:conn:')) {
        const callback = args.pop() as (lock: Lock | null) => unknown;
        return grantDeferred.then(() =>
          originalRequest(lockName, ...args, (lock: Lock | null) => {
            grantLanded = true;
            return callback(lock);
          }),
        );
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
    // Waited for, not slept on: the grant lands in a task of its own, and
    // after a stall of the main thread a due timer can run first — a query
    // sent then finds the lock granted and not yet given back.
    await waitUntil(() => grantLanded, 'the connection grant to land');

    // The release reaches the browser on the lock's own channel, which is not
    // ordered with query(): polled, bounded.
    const lockName = connectionLockName(pair.vfs, databasePath(pair.vfs, name));
    const heldNames = async () =>
      ((await navigator.locks.query()).held ?? []).map((lock) => lock.name);
    const deadline = Date.now() + 2000;
    while ((await heldNames()).includes(lockName) && Date.now() < deadline) {
      await sleep(10);
    }
    expect(await heldNames()).not.toContain(lockName);
  });
});
