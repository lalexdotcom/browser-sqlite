import { describe, expect, it } from '@rstest/core';
import { missingFeature } from '../../src/capabilities';
import { BUILD_CAPABILITIES, type SQLiteBuild } from '../../src/const/builds';
import type { PlatformFeature } from '../../src/const/platform';
import {
  folderOf,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/const/vfs';
import {
  type Here,
  type Need,
  resolvePair,
  type TestTarget,
} from '../browser/target';

const here = (features: readonly PlatformFeature[]): Here => ({
  features: new Set(features),
});

const pair = (vfs: SQLiteVFS, build: SQLiteBuild): TestTarget => ({
  vfs,
  build,
});

/** Firefox as the suite meets it: OPFS, no `readwrite-unsafe`, not isolated. */
const WITHOUT_UNSAFE = here(['opfs', 'writable-stream', 'web-locks']);
/** Chromium as the suite meets it, not isolated. */
const WITH_UNSAFE = here([
  'opfs',
  'readwrite-unsafe',
  'writable-stream',
  'web-locks',
]);

describe('resolvePair', () => {
  it('returns the target itself when it runs here and nothing is needed', () => {
    // Falsifiable: a resolver that moves a runnable target without a need, or
    // that tries any other candidate before the target, turns this red.
    for (const target of [
      pair('OPFSAdaptiveVFS', 'async'),
      pair('OPFSWriteAheadVFS', 'sync'),
    ]) {
      expect(
        missingFeature(target.vfs, target.build, WITHOUT_UNSAFE.features),
      ).toBeNull();
      expect(resolvePair(target, [], WITHOUT_UNSAFE)).toEqual(target);
    }
  });

  it('moves an interruptible test off a sync build to the same VFS on its next build', () => {
    // Falsifiable: ignoring `interruptible`, or trying the recommended VFS
    // before the target's own other builds, turns this red.
    expect(
      resolvePair(
        pair('OPFSWriteAheadVFS', 'sync'),
        ['interruptible'],
        WITH_UNSAFE,
      ),
    ).toEqual(pair('OPFSWriteAheadVFS', 'async'));
  });

  it('keeps an interruptible test on a sync build under cross-origin isolation', () => {
    // Falsifiable: an `interruptible` that ignores `crossOriginIsolated` and
    // calls every sync build uninterruptible turns this red.
    const isolated = here([...WITH_UNSAFE.features, 'cross-origin-isolated']);
    expect(
      resolvePair(
        pair('OPFSWriteAheadVFS', 'sync'),
        ['interruptible'],
        isolated,
      ),
    ).toEqual(pair('OPFSWriteAheadVFS', 'sync'));
  });

  it('moves a two-worker test off a recommended VFS that runs one worker here', () => {
    // Falsifiable: ignoring `two-workers`, reading `maxPoolSize` alone and not
    // `singleConnectionWithout`, or trying the other VFS in plain key order
    // instead of the target's `storage` first (IDBBatchAtomicVFS precedes
    // OPFSAnyContextVFS there) turns this red.
    expect(
      resolvePair(
        pair('OPFSAdaptiveVFS', 'async'),
        ['two-workers'],
        WITHOUT_UNSAFE,
      ),
    ).toEqual(pair('OPFSAnyContextVFS', 'async'));
  });

  it('keeps a two-worker test on the target where readwrite-unsafe exists', () => {
    // Falsifiable: a `two-workers` that rejects every VFS declaring a
    // `singleConnectionWithout` feature, present here or not, turns this red.
    expect(
      resolvePair(
        pair('OPFSAdaptiveVFS', 'async'),
        ['two-workers'],
        WITH_UNSAFE,
      ),
    ).toEqual(pair('OPFSAdaptiveVFS', 'async'));
  });

  it('moves a shared-second-client test off OPFSWriteAheadVFS without readwrite-unsafe', () => {
    // Firefox: that VFS refuses a second client there, so a test of two
    // clients on one database cannot run on it (spec 2026-09-15, A6).
    // Falsifiable: a `shared-second-client` that reads only
    // `exclusiveConnection` — true for AccessHandlePoolVFS alone — leaves this
    // on OPFSWriteAheadVFS and turns it red.
    const moved = resolvePair(
      pair('OPFSWriteAheadVFS', 'sync'),
      ['shared-second-client'],
      WITHOUT_UNSAFE,
    );
    expect(moved).not.toBeNull();
    expect(moved?.vfs).not.toBe('OPFSWriteAheadVFS');
    expect(VFS_CAPABILITIES[moved?.vfs as SQLiteVFS].storage).not.toBe(
      'memory',
    );
  });

  it('keeps a shared-second-client test on OPFSWriteAheadVFS where that feature exists', () => {
    // Chromium: the same VFS shares there, so the target stays.
    expect(
      resolvePair(
        pair('OPFSWriteAheadVFS', 'sync'),
        ['shared-second-client'],
        WITH_UNSAFE,
      ),
    ).toEqual(pair('OPFSWriteAheadVFS', 'sync'));
  });

  it('moves an in-place-file test off OPFSWriteAheadVFS, whose write-ahead files keep their size', () => {
    // Falsifiable: an `in-place-file` that reads only `folder` leaves this on
    // OPFSWriteAheadVFS and turns it red.
    const moved = resolvePair(
      pair('OPFSWriteAheadVFS', 'sync'),
      ['in-place-file'],
      WITH_UNSAFE,
    );
    expect(moved).not.toBeNull();
    expect(moved?.vfs).not.toBe('OPFSWriteAheadVFS');
    expect(folderOf(moved?.vfs as SQLiteVFS)).toBeDefined();
  });

  it('keeps an in-place-file test on a VFS that writes its database in place', () => {
    expect(
      resolvePair(
        pair('OPFSAnyContextVFS', 'async'),
        ['in-place-file'],
        WITH_UNSAFE,
      ),
    ).toEqual(pair('OPFSAnyContextVFS', 'async'));
  });

  it('never leaves a shared-second-client test on a VFS that isolates or refuses', () => {
    // Falsifiable: drop the `layout !== 'memory'` clause and the memory
    // targets resolve to themselves, where two clients are two databases.
    for (const target of [
      pair('MemoryVFS', 'sync'),
      pair('MemoryAsyncVFS', 'async'),
      pair('AccessHandlePoolVFS', 'sync'),
    ]) {
      const resolved = resolvePair(
        target,
        ['shared-second-client'],
        WITH_UNSAFE,
      );
      expect(resolved).not.toBeNull();
      expect(resolved?.vfs).not.toBe(target.vfs);
    }
  });

  it('never returns a pair that needs a feature missing here', () => {
    // Falsifiable: a qualification that skips a candidate VFS's own `requires`
    // returns OPFSWriteAheadVFS/async here, where there is no OPFS at all.
    expect(
      resolvePair(
        pair('MemoryVFS', 'sync'),
        ['interruptible', 'two-workers'],
        here(['readwrite-unsafe', 'web-locks']),
      ),
    ).toEqual(pair('IDBBatchAtomicVFS', 'async'));

    const needSets: readonly (readonly Need[])[] = [
      [],
      ['interruptible'],
      ['two-workers'],
      ['interruptible', 'two-workers'],
    ];
    for (const vfs of Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]) {
      for (const build of VFS_CAPABILITIES[vfs].builds) {
        for (const needs of needSets) {
          for (const where of [WITHOUT_UNSAFE, WITH_UNSAFE, here([])]) {
            const found = resolvePair(pair(vfs, build), needs, where);
            if (found === null) continue;
            const required: readonly PlatformFeature[] = [
              ...VFS_CAPABILITIES[found.vfs].requires,
              ...BUILD_CAPABILITIES[found.build].requires,
            ];
            expect(
              required.filter((feature) => !where.features.has(feature)),
            ).toEqual([]);
          }
        }
      }
    }
  });

  it('returns null for a target this browser cannot run, even when another pair would do', () => {
    // Falsifiable: a resolver that lets an unrunnable target fall back to
    // another pair turns this red — and a matrix would then report green a
    // pair that never ran.
    const target = pair('OPFSAdaptiveVFS', 'jspi');
    const noJspi = here([
      'opfs',
      'readwrite-unsafe',
      'writable-stream',
      'web-locks',
    ]);
    expect(missingFeature(target.vfs, target.build, noJspi.features)).toBe(
      BUILD_CAPABILITIES.jspi.requires[0],
    );
    expect(resolvePair(target, [], noJspi)).toBeNull();
    expect(resolvePair(target, ['interruptible'], noJspi)).toBeNull();
    // The same target where its feature exists: the nulls above are the guard's.
    expect(
      resolvePair(
        target,
        [],
        here([...noJspi.features, ...BUILD_CAPABILITIES.jspi.requires]),
      ),
    ).toEqual(target);
  });
});

