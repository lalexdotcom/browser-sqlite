import { describe, expect, it } from '@rstest/core';
import type {
  SQLiteDB,
  SQLiteQueryAPI,
  SQLiteTransactionDB,
} from '../../src/api';
import * as api from '../../src/index';

/**
 * Compile-time pin. Types are erased, so no runtime assertion can check that
 * both surfaces derive from one base — `tsc --noEmit` is the only thing that
 * can, and `tsconfig.json` already type-checks `tests/`.
 *
 * Falsifiable: remove a member from SQLiteQueryAPI's contribution to either
 * surface, or add one to a surface without adding it to the base.
 */
const asQueryAPI = (surface: SQLiteQueryAPI) => surface;
declare const pinnedClient: SQLiteDB;
declare const pinnedTransaction: SQLiteTransactionDB;
// biome-ignore lint/correctness/noConstantCondition: compile-time pin — never executed, type-checked only
if (false) {
  void asQueryAPI(pinnedClient);
  void asQueryAPI(pinnedTransaction);
}

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
    expect(typeof api.SQLiteBulkWriteError).toBe('function');
    expect('BulkWriteError' in api).toBe(false);
  });

  // Falsifiable: drop the capabilities re-export from src/index.ts. The
  // benchmark page imports these instead of holding a second copy of the
  // probes — see BENCH-DRIFT in mem:follow-ups.
  it('exposes the capability probes the benchmark page needs', () => {
    expect(typeof api.detectFeatures).toBe('function');
    expect(typeof api.missingFeature).toBe('function');
  });
});
