/**
 * A thin wrapper over `navigator.locks`, used by `output()` to make its staging
 * tables collectable across tabs (D3).
 *
 * The staging lock is NOT mutual exclusion — nothing contends for its name. It
 * is a liveness marker: a lock held for as long as a staging table exists is
 * what lets another tab's sweep tell an in-flight table from an orphan. A tab
 * that is killed has its locks released by the browser, so its orphans become
 * collectable immediately, with no timestamp and no grace period.
 */

import type { SQLiteVFS } from './types';
import { VFS_CAPABILITIES } from './types';

/** The slice of the Web Locks API this module uses. */
type LockManager = {
  request: (
    name: string,
    optionsOrCallback: any,
    callback?: (lock: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
  query: () => Promise<{ held?: { name?: string }[] }>;
};

export type Locks = {
  /** False when the Web Locks API is missing; every method then no-ops. */
  readonly available: boolean;
  /**
   * Acquires `name` and resolves with the function that releases it.
   *
   * `mode: 'shared'` is what the epoch marker uses: many realms may hold the
   * same name at once, so publishing never waits and two realms can never
   * collide on one epoch number. `signal` aborts the WAIT — never the hold —
   * and makes the request reject with `AbortError`.
   *
   * `ifAvailable: true` mirrors `tryWithLock`'s semantics: the real API hands
   * the callback `null` rather than waiting when the lock is held elsewhere.
   * Resolves with `undefined` in that case instead of waiting. Never waits —
   * that is the point for the connection guard.
   */
  hold(
    name: string,
    options?: { mode?: 'exclusive' | 'shared'; signal?: AbortSignal },
  ): Promise<() => void>;
  hold(
    name: string,
    options: {
      mode?: 'exclusive' | 'shared';
      signal?: AbortSignal;
      ifAvailable: true;
    },
  ): Promise<(() => void) | undefined>;
  /** Runs `fn` while holding `name` exclusively. */
  withLock: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Runs `fn` while holding `name`, or skips it entirely when the lock is held
   * elsewhere. Never waits — which is the point: the staging sweep is
   * opportunistic, and awaiting this lock inside an open transaction would
   * hold SQLite's write lock while waiting on a holder that may itself be
   * waiting for that write lock.
   *
   * Resolves `true` if `fn` ran, `false` if it was skipped.
   */
  tryWithLock: (name: string, fn: () => Promise<unknown>) => Promise<boolean>;
  /** Names currently held anywhere in this origin — every tab included. */
  heldNames: () => Promise<string[]>;
};

const STAGING_PREFIX = '__bsq_staging_';

export const stagingTableName = (uuid: string) =>
  `${STAGING_PREFIX}${uuid.replace(/-/g, '_')}`;

export const isStagingTable = (table: string) =>
  table.startsWith(STAGING_PREFIX);

export const stagingLockName = (file: string, table: string) =>
  `bsq:staging:${file}:${table}`;

export const sweepLockName = (file: string) => `bsq:sweep:${file}`;

/**
 * The marker a client holds to publish that it is alive on a database.
 *
 * Held in SHARED mode and contended by NOBODY: like `bsq:staging` this is a
 * liveness marker, not mutual exclusion. `bsq:conn` stays the only occupancy
 * detector `deleteDatabase` rests on — a second one would diverge from it.
 *
 * The label is `encodeURIComponent`d, which escapes `:` as `%3A`. That is what
 * makes the tail split unambiguously into exactly three segments whatever the
 * consumer names their client. The FILE may itself contain a colon, which is
 * why the reader rebuilds the exact prefix instead of scanning for separators —
 * the same trap `epochsFor` documents.
 */
export const clientMarkerName = (
  vfs: SQLiteVFS,
  file: string,
  id: string,
  clientName: string,
): string =>
  `bsq:client:${namespaceFor(vfs)}:${file}:${id}:${vfs}:${encodeURIComponent(clientName)}`;

export type ClientMarker = {
  readonly id: string;
  readonly vfs: SQLiteVFS;
  readonly name: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads one of our markers, or `undefined` for anything else.
 *
 * Every rejection below is deliberate: a marker this version does not
 * understand — a future one carrying more segments, say — must be SKIPPED, not
 * guessed at. Guessing is how a reader reports another database's state.
 */
export const parseClientMarker = (
  lockName: string,
  vfs: SQLiteVFS,
  file: string,
): ClientMarker | undefined => {
  const prefix = `bsq:client:${namespaceFor(vfs)}:${file}:`;
  if (!lockName.startsWith(prefix)) return undefined;

  const parts = lockName.slice(prefix.length).split(':');
  if (parts.length !== 3) return undefined;

  const [id, markerVfs, encoded] = parts as [string, string, string];
  if (!UUID_RE.test(id)) return undefined;
  if (!Object.hasOwn(VFS_CAPABILITIES, markerVfs)) return undefined;

  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    // Malformed percent-escapes throw URIError. An unreadable label is an
    // unreadable marker: skip it rather than report a mangled name.
    return undefined;
  }

  return { id, vfs: markerVfs as SQLiteVFS, name };
};

/**
 * The storage namespace a VFS writes into — derived from `layout`, NEVER from
 * the VFS name.
 *
 * `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS` and
 * `OPFSWriteAheadVFS` all walk from `navigator.storage.getDirectory()` and open
 * `getFileHandle(filename)`, so one database name is ONE file for all four. A
 * per-VFS key would let two of them write the same bytes without ever
 * excluding each other: a missed conflict corrupts, an invented one only slows.
 *
 * `idb-store` goes finer than its layout on purpose — its two VFS each own an
 * IndexedDB database named after their class, so grouping them would invent a
 * conflict for free. `opfs-pool` and `memory` are alone in their layout, so the
 * VFS name is already the namespace.
 *
 * `worker/worker.ts:627` gates on `layout` for the same reason, in those words.
 */
export const namespaceFor = (vfs: SQLiteVFS): string =>
  VFS_CAPABILITIES[vfs].layout === 'opfs-path' ? 'opfs' : vfs;

/**
 * Whether two clients on this VFS can reach the same bytes at all.
 *
 * False for the memory VFS: its pages live in the worker that opened them and
 * `maxPoolSize` is 1, so two clients on one name are two independent
 * databases. Locking them against each other would be wrong as well as slow —
 * an origin round trip charged to the VFS chosen for speed. `delete.ts:79`
 * skips the same layout, for the same reason.
 */
export const sharesStorage = (vfs: SQLiteVFS): boolean =>
  VFS_CAPABILITIES[vfs].layout !== 'memory';

/** Serializes database opening across the pool — replaces the SAB init mutex. */
export const initLockName = (vfs: SQLiteVFS, file: string) =>
  `bsq:init:${namespaceFor(vfs)}:${file}`;

/**
 * Serializes WRITERS across every client and tab in the origin. Exclusive, so
 * at most one is held per database at any instant however many clients exist.
 */
export const writeLockName = (vfs: SQLiteVFS, file: string) =>
  `bsq:write:${namespaceFor(vfs)}:${file}`;

/**
 * Origin-wide exclusive connection lock for VFS that cannot safely share a
 * database across clients (`exclusiveConnection: true` in `VFS_CAPABILITIES`).
 *
 * Held for the client's lifetime. A second `createSQLiteClient` that tries to
 * open the same database will fail its first query with `BUSY` instead of
 * silently reading a broken, frozen view — the failure mode measured as
 * AHP-2TAB (2026-09-01) where `SELECT 1` passes and `SELECT count(*) FROM
 * sqlite_master` returns 0 on an unfixable connection.
 *
 * The key uses `namespaceFor(vfs)` for the same reason `writeLockName` does:
 * the gate is by layout declaration, not by VFS name.
 */
export const connectionLockName = (vfs: SQLiteVFS, file: string) =>
  `bsq:conn:${namespaceFor(vfs)}:${file}`;

/**
 * Which staging tables no live `output()` is using — pure, so it is driven by
 * Node tests rather than by two browser tabs.
 */
export const staleStagingTables = (
  tables: string[],
  heldNames: string[],
  file: string,
): string[] => {
  const held = new Set(heldNames);
  return tables.filter((table) => !held.has(stagingLockName(file, table)));
};

/** The no-op Locks value for environments where the Web Locks API is absent. */
export const noOpLocks: Locks = {
  available: false,
  hold: async () => () => {},
  withLock: async (_name, fn) => fn(),
  tryWithLock: async (_name, fn) => {
    await fn();
    return true;
  },
  heldNames: async () => [],
};

export const createLocks = (
  manager: LockManager | undefined = globalThis.navigator?.locks as
    | LockManager
    | undefined,
): Locks => {
  if (!manager) return noOpLocks;

  return {
    available: true,
    hold: ((
      name: string,
      options?: {
        mode?: 'exclusive' | 'shared';
        signal?: AbortSignal;
        ifAvailable?: boolean;
      },
    ) =>
      new Promise<(() => void) | undefined>((resolveReleaser, rejectOuter) => {
        const ifAvail: boolean = options?.ifAvailable === true;
        let release!: () => void;
        const held = new Promise<void>((resolveHeld) => {
          release = resolveHeld;
        });
        // Built conditionally rather than with `signal: options?.signal`: an
        // explicit undefined is not reliably "absent" across engines, and Web
        // Locks refuses `signal` alongside `ifAvailable`.
        const requestOptions: {
          mode: string;
          signal?: AbortSignal;
          ifAvailable?: true;
        } = { mode: options?.mode ?? 'exclusive' };
        if (options?.signal) requestOptions.signal = options.signal;
        // `ifAvailable` must be absent (not merely false) when not requested —
        // Web Locks refuses `signal` alongside `ifAvailable`, so we only set it
        // when the caller explicitly asked for the non-blocking behaviour.
        if (ifAvail) requestOptions.ifAvailable = true;
        manager
          .request(name, requestOptions, (lock) => {
            // `ifAvailable` hands the callback null instead of waiting.
            if (ifAvail && !lock) {
              resolveReleaser(undefined);
              return Promise.resolve();
            }
            resolveReleaser(release);
            return held;
          })
          .catch(rejectOuter);
      })) as Locks['hold'],
    withLock: <T>(name: string, fn: () => Promise<T>) =>
      manager.request(name, { mode: 'exclusive' }, () => fn()) as Promise<T>,
    tryWithLock: async (name, fn) => {
      let ran = false;
      await manager.request(
        name,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          // `ifAvailable` hands the callback null instead of waiting.
          if (!lock) return;
          ran = true;
          await fn();
        },
      );
      return ran;
    },
    heldNames: async () => {
      const snapshot = await manager.query();
      return (snapshot.held ?? [])
        .map((lock) => lock.name)
        .filter((name): name is string => typeof name === 'string');
    },
  };
};
