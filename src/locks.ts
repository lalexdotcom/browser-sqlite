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
  /** Acquires `name` and resolves with the function that releases it. */
  hold: (name: string) => Promise<() => void>;
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

/** Serializes database opening across the pool — replaces the SAB init mutex. */
export const initLockName = (file: string) => `bsq:init:${file}`;

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
    hold: (name) =>
      new Promise<() => void>((resolveReleaser, rejectOuter) => {
        let release!: () => void;
        const held = new Promise<void>((resolveHeld) => {
          release = resolveHeld;
        });
        manager
          .request(name, () => {
            resolveReleaser(release);
            return held;
          })
          .catch(rejectOuter);
      }),
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
