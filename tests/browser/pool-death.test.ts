import { describe, expect, it } from '@rstest/core';
import { createLogger } from '../../src/logger';
import { createPoolWorker, type PoolWorker } from '../../src/pool';
import { SQLiteError } from '../../src/types/errors';
import { databasePath } from '../../src/utils';
import { removeDatabaseFiles, sleep, TEST_TARGET } from './helpers';

/**
 * A query posted to a worker that has already died, reached through
 * `createPoolWorker` directly, as tests/browser/pool-savepoint.test.ts does.
 */
const spawn = async (): Promise<{ worker: PoolWorker; file: string }> => {
  // Short: sqlite3_open_v2 refuses a name near the VFS's 64-byte path budget.
  const file = `pdt-${Date.now().toString(36)}`;
  const opened = await createPoolWorker({
    index: 0,
    pool: [] as (PoolWorker | undefined)[],
    clientName: 'pool-death',
    file: databasePath(TEST_TARGET.vfs, file),
    vfs: TEST_TARGET.vfs,
    build: TEST_TARGET.build,
    drainTimeout: 5000,
    logger: createLogger('test', false),
  });
  if ('declined' in opened)
    throw new Error(`worker declined to open: no ${opened.declined}`);
  return { worker: opened, file };
};

describe('a worker that has died', () => {
  // Falsifiable: drop the `if (dead)` line after `lost` is created in
  // src/pool.ts's runQuery — nothing ever settles the query's wait.
  it('rejects a query posted after its death with the death error', async () => {
    const { worker, file } = await spawn();
    try {
      const reason = new SQLiteError('WORKER_CRASHED', 'killed by the test');
      worker.terminate(reason);
      const outcome = await Promise.race([
        (async () => {
          for await (const _ of worker.query('SELECT 1')) {
            // drained
          }
          return 'resolved';
        })().catch((error: unknown) => error),
        sleep(2000).then(() => 'still waiting after 2 s'),
      ]);
      expect(outcome).toBe(reason);
    } finally {
      await removeDatabaseFiles(file, TEST_TARGET.vfs);
    }
  });
});
