import { inspectDatabase } from 'browser-sqlite';
import { describe, expect, it } from 'vitest';
import { sharedDatabase, TEST_TARGET } from '../helpers';

// The write-lock accounting `inspectDatabase` reports is generic — nothing
// here is specific to one VFS family — so the no-client case below follows
// the target, tagging only that the database outlives its worker.

describe('inspectDatabase write', () => {
  it('is empty when nobody writes', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const result = await inspectDatabase('quiet.db', {
      vfs: TEST_TARGET.vfs,
    });
    expect(result.write).toEqual({ tab: null, sameTab: false, waiting: 0 });
  });

  it('names the writing tab and counts who waits', {
    tags: ['requires:shared-second-client'],
  }, async () => {
    const shared = sharedDatabase();
    const a = shared.open();
    const b = shared.open();
    await a.write('CREATE TABLE t (v)');

    let seen: Awaited<ReturnType<typeof inspectDatabase>> | undefined;
    // Initialised inside the transaction callback; hoisted so we can await it
    // after the transaction without returning it from the callback (returning it
    // would deadlock: a's transaction holds the write lock that b is queued
    // behind, and the transaction cannot commit until the callback resolves).
    let queued: Promise<unknown> = Promise.resolve();

    const held = a.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');

      // b requests the write lock — because a's transaction holds it, this queues.
      // navigator.locks.request() is called synchronously inside locks.hold's
      // Promise constructor (before any microtask yield), so the pending entry
      // is normally visible on the very first inspectDatabase call. We still
      // poll to guard against any browser that defers the registration slightly.
      queued = b.write('INSERT INTO t VALUES (2)');

      for (let attempt = 0; attempt < 50; attempt++) {
        seen = await inspectDatabase(shared.name, { vfs: TEST_TARGET.vfs });
        if (seen.write.waiting >= 1) break;
        await new Promise<void>((r) => setTimeout(r, 20));
      }

      // Do NOT return or await `queued` here: the transaction holds the write lock
      // that `queued` is waiting for, so returning it would deadlock. Let the
      // transaction commit and release the lock; `queued` will run afterwards.
    });

    await held; // a committed; the write lock is now being released
    await queued; // b's write runs once the lock is free

    expect(seen?.write.tab).not.toBeNull();
    expect(seen?.write.sameTab).toBe(true);
    expect(seen?.write.waiting).toBe(1);
  });
});
