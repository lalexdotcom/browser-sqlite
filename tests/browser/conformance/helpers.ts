import {
  createSQLiteClient,
  deleteDatabase,
  type SQLiteError,
} from 'browser-sqlite';
import { expect, onTestFinished } from 'vitest';
import { defaultBuildFor } from '../../../src/capabilities';
import type { WorkerLostEvent } from '../../../src/client';
import type { SQLiteBuild } from '../../../src/const/builds';
import {
  folderOf,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../../src/const/vfs';
import { databaseFiles, databasePath } from '../../../src/utils';
import {
  AVAILABLE_FEATURES,
  poolFor,
  removeOpfsPath,
} from '../helpers/environment';

/**
 * Every worker a conformance client lost, as `"<vfs> slot <index>: <message>"`.
 * A conformance pass with a lost worker is not a pass: on 2026-08-27 Firefox
 * "passed" OPFSWriteAheadVFS at poolSize 2 and 4 on ONE live worker, because
 * nothing here counted them (spec 2026-09-13). Drained by `expectNoWorkerLost`.
 */
const workerLosses: string[] = [];
const recordLoss =
  (vfs: SQLiteVFS) =>
  ({ index, cause }: WorkerLostEvent) => {
    workerLosses.push(`${vfs} slot ${index}: ${cause.message}`);
  };

/** Register with `afterEach` at the top level of every conformance file. */
export const expectNoWorkerLost = () => {
  expect(workerLosses.splice(0)).toEqual([]);
};

/**
 * A client on a unique database, registered for cleanup. Unique names keep
 * scenarios independent; OPFS entries are removed afterwards, and the memory
 * VFS have nothing to remove.
 */
export const conformanceClient = (
  vfs: SQLiteVFS,
  build: SQLiteBuild = defaultBuildFor(vfs, AVAILABLE_FEATURES),
  poolSize: number = poolFor(vfs),
) => {
  const file = `conformance-${crypto.randomUUID()}`;
  const db = createSQLiteClient(file, {
    vfs,
    build,
    poolSize,
    onWorkerLost: recordLoss(vfs),
  });

  // Once per test: `afterEach` registered from inside a running test would stay
  // on the file's suite and run after every later test too.
  onTestFinished(async () => {
    await db.close().catch(() => {});
    // AccessHandlePoolVFS keeps its files in six fixed slots under opaque
    // names, and gives one back on xDelete alone: removing the path below
    // matches nothing, and the origin is shared by every file of the run.
    if (
      VFS_CAPABILITIES[vfs].storage === 'opfs' &&
      folderOf(vfs) === undefined
    ) {
      await deleteDatabase(file, { vfs, build }).catch((error: unknown) => {
        if ((error as SQLiteError)?.code !== 'DATABASE_NOT_FOUND') throw error;
      });
    }
    for (const path of databaseFiles(vfs, databasePath(vfs, file)))
      await removeOpfsPath(path);
  });

  return { file, db };
};

/**
 * A second client on an existing database file, for the close-and-reopen
 * invariant. It deliberately registers no cleanup: the first client already
 * did, on the same name.
 */
export const createReopened = (file: string, vfs: SQLiteVFS) =>
  createSQLiteClient(file, {
    vfs,
    build: defaultBuildFor(vfs, AVAILABLE_FEATURES),
    poolSize: poolFor(vfs),
    onWorkerLost: recordLoss(vfs),
  });
