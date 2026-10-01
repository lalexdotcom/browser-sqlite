import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@rstest/core';
import { VFS_CAPABILITIES } from '../../src/const/vfs';
import type {
  ClientDebugState,
  QueryDebugState,
  RequestDebugState,
  SQLiteDB,
  SQLiteTransactionDB,
  WorkerDebugState,
} from '../../src/index';
import * as api from '../../src/index';

/**
 * Compile-time pin. Asserts mutual assignability of the shared querying
 * surface so a querying method added to one side without the other fails to
 * compile. Purely type-level: type aliases are erased entirely — no runtime
 * code is generated, no `if (false)` guard is needed.
 *
 * ClientExtras are the members legitimately unique to SQLiteDB today
 * (bulkWrite and output move to the base in Task 5; transaction, close, debug
 * stay on SQLiteDB forever). TransactionExtras are unique to SQLiteTransactionDB: commit, rollback, and the transaction's signal.
 * What remains on both sides after the Omit must be identical.
 *
 * Falsifiable: add a querying member to SQLiteDB alone — _PinTxToClient fails.
 *              add a querying member to SQLiteTransactionDB alone — _PinClientToTx fails.
 */
type _ClientExtras =
  | 'transaction'
  | 'close'
  | 'debug'
  | 'id'
  | 'name'
  | 'file'
  | 'files'
  | 'vfs'
  | 'build'
  | 'poolSize'
  | 'ready'
  | 'inspect';
type _TransactionExtras = 'commit' | 'rollback' | 'signal';
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
 * The debug tree's types are importable from the entry, so a consumer can type
 * a polling function. Falsifiable: drop the export from src/index.ts.
 */
type _DebugTypesExported = [
  ClientDebugState,
  WorkerDebugState,
  RequestDebugState,
  QueryDebugState,
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * What the package entry exports at runtime, exactly. A name added to or
 * dropped from `src/index.ts` changes the public contract and must show here.
 */
describe('public entry', () => {
  // Falsifiable: re-export VFS_CAPABILITIES from src/index.ts, or drop deleteDatabase.
  it('exports exactly the public values', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'SQLITE_CODES',
        'SQLITE_EXTENDED_CODES',
        'SQLiteBulkWriteError',
        'SQLiteError',
        'createSQLiteClient',
        'deleteDatabase',
        'detectFeatures',
        'inspectDatabase',
        'missingFeature',
      ].sort(),
    );
  });

  // Falsifiable: drop either re-export from src/index.ts.
  it('exposes the SQLite result codes, primary and extended', () => {
    expect(api.SQLITE_CODES.CONSTRAINT).toBe(19);
    expect(api.SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE).toBe(2067);
  });

  // Falsifiable: restore "./worker" in package.json's exports.
  it('declares no subpath but the entry', () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'package.json'), 'utf8'),
    );
    expect(Object.keys(pkg.exports)).toEqual(['.']);
  });
});

// Falsifiable: re-export one of these from src/index.ts; tsc then reports an unused directive.
// @ts-expect-error VFSCapability is not exported
type _NoVFSCapability = api.VFSCapability;
// @ts-expect-error VFSStorage is not exported
type _NoVFSStorage = api.VFSStorage;
// @ts-expect-error VFSMemoryModel is not exported
type _NoVFSMemoryModel = api.VFSMemoryModel;

describe('VFS_CAPABILITIES', () => {
  // Falsifiable: drop one VFS from VFS_CAPABILITIES.
  it('wires every VFS', () => {
    expect(Object.keys(VFS_CAPABILITIES).sort()).toEqual(
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
});

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
