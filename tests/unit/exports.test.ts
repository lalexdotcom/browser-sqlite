import { describe, expect, it } from '@rstest/core';
import type { SQLiteDB, SQLiteTransactionDB } from '../../src/api';
import * as api from '../../src/index';

/**
 * Compile-time pin. Asserts mutual assignability of the shared querying
 * surface so a querying method added to one side without the other fails to
 * compile. Purely type-level: type aliases are erased entirely — no runtime
 * code is generated, no `if (false)` guard is needed.
 *
 * ClientExtras are the members legitimately unique to SQLiteDB today
 * (bulkWrite and output move to the base in Task 5; transaction, close, debug
 * stay on SQLiteDB forever). TransactionExtras are unique to SQLiteTransactionDB.
 * What remains on both sides after the Omit must be identical.
 *
 * Falsifiable: add a querying member to SQLiteDB alone — _PinTxToClient fails.
 *              add a querying member to SQLiteTransactionDB alone — _PinClientToTx fails.
 */
type _ClientExtras = 'bulkWrite' | 'output' | 'transaction' | 'close' | 'debug';
type _TransactionExtras = 'commit' | 'rollback';
type _SharedOfClient = Omit<SQLiteDB, _ClientExtras>;
type _SharedOfTransaction = Omit<SQLiteTransactionDB, _TransactionExtras>;
// If either direction fails, tsc reports: "Type 'false' does not satisfy the constraint 'true'."
type _Assert<T extends true> = T;
type _PinClientToTx = _Assert<
  _SharedOfClient extends _SharedOfTransaction ? true : false
>;
type _PinTxToClient = _Assert<
  _SharedOfTransaction extends _SharedOfClient ? true : false
>;

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
