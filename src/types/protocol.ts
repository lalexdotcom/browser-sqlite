import type { SQLiteBuild } from '../const/builds';
import type { PlatformFeature } from '../const/platform';
import type { SQLiteResultCode } from '../const/sqlite';
import type { SQLiteVFS } from '../const/vfs';
import type { SQLiteErrorCode } from './errors';

export type SQLiteWorkerMessageData<_T = unknown> = {
  callId: number;
  terminate?: boolean;
} & (
  | SQLWorkerResultData[keyof SQLWorkerResultData]
  | { type: 'error'; message: string }
);

export type SQLWorkerResultData<T = unknown> = {
  open: { success: boolean };
  sql: { type: 'partial'; result: T[] } | { type: 'one'; sizes: number[] };
  abort: { type: 'done' };
};

/**
 * The savepoint a transaction asks the worker to handle around one query
 * (spec 2026-09-11, D4/D5). `conclude` settles the savepoint the previous
 * savepointed write left open — `release` keeps that write, `undo` rolls it
 * back first — and `open` starts one for this query's own statement. Both run
 * before the statement, conclusion first. Internal: no consumer sets it.
 */
export type SavepointOp = { conclude?: 'release' | 'undo'; open?: true };

type SQLOptions = {
  chunkSize?: number;
  /** Chunks the worker may send before waiting for a credit. Spec §3.2. */
  credits?: number;
  /** See `SavepointOp`. */
  savepoint?: SavepointOp;
  /**
   * The library's own transaction control — BEGIN, COMMIT, ROLLBACK, a
   * consumer's savepoint operation. The worker's authorizer refuses
   * transaction control on any message without it (spec 2026-10-04, § 4).
   */
  control?: true;
  /** Prepared afresh and never cached (spec 2026-10-04, D9). */
  uncached?: true;
};

/**
 * Where a worker fetches its `.wasm` from, when the consumer overrode it.
 *
 * Discriminated rather than a single string because the two forms differ in
 * what they leave to the Emscripten glue. `base` is a directory: the glue
 * supplies the file name (`locateFile('wa-sqlite-async.wasm')`), so nothing
 * here names the three builds' files — and nothing has to be renamed when
 * wa-sqlite renames one. `file` is the whole URL, typically content-hashed by
 * a bundler, so the glue's file name is discarded.
 *
 * Always absolute: `resolveWasmLocation` (`src/utils.ts`) resolves against the
 * page before the `open` message is posted, so the worker applies it without
 * knowing what it was relative to.
 */
export type WasmLocation = { base: string } | { file: string };

export type ClientMessageData =
  | {
      type: 'open';
      file: string;
      vfs: SQLiteVFS;
      build: SQLiteBuild;
      pragmas?: Record<string, string>;
      /** Statements retained per worker; see `src/client.ts`. Internal. */
      statementCacheSize?: number;
      /** Bytes retained per worker; see `src/client.ts`. Internal. */
      statementCacheBytes?: number;
      wasm?: WasmLocation;
      /** Shared abort slots, one Int32 per worker. Isolated contexts only. */
      abortSlots?: SharedArrayBuffer;
      /** This worker's index into `abortSlots`. */
      abortIndex?: number;
      /**
       * Features this worker must find before opening; it declines instead of
       * opening when one is missing (spec 2026-09-13). Sent to slots of index
       * ≥ 1 only, and only by a VFS that declares `singleConnectionWithout`.
       */
      declineWithout?: readonly PlatformFeature[];
      /**
       * Features worker 0 probes before opening, where the VFS is exclusive
       * without one (spec 2026-09-15, §3.2): it reports them with `probed`,
       * then loads nothing until `proceed`. Sent to slot 0 only, and only by a
       * VFS that declares `exclusiveConnectionWithout`.
       */
      probeFirst?: readonly PlatformFeature[];
    }
  | {
      type: 'query';
      callId: number;
      sql: string;
      params: unknown[];
      options?: SQLOptions;
    }
  | { type: 'close'; callId: number }
  | { type: 'credit'; callId: number; n: number }
  | { type: 'stop'; callId: number }
  /** The client decided the connection lock; worker 0 may open (spec 2026-09-15). */
  | { type: 'proceed'; callId: number }
  | {
      type: 'delete';
      callId: number;
      file: string;
      vfs: SQLiteVFS;
      build: SQLiteBuild;
      wasm?: WasmLocation;
    };

