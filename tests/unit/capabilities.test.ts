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
