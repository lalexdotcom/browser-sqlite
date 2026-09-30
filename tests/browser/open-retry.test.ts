import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { databasePath } from '../../src/utils';
import { removeOpfsPath } from '../conformance/helpers';

/**
 * A VFS that takes an EXCLUSIVE OPFS access handle inside `xOpen` fails the
 * whole open when that handle is momentarily unavailable, and nothing retries.
 *
 * The condition is not hypothetical: a worker killed inside a `step()` keeps
 * its OPFS handles for up to ~2 s on Chromium (HANDLE-CORPSE,
 * `mem:measurements`), while its Web Locks are released at once — so the
 * replacement worker meets a file held by a context that no longer answers
 * anything. Measured 2026-09-18 on `chromium · OPFSCoopSyncVFS/sync`: the open
 * dies with `WORKER_CRASHED` — `jOpen`'s asynchronous phase meets the
 * `NoModificationAllowedError`, stores an invalid `PersistentFile`, and the
 * retried open returns `SQLITE_CANTOPEN`. The error then reached nobody but
 * the console; since wa-sqlite #357 it is kept in `lastError` and becomes the
 * failure's cause. Instrumented, the census said `held=none pending=none` (no lock
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
 *
 * **A hang fails naming its step**, with the holder's progress and both pools'
 * debug state; `mem:follow-ups` (`open-retry`) says what each step means.
 */

const VFS = 'OPFSCoopSyncVFS';
/** Long enough for the first acquisition to have failed, short enough to bind. */
const GRACE_MS = 30;
/** Nothing announced: release anyway rather than hang the test. */
const ANNOUNCE_TIMEOUT_MS = 1_000;
/** How long the holder waits out a handle the previous client has not released. */
const TAKE_BUDGET_MS = 3_000;
/** Under the 30 s test timeout, so a hang fails naming its step, not bare. */
const STALL_MS = 25_000;

/**
 * Holds an exclusive OPFS access handle on a file until told to release it.
 * A dedicated worker, because `createSyncAccessHandle` is worker-only — the
 * same reason the conformance probe uses one (`tests/conformance/helpers.ts`).
 */