/**
 * The step a worker's open has reached, posted as each one begins. Public as
 * the type of `WorkerDebugState.boot`, which names where an open that never
 * finishes stopped.
 */
export type BootStage =
  | 'waiting for the client'
  | 'loading the build'
  | 'instantiating wasm'
  | 'loading the VFS module'
  | 'creating the VFS'
  | 'waiting for the open lock'
  | 'opening the database'
  | 'applying pragmas';

export type WorkerMessageData =
  | { type: 'ready'; callId: number }
  | { type: 'boot'; callId: number; stage: BootStage }
  /**
   * The worker found a feature of `declineWithout` missing and opened nothing:
   * the environment caps the pool (spec 2026-09-13).
   */
  | { type: 'declined'; callId: number; missing: PlatformFeature }
  /**
   * Worker 0's answer to `probeFirst`: the first feature missing, or null. It
   * opens nothing until the client sends `proceed` (spec 2026-09-15, §3.2).
   */
  | { type: 'probed'; callId: number; missing: PlatformFeature | null }
  | { type: 'chunk'; callId: number; data: unknown[] }
  | {
      type: 'done';
      callId: number;
      affected: number;
      /**
       * Statements compiled while serving this query — zero on a cache hit.
       * Rides the same message as `affected` rather than opening a channel:
       * the effect this instruments is a count, not a duration (`mem:lessons`,
       * "for a sub-millisecond effect, count the round trips").
       */
      prepared: number;
      /**
       * Whether the connection is inside a transaction once this query has
       * ended — `sqlite3_get_autocommit() === 0`. SQLite can leave a
       * transaction by itself: an interrupted INSERT/UPDATE/DELETE rolls the
       * whole transaction back. Absent when the worker could not read it.
       */
      inTransaction?: boolean | undefined;
    }
  | {
      type: 'error';
      callId: number;
      message: string;
      cause?: unknown;
      /** SQLite's numeric result code, when the failure came from SQLite. */
      sqliteCode?: SQLiteResultCode;
      /**
       * SQLite's extended result code, read in the worker where the statement
       * failed (spec 2026-09-14, §5.1). Sent by the query path only, and
       * unfiltered: this is exactly what SQLite reported, including a value
       * equal to `sqliteCode` (no subtype). The client is what drops it in
       * that case (D9); when SQLite does report a subtype,
       * `(sqliteExtendedCode & 0xff) === sqliteCode`.
       */
      sqliteExtendedCode?: number;
      /**
       * A code this library minted, when the worker knows the cause. The
       * generic path by which a worker-side error keeps its code across the
       * boundary — `worker.ts` copies it off any thrown error carrying one, so
       * this is a structural contract and not a hook for one class.
       *
       * **Nothing sets it today.** `WorkerQueryTimeout` was its only producer
       * and it went with the execution budget when `timeout` became a
       * client-side wall-clock deadline. Kept rather than deleted: it is the
       * twin of `sqliteCode` above, which is load-bearing, and rebuilding it
       * would cost the same three sites it occupies.
       */
      errorCode?: SQLiteErrorCode;
      /**
       * Whether the connection is inside a transaction once this query has
       * ended — `sqlite3_get_autocommit() === 0`. SQLite can leave a
       * transaction by itself: an interrupted INSERT/UPDATE/DELETE rolls the
       * whole transaction back. Absent when the worker could not read it.
       */
      inTransaction?: boolean | undefined;
    }
  | { type: 'closed'; callId: number }
  | { type: 'deleted'; callId: number }
  /** The delete worker found nothing at that name; deleteDatabase turns it into DATABASE_NOT_FOUND. */
  | { type: 'not-found' }
  | {
      type: 'open-error';
      callId: number;
      message: string;
      cause?: unknown;
      /** SQLite's numeric result code, when the failure came from SQLite. */
      sqliteCode?: SQLiteResultCode;
    };
