import { describe, expect, it } from '@rstest/core';
import {
  defaultBuildFor,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';

describe('VFS_CAPABILITIES', () => {
  const names = Object.keys(VFS_CAPABILITIES) as SQLiteVFS[];

  it('declares every field for every VFS', () => {
    for (const vfs of names) {
      const cap = VFS_CAPABILITIES[vfs];
      expect(cap.builds.length).toBeGreaterThan(0);
      expect(['page-cache', 'whole-database']).toContain(cap.memoryModel);
      expect(typeof cap.multiConnection).toBe('boolean');
      expect(typeof cap.persistent).toBe('boolean');
    }
  });

  // Falsifiable: change `.builds[0]` to `.builds[1]` in defaultBuildFor.
  it('resolves the default build to the first declared one', () => {
    for (const vfs of names) {
      expect(defaultBuildFor(vfs)).toBe(VFS_CAPABILITIES[vfs].builds[0]);
    }
  });

  // Falsifiable: delete `maxPoolSize: 1` from the AccessHandlePoolVFS entry.
  it('caps AccessHandlePoolVFS at one worker and leaves the others uncapped', () => {
    expect(VFS_CAPABILITIES.AccessHandlePoolVFS.maxPoolSize).toBe(1);
    expect(VFS_CAPABILITIES.OPFSAdaptiveVFS.maxPoolSize).toBeNull();
  });

  // Falsifiable: set multiConnection to true on AccessHandlePoolVFS.
  it('records which VFS can share one database between connections', () => {
    expect(VFS_CAPABILITIES.AccessHandlePoolVFS.multiConnection).toBe(false);
    expect(VFS_CAPABILITIES.OPFSAdaptiveVFS.multiConnection).toBe(true);
  });

  // Falsifiable: delete poolLimitReason from the AccessHandlePoolVFS entry.
  it('gives every capped VFS a reason for its cap', () => {
    for (const vfs of names) {
      const cap = VFS_CAPABILITIES[vfs];
      if (cap.maxPoolSize !== null) {
        expect(cap.poolLimitReason).toBeTruthy();
      }
    }
  });
});

import {
  describeMissing,
  detectFeatures,
  KNOWN_FEATURES,
  missingFeature,
} from '../../src/capabilities';
import { BUILD_REQUIREMENTS, type PlatformFeature } from '../../src/types';

describe('platform requirements', () => {
  // Falsifiable: add a feature to any `requires` without adding a probe.
  // This is the invariant that would have caught `writable-stream` shipping
  // with no probe — ANYCONTEXT-1's exact gap.
  it('gives every declared feature either a probe or an explicit exemption', () => {
    const declared = new Set<PlatformFeature>();
    for (const cap of Object.values(VFS_CAPABILITIES)) {
      for (const f of cap.requires) declared.add(f);
      for (const f of cap.degradesWithout) declared.add(f);
    }
    for (const reqs of Object.values(BUILD_REQUIREMENTS)) {
      for (const f of reqs) declared.add(f);
    }

    expect(declared.size).toBeGreaterThan(0);
    for (const feature of declared) {
      expect(KNOWN_FEATURES.has(feature)).toBe(true);
    }
  });

  it('reports the first missing feature a pair requires', () => {
    // OPFSAdaptiveVFS requires opfs; the jspi build requires jspi.
    expect(missingFeature('OPFSAdaptiveVFS', 'async', new Set())).toBe('opfs');
    expect(missingFeature('OPFSAdaptiveVFS', 'jspi', new Set(['opfs']))).toBe(
      'jspi',
    );
    expect(
      missingFeature('OPFSAdaptiveVFS', 'async', new Set(['opfs'])),
    ).toBeNull();
  });

  it('needs nothing for a VFS that requires nothing', () => {
    // IDBBatchAtomicVFS declares `requires: []`.
    expect(missingFeature('IDBBatchAtomicVFS', 'async', new Set())).toBeNull();
  });

  it('requires writable-stream for OPFSAnyContextVFS', () => {
    expect(
      missingFeature('OPFSAnyContextVFS', 'async', new Set(['opfs'])),
    ).toBe('writable-stream');
  });

  // Falsifiable: remove 'readwrite-unsafe' from UNPROBEABLE.
  it('never reports readwrite-unsafe, which has no synchronous probe', () => {
    expect(
      missingFeature('OPFSWriteAheadVFS', 'sync', new Set(['opfs'])),
    ).toBeNull();
  });

  it('names an alternative build when the build is what is missing', () => {
    const message = describeMissing('OPFSAdaptiveVFS', 'jspi', 'jspi');
    expect(message).toContain("the 'jspi' build requires");
    expect(message).toContain('async');
  });

  it('names VFS that do not need the feature when the VFS is what is missing', () => {
    const message = describeMissing('OPFSAdaptiveVFS', 'async', 'opfs');
    expect(message).toContain('OPFSAdaptiveVFS requires');
    expect(message).toContain('IDBBatchAtomicVFS');
  });

  it('detects nothing in Node, where none of the globals exist', () => {
    expect(detectFeatures().has('opfs')).toBe(false);
  });
});

describe('VFS layout declarations', () => {
  // These are not documentation. `deleteDatabase` runs its OPFS removal pass
  // only for `opfs-path`, and OPFSCoopSyncVFS's jDelete truncates without
  // removing — so a wrong value here is a deletion that silently leaves the
  // file in place. Pinned by name, one line per VFS.
  it('names where each VFS keeps a database', () => {
    expect(VFS_CAPABILITIES.OPFSAdaptiveVFS.layout).toBe('opfs-path');
    expect(VFS_CAPABILITIES.OPFSAnyContextVFS.layout).toBe('opfs-path');
    expect(VFS_CAPABILITIES.OPFSCoopSyncVFS.layout).toBe('opfs-path');
    expect(VFS_CAPABILITIES.OPFSWriteAheadVFS.layout).toBe('opfs-path');
    expect(VFS_CAPABILITIES.AccessHandlePoolVFS.layout).toBe('opfs-pool');
    expect(VFS_CAPABILITIES.IDBBatchAtomicVFS.layout).toBe('idb-store');
    expect(VFS_CAPABILITIES.IDBMirrorVFS.layout).toBe('idb-store');
    expect(VFS_CAPABILITIES.MemoryVFS.layout).toBe('memory');
    expect(VFS_CAPABILITIES.MemoryAsyncVFS.layout).toBe('memory');
  });

  it('agrees with `storage` wherever both speak', () => {
    for (const cap of Object.values(VFS_CAPABILITIES)) {
      if (cap.layout === 'idb-store') expect(cap.storage).toBe('indexeddb');
      if (cap.layout === 'memory') expect(cap.storage).toBe('memory');
      if (cap.layout.startsWith('opfs-')) expect(cap.storage).toBe('opfs');
    }
  });
});
