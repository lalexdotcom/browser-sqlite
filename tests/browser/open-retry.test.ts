import { describe, expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';

/**
 * A VFS that takes an EXCLUSIVE OPFS access handle inside `xOpen` fails the
 * whole open when that handle is momentarily unavailable, and nothing retries.
 *
 * The condition is not hypothetical: a worker killed inside a `step()` keeps
 * its OPFS handles for up to ~2 s on Chromium (HANDLE-CORPSE,
 * `mem:measurements`), while its Web Locks are released at once — so the
 * replacement worker meets a file held by a context that no longer answers
 * anything. Measured 2026-09-18 on `chromium · OPFSCoopSyncVFS/sync`: the open
 * dies with `WORKER_CRASHED: sqlite3_open_v2`, and the cause never reaches the
 * caller because wa-sqlite swallows it — `jOpen`'s asynchronous phase logs the
 * `NoModificationAllowedError` to the console, stores an invalid
 * `PersistentFile`, and the retried open returns `SQLITE_CANTOPEN` with no
 * `lastError`. Instrumented, the census said `held=none pending=none` (no lock
 * anywhere: the holder is dead) and a replayed attempt on the same VFS instance
 * succeeded in 4-14 ms, 4 times out of 4.
 *
 * The real occurrence is intermittent — 5 reproductions in 14 full-cell runs,
 * because the replacement worker's boot consumes most of the corpse's window.
 * This test makes it deterministic by holding the handle itself: the window is
 * the test's, not the engine's, so what is pinned here is that the open
 * RETRIES, never how long it is willing to wait.
 *
 * **One VFS, named on purpose.** The defect needs an exclusive handle taken at
 * `xOpen`. `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS` open theirs with
 * `mode: 'readwrite-unsafe'`, so a dead holder blocks nothing;
 * `AccessHandlePoolVFS` is exclusive but acquires at VFS-instance creation,
 * which `createVfsInstance` already retries (`3755805`). `OPFSCoopSyncVFS` is
 * the only VFS meeting both conditions, so it is named here rather than
 * discovered through the target — holding a handle in the wrong mode would
 * redden targets that the defect cannot reach.
 *
 * **The release is driven by the VFS's own signal, not by a delay.** A first
 * version released the handle 50 ms after the open began and was green on
 * Firefox for the wrong reason: the worker's boot outlasts 50 ms there, so the
 * open never met a held file at all. `OPFSCoopSyncVFS` announces that it wants
 * the handle on a `BroadcastChannel` named after the file, which is the
 * protocol it already uses between clients; the holder waits for that
 * announcement, lets the attempt fail, and only then lets go.
 *
 * **`GRACE_MS` is a floor on the fix, and a deliberate one.** It is the pause
 * between the announcement and the release, so an open that gives up inside it
 * stays red. The measured need is far smaller (4-14 ms); nothing here argues
 * for a large budget.
 */

const VFS = 'OPFSCoopSyncVFS';
/** Long enough for the first acquisition to have failed, short enough to bind. */
const GRACE_MS = 30;
/** Nothing announced: release anyway rather than hang the test. */
const ANNOUNCE_TIMEOUT_MS = 1_000;
/** How long the holder waits out a handle the previous client has not released. */
const TAKE_BUDGET_MS = 3_000;

/**
 * Holds an exclusive OPFS access handle on a file until told to release it.
 * A dedicated worker, because `createSyncAccessHandle` is worker-only — the
 * same reason the conformance probe uses one (`tests/conformance/helpers.ts`).
 */
const exclusiveHolder = () => {
  const src = `
    let handle = null;
    const release = () => {
      if (!handle) return;
      try { handle.close(); } catch {}
      handle = null;
      self.postMessage('released');
    };
    self.onmessage = async (event) => {
      const { type, file, graceMs, timeoutMs, takeBudgetMs } = event.data;
      if (type !== 'take') return;
      // Retried, because the client the test just closed can still hold this
      // file: its worker is gone, but the engine reclaims OPFS handles a
      // moment later (HANDLE-CORPSE). That window is the test's own setup
      // meeting the very condition the test is about, and losing it made the
      // run red on something that is not the subject — seen once on Firefox
      // in a full cell, then not reproduced in 8 cells and 8 loaded runs.
      const deadline = Date.now() + takeBudgetMs;
      for (;;) {
        try {
          const root = await navigator.storage.getDirectory();
          const fileHandle = await root.getFileHandle(file, { create: true });
          handle = await fileHandle.createSyncAccessHandle();
          break;
        } catch (e) {
          if (e.name !== 'NoModificationAllowedError' || Date.now() >= deadline) {
            self.postMessage('failed: ' + e.name);
            return;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      // The VFS announces that it wants this file on its own channel; let the
      // announcement land, let its attempt fail, then let go.
      const channel = new BroadcastChannel('ahp:/' + file);
      let armed = false;
      const arm = () => {
        if (armed) return;
        armed = true;
        setTimeout(() => {
          channel.close();
          release();
        }, graceMs);
      };
      channel.onmessage = arm;
      setTimeout(arm, timeoutMs);
      self.postMessage('taken');
    };
  `;
  const url = URL.createObjectURL(
    new Blob([src], { type: 'application/javascript' }),
  );
  const worker = new Worker(url);
  const once = (): Promise<string> =>
    new Promise((resolve) => {
      worker.addEventListener(
        'message',
        (e: MessageEvent<string>) => resolve(e.data),
        { once: true },
      );
    });
  return {
    take: async (file: string) => {
      const answer = once();
      worker.postMessage({
        type: 'take',
        file,
        graceMs: GRACE_MS,
        timeoutMs: ANNOUNCE_TIMEOUT_MS,
        takeBudgetMs: TAKE_BUDGET_MS,
      });
      return answer;
    },
    dispose: () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
};

describe('opening a database whose file is momentarily held', () => {
  it('succeeds once the holder lets go', async () => {
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;

    // Create the database, so the open under test is an ordinary reopen.
    const creator = createSQLiteClient(dbName, { vfs: VFS });
    await creator.write('CREATE TABLE t (a)');
    await creator.close();

    const holder = exclusiveHolder();
    expect(await holder.take(dbName)).toBe('taken');

    const db = createSQLiteClient(dbName, { vfs: VFS });
    // Not awaited before the holder is armed: the open has to start while the
    // handle is still held.
    try {
      const rows = await db.read<{ n: number }>('SELECT 1 AS n');
      expect(rows[0]?.n).toBe(1);
    } finally {
      holder.dispose();
      await db.close().catch(() => {
        // The client may already have failed; the assertion above reports it.
      });
    }
  });
});
