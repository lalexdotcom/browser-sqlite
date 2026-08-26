import { describe, expect, it } from '@rstest/core';
import * as api from '../../src/index';

/**
 * The benchmark page enumerates VFS from the library at runtime instead of
 * holding a copy that would drift. That only works if the table is reachable
 * from the package entry, which it was not: `SQLiteVFS` named the type of a
 * public option that no consumer could name.
 */
describe('public entry', () => {
  // Falsifiable: re-export DEFAULT_VFS from src/index.ts.
  it('exposes the capability table and its default-build helper, but no default VFS', () => {
    expect(typeof api.VFS_CAPABILITIES).toBe('object');
    expect(typeof api.defaultBuildFor).toBe('function');
    expect('DEFAULT_VFS' in api).toBe(false);
    expect('RECOMMENDED_VFS' in api).toBe(false);
  });

  // Falsifiable: drop one VFS from VFS_CAPABILITIES.
  it('exposes every wired VFS', () => {
    expect(Object.keys(api.VFS_CAPABILITIES).sort()).toEqual(
      [
        'AccessHandlePoolVFS',
        'IDBBatchAtomicVFS',
        'IDBMirrorVFS',
        'MemoryAsyncVFS',
        'MemoryVFS',
        'OPFSAdaptiveVFS',
        'OPFSAnyContextVFS',
        'OPFSCoopSyncVFS',
        'OPFSWriteAheadVFS',
      ].sort(),
    );
  });

  // Falsifiable: delete the createSQLiteClient re-export.
  it('still exposes the client and the error type', () => {
    expect(typeof api.createSQLiteClient).toBe('function');
    expect(typeof api.SQLiteError).toBe('function');
  });

  // Falsifiable: drop the capabilities re-export from src/index.ts. The
  // benchmark page imports these instead of holding a second copy of the
  // probes — see BENCH-DRIFT in mem:follow-ups.
  it('exposes the capability probes the benchmark page needs', () => {
    expect(typeof api.detectFeatures).toBe('function');
    expect(typeof api.missingFeature).toBe('function');
  });
});
