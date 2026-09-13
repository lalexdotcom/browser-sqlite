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

describe('a pool capped by its environment', () => {
  // T1. Falsifiable, three ways: a probe that always passes (Firefox then loses
  // three workers); a probe that always fails (Chromium then runs on one); the
  // probe sent to slot 0 as well (the client then fails — nothing opens).
  it('runs OPFSWriteAheadVFS on one worker without readwrite-unsafe, and warns once when poolSize was asked for', async () => {
    const warnings = captureWarnings();
    const records = interceptWorkers();
    const lost: number[] = [];
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
    const db = await createTestClient({ vfs: 'OPFSWriteAheadVFS' });
    await db.write('CREATE TABLE t (a)');
    expect(db.poolSize).toBe(CAPPED ? 1 : 2);
    expect(warnings).toEqual([]);
    await db.close();
  });

  // T3. Falsifiable: declare singleConnectionWithout on OPFSAdaptiveVFS.
  it('leaves OPFSAdaptiveVFS its whole pool: it rotates its handle', async () => {
    const lost: number[] = [];
    const db = await createTestClient({
      vfs: 'OPFSAdaptiveVFS',
      poolSize: 4,
      onWorkerLost: ({ index }) => lost.push(index),
    });
    await db.write('CREATE TABLE t (a)');
    expect(db.poolSize).toBe(4);
    expect(lost).toEqual([]);
    await db.close();
  });

  // T4. Falsifiable: report the requested poolSize as `size` — 4, not 1.
  (CAPPED ? it : it.skip)(
    'reports the effective size when the one remaining worker is lost',
    async () => {
      const records = interceptWorkers();
      const events: { size: number; live: number }[] = [];
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
      await db.close();
    },
  );

  // T5. Falsifiable: ignore `lastError` in the worker's final catch — the
  // cause then says `sqlite3_open_v2` and nothing else.
  it('reports the storage error behind a failed open', async () => {
    const file = `pool-cap-held-${crypto.randomUUID()}`;
    // A third party holds the file exclusively, then tries the VFS's own call
    // shape once: the error it gets is the oracle, measured on this engine.
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
    // An engine where the VFS's call shape coexists with an exclusive handle
    // gives this test nothing to observe.
    expect(oracle).not.toBeNull();

    const warnings = captureWarnings();
    const causes: Error[] = [];
    const db = createSQLiteClient(file, {
      vfs: 'OPFSWriteAheadVFS',
      poolSize: 1,
      onWorkerLost: ({ cause }) => causes.push(cause),
    });
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });
    expect(causes).toHaveLength(1);
    expect(causes[0]?.message).toContain(`sqlite3_open_v2: ${oracle}:`);
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
});
