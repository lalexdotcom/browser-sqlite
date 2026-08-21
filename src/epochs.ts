/**
 * The commit epoch: a monotonic integer per database, counting commits
 * performed in this realm. Its absolute value means nothing — only the
 * comparison with a worker's `seen` does.
 *
 * The registry lives in the realm-wide symbol registry rather than in a module
 * variable on purpose. A module singleton is unique only when the bundler
 * loads one copy of the module; `Symbol.for` is unique per realm whatever the
 * bundler did. That is what makes "two clients in one tab see each other" true
 * by construction.
 *
 * The `v1` suffix separates incompatible shapes. Bump it ONLY if the shape
 * changes — bumping it per release recreates the fragmentation it prevents.
 */

/**
 * The statement the barrier runs and discards.
 *
 * Measured 2026-08-20 in the forced configuration: 6/6 correct. `SELECT 1`
 * touches no page and is 6/6 stale; `PRAGMA data_version` and
 * `PRAGMA schema_version` are 8/8 stale; so is waiting. Only a statement that
 * opens a real read transaction on the file refreshes the connection's cached
 * page 1 — and it must be a SEPARATE statement, because the one that triggers
 * the refresh still returns the stale result.
 */
export const BARRIER_SQL = 'SELECT count(*) FROM sqlite_master';

const REGISTRY_KEY = Symbol.for('browser-sqlite.epochs.v1');

type Cell = { value: number };
type Registry = Map<string, Cell>;

const registry = (): Registry => {
  const host = globalThis as unknown as Record<symbol, Registry | undefined>;
  const existing = host[REGISTRY_KEY];
  if (existing) return existing;
  const created: Registry = new Map();
  host[REGISTRY_KEY] = created;
  return created;
};

export type Epochs = {
  /** The number of commits observed in this realm for this database. */
  current: () => number;
  /** Records one commit and returns the new epoch. */
  bump: () => number;
};

/**
 * Handles onto the counter for `file`, which MUST already be normalized by
 * `normalizeDatabaseFile`. Entries are never removed: deleting one would
 * restart the counter at 0, and a worker still alive with `seen = 5` would
 * then read `5 > 0`, believe itself current forever, and serve stale data.
 */
export const epochsFor = (file: string): Epochs => {
  const map = registry();
  const existing = map.get(file);
  const cell: Cell = existing ?? { value: 0 };
  if (!existing) map.set(file, cell);
  return {
    current: () => cell.value,
    bump: () => {
      cell.value += 1;
      return cell.value;
    },
  };
};

/**
 * Where a worker's `seen` lands after the write it just served.
 *
 * `target` is the epoch captured when its lease was granted; `next` is the
 * epoch its own commit produced. Advancing requires both conditions:
 *
 * - `seen === target`: the worker was actually observing from `target` when its
 *   lease was granted. If the worker was already behind (`seen < target`), it
 *   must not be marked current regardless of what it just committed.
 * - `next === target + 1`: the commit is the immediate successor of `target`.
 *   If another client committed during our lease, `next` skipped; our
 *   connection never observed that commit and must stay marked behind.
 *
 * Marking a connection current when it is not is the only class of bug this
 * design must make impossible.
 */
export const advanceSeen = (
  seen: number,
  target: number,
  next: number,
): number => (seen === target && next === target + 1 ? next : seen);
