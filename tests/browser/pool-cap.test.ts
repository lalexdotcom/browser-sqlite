/**
 * A pool the environment caps is capped, not lost (spec 2026-09-13).
 *
 * Shared by both engines. The arbiter is HAS_UNSAFE_HANDLES — a behavioural
 * oracle that opens two handles, independent of the library's own probe — so
 * no engine is named and the day Firefox or WebKit ships readwrite-unsafe these
 * tests follow it.
 */
import { describe, expect, it, onTestFinished } from '@rstest/core';
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
});