describe("resolvePair under 'skip'", () => {
  it('skips a test whose need the target lacks, where fallback would move it', () => {
    // Falsifiable: a resolver that falls back under 'skip' too turns this red
    // — the matrix would again report a failure under the wrong pair's name.
    const target = pair('OPFSAdaptiveVFS', 'async');
    expect(resolvePair(target, ['two-workers'], WITHOUT_UNSAFE)).toEqual(
      pair('OPFSAnyContextVFS', 'async'),
    );
    expect(resolvePair(target, ['two-workers'], WITHOUT_UNSAFE, 'skip')).toBe(
      'skip',
    );
  });

  it('keeps a test on the target that has its need', () => {
    // Falsifiable: a 'skip' that skips whenever a need is declared turns this red.
    const target = pair('OPFSAdaptiveVFS', 'async');
    expect(resolvePair(target, ['two-workers'], WITH_UNSAFE, 'skip')).toEqual(
      target,
    );
    expect(resolvePair(target, [], WITHOUT_UNSAFE, 'skip')).toEqual(target);
  });

  it('returns null, not a skip, for a target this browser cannot run', () => {
    // Falsifiable: checking the needs before the target's own requirements
    // turns this red — the matrix would call skipped a pair that never ran,
    // instead of "not runnable here".
    const target = pair('OPFSAdaptiveVFS', 'jspi');
    const noJspi = here([
      'opfs',
      'readwrite-unsafe',
      'writable-stream',
      'web-locks',
    ]);
    expect(resolvePair(target, ['two-workers'], noJspi, 'skip')).toBeNull();
    expect(resolvePair(target, [], noJspi, 'skip')).toBeNull();
  });
});