const exclusiveHolder = () => {
  const src = `
    let handle = null;
    const step = (name) => self.postMessage({ step: name, t: performance.now() });
    const release = () => {
      if (!handle) return;
      try { handle.close(); } catch {}
      handle = null;
      self.postMessage('released');
    };
    step('booted');
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
          const segments = file.split('/');
          const name = segments.pop();
          step('getDirectory');
          let dir = await navigator.storage.getDirectory();
          for (const segment of segments) {
            dir = await dir.getDirectoryHandle(segment, { create: true });
          }
          step('getFileHandle');
          const fileHandle = await dir.getFileHandle(name, { create: true });
          step('createSyncAccessHandle');
          handle = await fileHandle.createSyncAccessHandle();
          step('held');
          break;
        } catch (e) {
          step('caught ' + e.name);
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
        step('armed');
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
  // Each step the holder reaches, with the page's clock, for a stall's report.
  const steps: string[] = [];
  const t0 = performance.now();
  worker.addEventListener(
    'message',
    (e: MessageEvent<string | { step: string; t: number }>) => {
      if (typeof e.data !== 'string') {
        steps.push(`${e.data.step} +${Math.round(performance.now() - t0)}ms`);
      }
    },
  );
  const once = (): Promise<string> =>
    new Promise((resolve) => {
      const onMessage = (e: MessageEvent<unknown>) => {
        if (typeof e.data !== 'string') return;
        worker.removeEventListener('message', onMessage);
        resolve(e.data);
      };
      worker.addEventListener('message', onMessage);
    });
  return {
    steps,
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

type Client = ReturnType<typeof createSQLiteClient>;

/** A client's pool as its debug state sees it: which workers opened, and the queue. */
const poolState = (client: Client | undefined): string => {
  const state = client?.debug;
  if (!state) return 'not created';
  const running = (w: (typeof state.workers)[number]) =>
    state.requests.some(
      (r) =>
        r.worker === w.index &&
        r.generation === w.generation &&
        r.acquireTime !== undefined &&
        r.endTime === undefined,
    );
  const workers = state.workers.map(
    (w) =>
      `worker ${w.index} ${w.status}` +
      (w.initializationTime === undefined ? ', never initialized' : '') +
      (running(w) ? ', a request in flight' : ''),
  );
  const { read, write, gated } = state.queue;
  return `${workers.join('; ') || 'no worker'}; queue read ${read} write ${write} gated ${gated}`;
};

/**
 * Races each step against one deadline under the test timeout, so a hang
 * fails with the step it hung in and `report()` taken at that moment.
 */
const stepsUnder = (report: () => string) => {
  const deadline = performance.now() + STALL_MS;
  const done: string[] = [];
  return async <T>(name: string, work: Promise<T>): Promise<T> => {
    const began = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          const ms = Math.round(performance.now() - began);
          const before = done.join(', ') || 'nothing';
          reject(
            new Error(
              `stalled in ${name} for ${ms} ms; done: ${before}; ${report()}`,
            ),
          );
        },
        Math.max(0, deadline - began),
      );
    });
    try {
      const value = await Promise.race([work, stalled]);
      done.push(`${name} ${Math.round(performance.now() - began)}ms`);
      return value;
    } finally {
      clearTimeout(timer);
    }
  };
};

describe('opening a database whose file is momentarily held', () => {
  it('succeeds once the holder lets go', async () => {
    const dbName = `bsq-test-${crypto.randomUUID()}`;
    let creator: Client | undefined;
    let holder: ReturnType<typeof exclusiveHolder> | undefined;
    let db: Client | undefined;
    const step = stepsUnder(
      () =>
        `holder: ${holder ? holder.steps.join(' > ') || 'no step' : 'not started'}` +
        `; creator: ${poolState(creator)}; db: ${poolState(db)}`,
    );

    // Create the database, so the open under test is an ordinary reopen.
    creator = createSQLiteClient(dbName, { vfs: VFS, debug: 'creator' });
    await step('creator.write', creator.write('CREATE TABLE t (a)'));
    await step('creator.close', creator.close());

    holder = exclusiveHolder();
    expect(
      await step('holder.take', holder.take(databasePath(VFS, dbName))),
    ).toBe('taken');

    db = createSQLiteClient(dbName, { vfs: VFS, debug: 'db' });
    // Not awaited before the holder is armed: the open has to start while the
    // handle is still held.
    try {
      const rows = await step(
        'db.read',
        db.read<{ n: number }>('SELECT 1 AS n'),
      );
      expect(rows[0]?.n).toBe(1);
    } finally {
      holder.dispose();
      await db.close().catch(() => {
        // The client may already have failed; the assertion above reports it.
      });
    }
  });
});

describe('opening a database whose file is refused for another reason', () => {
  // Falsifiable: retry whatever the refusal — the open then waits out
  // OPEN_RETRY_BUDGET_MS (2.5 s) before reporting what was never transient.
  it('fails without waiting out the retry budget', async () => {
    const dbName = `bsq-test-${crypto.randomUUID()}`;
    const path = databasePath(VFS, dbName);
    // A directory where the database file belongs: the VFS's getFileHandle
    // refuses it with a TypeMismatchError, which no wait will change.
    const segments = path.split('/');
    let dir = await navigator.storage.getDirectory();
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    onTestFinished(() => removeOpfsPath(path));

    const db = createSQLiteClient(dbName, { vfs: VFS });
    onTestFinished(() => db.close().catch(() => {}));
    const started = performance.now();
    const error = await db.read('SELECT 1').then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = performance.now() - started;

    expect(error).toMatchObject({ code: 'WORKER_CRASHED' });
    expect(elapsed).toBeLessThan(2_000);
  });
});
