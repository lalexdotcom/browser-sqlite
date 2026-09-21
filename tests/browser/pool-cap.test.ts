/**
 * A pool the environment caps is capped, not lost (spec 2026-09-13).
 *
 * Shared by both engines. The arbiter is HAS_UNSAFE_HANDLES — a behavioural
 * oracle that opens two handles, independent of the library's own probe — so
 * no engine is named and the day Firefox or WebKit ships readwrite-unsafe these
 * tests follow it.
 */
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { HAS_UNSAFE_HANDLES } from '../conformance/helpers';
import { createTestClient, interceptWorkers } from './helpers';

const CAPPED = !HAS_UNSAFE_HANDLES;

/** Replaces console.warn for the current test; returns what it received. */
const captureWarnings = () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  onTestFinished(() => {
    console.warn = original;
  });
  return warnings;
};

/**
 * Holds `file` open with an exclusive OPFS sync access handle from a second
 * worker — the way a real second client of the same database would — then
 * probes whether this engine's readwrite-unsafe call shape can coexist with
 * that exclusive handle. Returns the engine's own error name for that probe
 * (the oracle used to assert on the cause below), or null where it doesn't
 * conflict. Registers its own release/cleanup via onTestFinished.
 */
const holdFileExclusively = async (file: string): Promise<string | null> => {
  const src = `
      let held;
      self.onmessage = async (e) => {
        if (e.data === 'release') { held?.close(); self.postMessage('released'); return; }
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(e.data, { create: true });
        held = await fh.createSyncAccessHandle();
        try {
          const again = await fh.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
          again.close();
          self.postMessage(null);
        } catch (err) {
          self.postMessage(err.name);
        }
      };`;
  const holder = new Worker(
    URL.createObjectURL(new Blob([src], { type: 'text/javascript' })),
  );
  const ask = (message: string) =>
    new Promise<unknown>((resolve) => {
      holder.onmessage = (e) => resolve(e.data);
      holder.postMessage(message);
    });
  const oracle = (await ask(file)) as string | null;
  onTestFinished(async () => {
    await ask('release');
    holder.terminate();
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(file).catch(() => {});
  });
  return oracle;
};

