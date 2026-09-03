import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../../src/client';
import { deleteDatabase } from '../../../src/delete';

/**
 * THIS FILE ASSERTS A PLATFORM DIFFERENCE, NOT A LIBRARY INVARIANT.
 *
 * On an engine without `readwrite-unsafe` access handles, a VFS in the
 * `opfs-path` family rotates ONE exclusive handle between workers. A write
 * transaction holds it for the whole of its callback, so a second client's
 * `open_v2` cannot get it and the slot fails on `openTimeout` — the readiness
 * gate reporting rather than silently serving a pool smaller than asked for.
 *
 * That is the failure the gate exists for, and it is the one the four tests in
 * `init.test.ts` do NOT exercise: those point a worker at a missing URL, which
 * is a LOAD failure. They pin the orchestration; this pins the phenomenon.
 *
 * It lives under `firefox/` because it cannot be written to pass on both
 * engines. Chromium gives each connection its own handle, so the same shape
 * opens in tens of milliseconds and asserts nothing. And it cannot be branched
 * on at runtime either: `readwrite-unsafe` is in `UNPROBEABLE`
 * (`capabilities.ts`) precisely because WebIDL ignores the unknown option and
 * asking whether it is supported answers yes and is wrong.
 *
 * **If this goes red, read it as news about Firefox, not as a bug here.** The
 * likeliest cause is that Firefox gained `readwrite-unsafe`, which would retire
 * reduced mode for the OPFS family and change what the README promises. That is
 * exactly the kind of platform movement this project wants to hear about.
 */

const VFS = 'OPFSAdaptiveVFS' as const;

describe('handle starvation during open (reduced mode)', () => {
  it('fails the second client with TIMEOUT while a write transaction holds the handle', async () => {
    const file = `starvation-${crypto.randomUUID()}.db`;
    onTestFinished(() => deleteDatabase(file, { vfs: VFS }).catch(() => {}));

    const holder = createSQLiteClient(file, { vfs: VFS, poolSize: 1 });
    await holder.write('CREATE TABLE t (v)');

    // Enter a write transaction and stay in it. This is what keeps the single
    // rotated exclusive handle away from every other connection on the origin.
    let leaveTransaction!: () => void;
    const held = new Promise<void>((resolve) => {
      leaveTransaction = resolve;
    });
    let transactionEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      transactionEntered = resolve;
    });

    const transaction = holder.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
      transactionEntered();
      await held;
    });
    await entered;

    // `openTimeout` well under the 30 s test budget: the point is that it
    // expires, not how long it takes to.
    const starved = createSQLiteClient(file, {
      vfs: VFS,
      poolSize: 1,
      openTimeout: 2000,
    });

    await expect(starved.read('SELECT 1')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    leaveTransaction();
    await transaction;
    await starved.close().catch(() => {});
    await holder.close();
  });
});
