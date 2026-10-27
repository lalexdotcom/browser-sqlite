import { inspectDatabase, SQLiteError } from 'browser-sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  interceptWorkers,
  scaled,
  sharedDatabase,
  TEST_TARGET,
} from '../helpers';

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
    await a.run('CREATE TABLE t (v)');
    // Run once while the lock is free: b remembers the statement's verdict, so
    // the run below queues on the write lock and not on a verdict.
    await b.run('INSERT INTO t VALUES (2)');

    let seen: Awaited<ReturnType<typeof inspectDatabase>> | undefined;
    // Initialised inside the transaction callback; hoisted so we can await it
    // after the transaction without returning it from the callback (returning it
    // would deadlock: a's transaction holds the write lock that b is queued
    // behind, and the transaction cannot commit until the callback resolves).
    let queued: Promise<unknown> = Promise.resolve();

    const held = a.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)');

      // b requests the write lock — because a's transaction holds it, this queues.
      // navigator.locks.request() is called synchronously inside locks.hold's
      // Promise constructor (before any microtask yield), so the pending entry
      // is normally visible on the very first inspectDatabase call. We still
      // poll to guard against any browser that defers the registration slightly.
      queued = b.run('INSERT INTO t VALUES (2)');

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

// A cold verdict can wait on the file lock inside its prepare (a VFS with one
// access handle, while another client's transaction holds it). The tests hold
// the verdict at the worker's door instead, so every target waits the same way.
describe('a verdict that gives up says who was holding', () => {
  const setUp = async () => {
    const records = interceptWorkers();
    const shared = sharedDatabase();
    const a = shared.open();
    await a.run('CREATE TABLE t (v)');
    const mine = records.length;
    const b = shared.open();
    // first() asks no verdict: it brings b's workers up with a cold memo.
    await b.first('SELECT 1');

    const held: Array<() => void> = [];
    let holding = true;
    // Only b's workers: a's transaction asks its own verdicts.
    for (const record of records.slice(mine)) {
      const post = record.worker.postMessage.bind(record.worker) as (
        message: unknown,
        ...rest: unknown[]
      ) => void;
      record.worker.postMessage = ((message: unknown, ...rest: unknown[]) => {
        const type = (message as { type?: string })?.type;
        if (holding && type === 'verdict')
          held.push(() => post(message, ...rest));
        else post(message, ...rest);
      }) as typeof record.worker.postMessage;
    }
    const release = () => {
      holding = false;
      for (const post of held.splice(0)) post();
    };

    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const transaction = a.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)');
      entered();
      await gate;
    });
    await inside;
    // A failed case must not leave the lock held and the verdicts parked.
    onTestFinished(() => {
      commit();
      release();
    });
    return { a, b, transaction, commit, release, held };
  };

  // Falsifiable: drop the explanation in kindFor in src/client.ts.
  it('names this tab when the holder is a transaction in this page', {
    tags: ['requires:shared-second-client'],
    timeout: scaled(30_000),
  }, async () => {
    const { b, transaction, commit, release, held } = await setUp();

    const failure = await b
      .run('INSERT INTO t VALUES (2)', [], { timeout: 300 })
      .then(
        () => undefined,
        (error: unknown) => error as SQLiteError,
      );

    // The verdict was asked and is parked, or the case is not exercised.
    expect(held.length).toBeGreaterThan(0);
    expect(failure).toBeInstanceOf(SQLiteError);
    expect(failure?.code).toBe('OPERATION_TIMEOUT');
    expect(failure?.timeout).toBe(300);
    expect(failure?.message).toContain('this tab');

    commit();
    await transaction;
    release();
    await expect(b.run('INSERT INTO t VALUES (3)')).resolves.toBeDefined();
  });

  // Falsifiable: wrap every rejection of the wait in kindFor's catch in a new
  // error, not only the deadline this library minted.
  it("returns a caller's own abort reason as it is", {
    tags: ['requires:shared-second-client'],
    timeout: scaled(30_000),
  }, async () => {
    const { b, transaction, commit, release } = await setUp();
    const reason = new Error('the caller gave up');
    const ctl = new AbortController();
    const waiting = b.run('INSERT INTO t VALUES (2)', [], {
      signal: ctl.signal,
    });
    ctl.abort(reason);
    await expect(waiting).rejects.toBe(reason);

    commit();
    await transaction;
    release();
  });

  // Falsifiable: drop the explanation in kindFor in src/client.ts.
  it('names this tab on a stream too', {
    tags: ['requires:shared-second-client'],
    timeout: scaled(30_000),
  }, async () => {
    const { b, transaction, commit, release } = await setUp();

    const failure = await (async () => {
      for await (const _row of b.stream('INSERT INTO t VALUES (2)', [], {
        timeout: 300,
      })) {
        // Never reached: the verdict does not come.
      }
    })().then(
      () => undefined,
      (error: unknown) => error as SQLiteError,
    );

    expect(failure?.code).toBe('OPERATION_TIMEOUT');
    expect(failure?.message).toContain('this tab');

    commit();
    await transaction;
    release();
  });
});
