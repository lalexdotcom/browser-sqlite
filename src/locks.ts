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

export const createLocks = (...args: [LockManager?]): Locks => {
  // Distinguish createLocks() from createLocks(undefined): the former
  // defaults to navigator.locks; the latter explicitly opts out.
  const resolved: LockManager | undefined =
    args.length === 0
      ? (globalThis.navigator?.locks as LockManager | undefined)
      : args[0];
  if (!resolved)
    return {
      available: false,
      hold: async () => () => {},
      withLock: async (_name, fn) => fn(),
      heldNames: async () => [],
    };

  return {
    available: true,
    hold: (name) =>
      new Promise<() => void>((resolveReleaser) => {
        let release!: () => void;
        const held = new Promise<void>((resolveHeld) => {
          release = resolveHeld;
        });
        void resolved.request(name, () => {
          resolveReleaser(release);
          return held;
        });
      }),
    withLock: <T>(name: string, fn: () => Promise<T>) =>
      resolved.request(name, { mode: 'exclusive' }, () => fn()) as Promise<T>,
    heldNames: async () => {
      const snapshot = await resolved.query();
      return (snapshot.held ?? [])
        .map((lock) => lock.name)
        .filter((name): name is string => typeof name === 'string');
    },
  };
};
