import { SQLiteError } from './errors';
import { createLocks, initLockName } from './locks';
import { busyFromCode, spawnWorker } from './pool';
import {
  defaultBuildFor,
  RECOMMENDED_VFS,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
  type WorkerMessageData,
} from './types';
import { normalizeDatabaseFile, resolveWasmLocation } from './utils';

export type DeleteDatabaseOptions = {
  /**
   * Which VFS holds the database. Required for the same reason it is required
   * on `createSQLiteClient`: a VFS decides where the bytes live, so deleting
   * without naming one deletes in the wrong store — or nowhere, while
   * reporting success.
   */
  vfs: SQLiteVFS;
  /**
   * Which wa-sqlite build to load. It does **not** affect where the database
   * lives; it is here only because a VFS runs solely on the builds it
   * declares, and one of them must be loaded to instantiate the VFS at all.
   * @defaultValue the first build the VFS declares
   */
  build?: SQLiteBuild;
  /**
   * Where the worker fetches its `.wasm`, with the same meaning as on
   * `createSQLiteClient`. A deployment that needs it to open a database needs
   * it to delete one.
   */
  wasmUrl?: string | ((build: SQLiteBuild) => string);
};

/**
 * Deletes a database and the two siblings SQLite may leave beside it.
 *
 * Deleting a database that is not there is success — SQLite's own `xDelete`
 * behaves the same way, and a caller who wanted it gone has got what they
 * asked for.
 *
 * Nothing a VFS keeps for itself is touched: not the IndexedDB store, which is
 * shared by every database that VFS holds on this origin, and not the
 * `AccessHandlePoolVFS` directory, whose files *are* its reusable capacity.
 * The bytes of the named database are freed in both cases.
 *
 * @throws {SQLiteError} `INVALID_OPTION` when `vfs` is missing or the `build`
 *   is not one the VFS supports — synchronously in spirit, as a rejection here.
 * @throws {SQLiteError} `BUSY` when the database is open or being opened, in
 *   this tab or another. A connection already holding its handles cannot be
 *   revoked from here; see the README's Known Limitations.
 */
export const deleteDatabase = async (
  file: string,
  options: DeleteDatabaseOptions,
): Promise<void> => {
  if (!options?.vfs) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `vfs is required. Pass the VFS the database was created with — ${RECOMMENDED_VFS} is the recommended universal choice. A database written through one VFS is not visible through another, so deleting through the wrong one deletes nothing.`,
    );
  }

  const vfs = options.vfs;
  const build = options.build ?? defaultBuildFor(vfs);
  const capability = VFS_CAPABILITIES[vfs];

  if (!(capability.builds as readonly SQLiteBuild[]).includes(build)) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `${vfs} cannot run on the '${build}' build. Supported: ${capability.builds.join(', ')}.`,
    );
  }

  // Nothing was ever persisted, so there is nothing to delete and no worker
  // worth spawning to say so.
  if (capability.layout === 'memory') return;

  const dbFile = normalizeDatabaseFile(file);
  const wasm = resolveWasmLocation(options.wasmUrl, build, location.href);

  // Yield to the microtask queue so that a lock release triggered by resolving
  // a promise in the caller's current task propagates through the Web Locks API
  // before the ifAvailable check inside tryWithLock runs. Without this yield,
  // calling deleteDatabase synchronously after release.resolve() races the lock
  // release and can report BUSY when the lock is already free.
  await Promise.resolve();
  const ran = await createLocks().tryWithLock(initLockName(dbFile), () =>
    runDelete({ file: dbFile, vfs, build, wasm }),
  );

  if (!ran) {
    throw new SQLiteError(
      'BUSY',
      `${dbFile} is being opened or deleted elsewhere. Close every client on it, in every tab, and try again.`,
    );
  }
};

/**
 * How long a delete may take before the worker is presumed unable to answer.
 * Matches `openTimeout`'s default, because the failure it catches is the same
 * one: a VFS that cannot acquire what it needs — `AccessHandlePoolVFS` whose
 * six slots are held elsewhere reaches neither success nor error. Not a public
 * option: a caller has nothing useful to tune here, and a delete that takes
 * thirty seconds has already failed.
 */
const DELETE_TIMEOUT = 30_000;

const runDelete = (message: {
  file: string;
  vfs: SQLiteVFS;
  build: SQLiteBuild;
  wasm: ReturnType<typeof resolveWasmLocation>;
}): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const worker = spawnWorker(`SQLite delete / ${message.file}`);

    const timer = setTimeout(() => {
      settle(
        new SQLiteError(
          'TIMEOUT',
          `deleting ${message.file} timed out after ${DELETE_TIMEOUT} ms. The database is most likely held open by another client or tab.`,
        ),
      );
    }, DELETE_TIMEOUT);

    const settle = (error?: SQLiteError) => {
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
      else resolve();
    };

    worker.onmessage = (event: MessageEvent<WorkerMessageData>) => {
      const data = event.data;
      if (data.type === 'deleted') return settle();
      if (data.type === 'error') {
        return settle(
          busyFromCode(data) ??
            new SQLiteError('WORKER_CRASHED', data.message, {
              cause: data.cause,
            }),
        );
      }
    };

    worker.onerror = (event) => {
      settle(
        new SQLiteError(
          'WORKER_CRASHED',
          `worker crashed while deleting ${message.file}: ${(event as ErrorEvent).message ?? ''}`,
        ),
      );
    };

    worker.postMessage({ type: 'delete', callId: 0, ...message });
  });