describe('a pool capped by its environment', () => {
  // T1. Falsifiable, three ways: a probe that always passes (Firefox then loses
  // three workers); a probe that always fails (Chromium then runs on one); the
  // probe sent to slot 0 as well (the client then fails — nothing opens).
  it('runs OPFSWriteAheadVFS on one worker without readwrite-unsafe, and warns once when poolSize was asked for', async () => {
    const warnings = captureWarnings();
    const records = interceptWorkers();
    const lost: number[] = [];
    // One VFS: the subject is OPFSWriteAheadVFS's own environment cap.
    const db = await createTestClient({
      vfs: 'OPFSWriteAheadVFS',
      poolSize: 4,
      onWorkerLost: ({ index }) => lost.push(index),
    });
    await db.write('CREATE TABLE t (a)');

    expect(db.poolSize).toBe(CAPPED ? 1 : 4);
    expect(lost).toEqual([]);
    expect(warnings.filter((w) => w.includes(' lost;'))).toEqual([]);
    const capWarnings = warnings.filter((w) => w.includes('pool capped'));
    if (CAPPED) {
      expect(capWarnings).toHaveLength(1);
      expect(capWarnings[0]).toContain('without readwrite-unsafe');
      expect(capWarnings[0]).toContain('pool capped at 1 of 4');
      expect(records[0]?.received).toContain('ready');
      for (const record of records.slice(1)) {
        expect(record.received).toEqual(['declined']);
        expect(record.terminated).toBe(true);
      }
    } else {
      expect(capWarnings).toEqual([]);
    }
    await db.close();
  });

  // T2. Falsifiable: drop the "poolSize was passed" condition on the warning.
  it('caps silently when poolSize was left to its default', async () => {
    const warnings = captureWarnings();
    // One VFS: the subject is OPFSWriteAheadVFS's own environment cap.
    const db = await createTestClient({ vfs: 'OPFSWriteAheadVFS' });
    await db.write('CREATE TABLE t (a)');
    expect(db.poolSize).toBe(CAPPED ? 1 : 2);
    expect(warnings).toEqual([]);
    await db.close();
  });

  // T3. Falsifiable: remove OPFSAdaptiveVFS's singleConnectionWithout — Firefox then keeps 4.
  it('caps OPFSAdaptiveVFS too without readwrite-unsafe: a second worker would only wait its turn', async () => {
    const lost: number[] = [];
    // One VFS: the subject is OPFSAdaptiveVFS's own environment cap.
    const db = await createTestClient({
      vfs: 'OPFSAdaptiveVFS',
      poolSize: 4,
      onWorkerLost: ({ index }) => lost.push(index),
    });
    await db.write('CREATE TABLE t (a)');
    expect(db.poolSize).toBe(CAPPED ? 1 : 4);
    expect(lost).toEqual([]);
    await db.close();
  });

  // T4. Falsifiable: report the requested poolSize as `size` — 4, not 1.
  (CAPPED ? it : it.skip)(
    'reports the effective size when the one remaining worker is lost',
    async () => {
      const records = interceptWorkers();
      const events: { size: number; live: number }[] = [];
      // One VFS: the subject is OPFSWriteAheadVFS's own environment cap.
      const db = await createTestClient({
        vfs: 'OPFSWriteAheadVFS',
        poolSize: 4,
        maxWorkerRestarts: 0,
        onWorkerLost: ({ size, live }) => events.push({ size, live }),
      });
      await db.write('CREATE TABLE t (a)');
      records[0]?.worker.dispatchEvent(
        new ErrorEvent('error', { message: 'simulated worker failure' }),
      );
      expect(events).toEqual([{ size: 1, live: 0 }]);
      // The loss above must actually fail the client — the last worker is
      // gone, so a query issued afterwards has nothing left to run on.
      await expect(db.read('SELECT 1')).rejects.toMatchObject({
        code: 'WORKER_CRASHED',
      });
      await db.close();
    },
  );

  // T5. Falsifiable: ignore `lastError` in the worker's final catch — the
  // cause then says SQLite's own `unable to open database file` and nothing
  // else. The base message is deliberately NOT asserted: it belongs to
  // wa-sqlite, which changed it from the function name to the connection's
  // message in #330. What this test is about is the storage error behind it.
  it('reports the storage error behind a failed open', async () => {
    const file = `pool-cap-held-${crypto.randomUUID()}`;
    // A third party holds the file exclusively, then tries the VFS's own call
    // shape once: the error it gets is the oracle, measured on this engine.
    const oracle = await holdFileExclusively(file);
    // An engine where the VFS's call shape coexists with an exclusive handle
    // gives this test nothing to observe.
    expect(oracle).not.toBeNull();

    const warnings = captureWarnings();
    const causes: Error[] = [];
    // One VFS: the subject is OPFSWriteAheadVFS's own open-call shape and the
    // storage error it surfaces (holdFileExclusively above).
    const db = createSQLiteClient(file, {
      vfs: 'OPFSWriteAheadVFS',
      poolSize: 1,
      onWorkerLost: ({ cause }) => causes.push(cause),
    });
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });
    expect(causes).toHaveLength(1);
    expect(causes[0]?.message).toContain(`${oracle}:`);
    expect((causes[0]?.cause as { name?: string } | undefined)?.name).toBe(
      oracle,
    );
    expect(
      warnings.some((w) => w.includes(` lost;`) && w.includes(`${oracle}:`)),
    ).toBe(true);
    await db.close();
  });

  // Finding 1: close() during startup of a capped pool must not stall for the
  // full drainTimeout. A surplus worker still booting is told to decline; by
  // the time it does, retireSlot terminates it in the same checkpoint that
  // close()'s own worker.close() is awaiting a 'closed' reply the now-dead
  // worker can never send. Runs on both engines: on the uncapped engine
  // nothing declines, and close() should still be prompt and warning-free.
  // Falsifiers (checked once each while building this fix): removing
  // `deferredClose?.resolve()` from pool.ts's `poison` makes this take ~10 s
  // on Firefox; removing the `closing` guard in client.ts's `retireSlot`
  // makes Firefox capture a `pool capped` warning here.
  it('close() during startup of a capped pool returns promptly and does not warn', async () => {
    const warnings = captureWarnings();
    const file = `pool-cap-close-${crypto.randomUUID()}`;
    onTestFinished(async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(file, { recursive: true }).catch(() => {});
    });
    // One VFS: the subject is close() during startup of a pool capped by
    // OPFSWriteAheadVFS's own environment cap.
    const db = createSQLiteClient(file, {
      vfs: 'OPFSWriteAheadVFS',
      poolSize: 2,
      drainTimeout: 10_000,
    });
    const t0 = performance.now();
    await db.close();
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(warnings.filter((w) => w.includes('pool capped'))).toEqual([]);
  }, 15000);

  // Finding 2: a surplus slot that times out in round 1 and then declines in
  // the retry round must not be announced lost — spawn's `declined` branch
  // used to return before clearing `startupLosses`, so the entry round 1 left
  // behind for this slot survived into onGateOpen and was reported permanently
  // lost. Falsifier: removing `startupLosses.delete(index)` from the
  // `declined` branch reintroduces the loss.
  (CAPPED ? it : it.skip)(
    'a surplus slot that times out, then declines in the retry round, is not announced lost',
    async () => {
      const Original = globalThis.Worker;
      let created = 0;
      // Workers are constructed in slot-index order at startup, so the
      // second Worker ever created is slot 1's round-1 worker. Its 'open' is
      // held back past openTimeout below, so round 1 gives up on it; the
      // retry round constructs a THIRD worker for slot 1, left untouched
      // here, so it opens (and declines) immediately.
      class DelayingSlot1Open extends Original {
        constructor(url: string | URL, opts?: WorkerOptions) {
          super(url, opts);
          const n = created++;
          if (n === 1) {
            const post = this.postMessage.bind(this) as (m: unknown) => void;
            this.postMessage = ((m: { type?: string }) => {
              if (m?.type === 'open') {
                // Well past openTimeout below, so it never affects the
                // outcome — by the time it would fire, this worker is dead.
                setTimeout(() => {
                  try {
                    post(m);
                  } catch {}
                }, 15000);
                return;
              }
              post(m);
            }) as Worker['postMessage'];
          }
        }
      }
      globalThis.Worker = DelayingSlot1Open as unknown as typeof Worker;
      onTestFinished(() => {
        globalThis.Worker = Original;
      });

      const file = `pool-cap-retry-${crypto.randomUUID()}`;
      onTestFinished(async () => {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(file, { recursive: true }).catch(() => {});
      });

      const warnings = captureWarnings();
      const lost: unknown[] = [];
      // One VFS: the subject is a surplus slot declining under
      // OPFSWriteAheadVFS's own environment cap, during the retry round.
      const db = createSQLiteClient(file, {
        vfs: 'OPFSWriteAheadVFS',
        poolSize: 2,
        // Two budgets ride on this one number, and that is what made the test
        // flake under load (mem:follow-ups, 2026-09-16): it must be SHORT
        // enough that round 1 gives up on slot 1 well before the delayed
        // 'open' above would ever be delivered, and LONG enough that slot 0's
        // HEALTHY worker becomes ready inside it — otherwise the client fails
        // with "Worker 1 did not become ready within 600 ms", which is the
        // setup collapsing, not the subject.
        //
        // They are separable because the delay above is ours: scale the pair
        // and the subject's ordering holds while the healthy worker gets room.
        // Measured 2026-09-21 by squeezing this number on an idle machine
        // (firefox · OPFSWriteAheadVFS): 10, 25 and 50 ms all fail with that
        // very message, 100 ms passes — so slot 0 needs some tens of ms here,
        // and 600 ms was about a tenfold margin that a full matrix cell ate.
        // 3000 ms is ~50×, and the delayed open moves to 15000 to stay well
        // past it. The test costs one openTimeout in wall clock; that is the
        // price, and it is why this is not simply set to a minute.
        //
        // That the apparatus still describes what the title says was checked
        // at 3000 rather than assumed: the interception constructs exactly
        // THREE workers — slot 0, slot 1's round-1 worker, slot 1's retry —
        // and the pool settles at 1 with no loss and no warning.
        openTimeout: 3000,
        onWorkerLost: (e) => lost.push(e),
      });
      await db.write('CREATE TABLE t (a)');
      expect(lost).toEqual([]);
      expect(db.poolSize).toBe(1);
      expect(warnings.some((w) => w.includes(' lost;'))).toBe(false);
      await db.close();
    },
    // Room for the widened openTimeout above and the round that follows it.
    30000,
  );

  // Minor 5: the capped total-failure path had no browser coverage. Slot 0's
  // open genuinely fails (the file held exclusively, as in the test above)
  // while slots 1-3 decline (the environment cap) — the scheduler's gate only
  // opens once all four have settled, at which point openedCount is 0 and
  // this is a total startup failure with exactly one real loss: slot 0.
  // Falsifier (checked while building this fix): moving `effectivePoolSize -=
  // 1` in retireSlot to after `scheduler.retire(index)` does NOT turn this
  // red. Slot 0's own real open failure is what settles the gate last here
  // (it is slower than the three probe-and-decline round trips), so by the
  // time it fires, all three decline decrements have already run regardless
  // of where the line sits inside retireSlot. What DOES turn this red:
  // removing the decrement from retireSlot altogether — `size` then reports
  // 4, not 1.
  (CAPPED ? it : it.skip)(
    'reports exactly one loss, for slot 0, when the capped pool fails to open at all',
    async () => {
      const file = `pool-cap-total-${crypto.randomUUID()}`;
      const oracle = await holdFileExclusively(file);
      expect(oracle).not.toBeNull();

      const events: { index: number; size: number; live: number }[] = [];
      const causes: Error[] = [];
      // One VFS: the subject is the capped total-failure path under
      // OPFSWriteAheadVFS's own environment cap.
      const db = createSQLiteClient(file, {
        vfs: 'OPFSWriteAheadVFS',
        poolSize: 4,
        onWorkerLost: ({ index, size, live, cause }) => {
          events.push({ index, size, live });
          causes.push(cause);
        },
      });
      await expect(db.read('SELECT 1')).rejects.toMatchObject({
        code: 'WORKER_CRASHED',
      });
      expect(events).toEqual([{ index: 0, size: 1, live: 0 }]);
      expect(causes).toHaveLength(1);
      expect(causes[0]?.message).toContain(`${oracle}:`);
      await db.close();
    },
  );
});
