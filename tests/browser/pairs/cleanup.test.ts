import { describe, it } from 'vitest';
import { initLockName } from '../../../src/locks';
import { resolveDatabase } from '../../../src/utils';
import { sharedDatabase, TEST_TARGET } from '../helpers';

/**
 * The tests' cleanup deletes the database of every test (`cleanUp` in
 * tests/browser/helpers). `deleteDatabase` refuses with BUSY while an open is
 * in progress — documented as transient, to retry — and a worker the client
 * restarted, then terminated at close(), can hold the open lock a moment
 * longer: Chrome on GitHub's macOS 26 runner did (`verdict.test.ts`, the first
 * macOS matrix, 2026-11-03).
 */
describe('the cleanup', () => {
  // Falsifiable: in `cleanUp`, call deleteDatabase without first waiting for
  // the open lock — it meets the lock this test holds and fails with BUSY.
  it('waits for an open in progress before it deletes the database', {
    tags: ['vfs:AccessHandlePoolVFS', 'vfs:IDBBatchAtomicVFS'],
  }, async () => {
    const shared = sharedDatabase();
    const db = shared.open();
    await db.run('SELECT 1');
    await db.close();
    // An open in progress at cleanup: the open lock held 200 ms past the test.
    const { path } = resolveDatabase(shared.name, TEST_TARGET.vfs);
    const granted = Promise.withResolvers<void>();
    void navigator.locks.request(
      initLockName(TEST_TARGET.vfs, path),
      async () => {
        granted.resolve();
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
    );
    await granted.promise;
  });
});
