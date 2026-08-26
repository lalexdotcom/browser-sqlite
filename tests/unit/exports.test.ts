import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
type _ClientExtras = 'transaction' | 'close' | 'debug';
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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The files that import the built package **by path** rather than by bare
 * specifier. They are HTML, so nothing type-checks them and no test loads
 * them — which makes them the one place a removed export fails silently.
 *
 * This is not hypothetical. When `DEFAULT_VFS` stopped being exported, the
 * benchmark page kept importing it and nothing went red: not `tsc`, not the
 * suite, not CI. It was caught by hand, late. See BENCH-DRIFT in
 * `mem:follow-ups`.
 *
 * The two scaffolded consumer apps are NOT listed: they import the bare
 * specifier and are compiled by the consumer smoke, which already fails on a
 * missing export.
 */
const PATH_IMPORTERS = [
  'scripts/bench/html/index.html',
  'tests/consumer-nobundler/index.html',
];

/** The names a source pulls out of `dist/index.js`, aliases resolved to origin. */
const namedImportsOfEntry = (source: string): string[] => {
  const names: string[] = [];
  const statement =
    /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*dist\/index\.js['"]/g;
  for (const match of source.matchAll(statement)) {
    for (const clause of match[1].split(',')) {
      const name = clause
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.push(name);
    }
  }
  return names;
};

describe('files that import the entry by path', () => {
  for (const file of PATH_IMPORTERS) {
    // Falsifiable: drop one of these names from src/index.ts's re-exports, or
    // rename it. Either turns this red — which is exactly what failed to happen
    // when DEFAULT_VFS was removed.
    it(`${file} imports only names the entry exports`, () => {
      const names = namedImportsOfEntry(
        readFileSync(join(repoRoot, file), 'utf8'),
      );

      // Guards the parse, not the package: a reformatted import statement that
      // stopped matching would otherwise let this test pass having checked
      // nothing at all.
      expect(names.length).toBeGreaterThan(0);

      expect(names.filter((name) => !(name in api))).toEqual([]);
    });
  }
});
