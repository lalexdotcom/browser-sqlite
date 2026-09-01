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

import type { Locks } from './locks';
import { namespaceFor } from './locks';
import type { SQLiteVFS } from './types';

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

/**
 * The marker a realm holds to publish the epoch it last committed.
 *
 * Held in SHARED mode: many realms may hold one name at once, so publishing
 * never waits and two realms can never collide on a number. Nobody reads the
 * lock — the NAME is the state, which is why this beats a BroadcastChannel:
 * there is no message that can still be in flight.
 */
export const epochLockName = (ns: string, file: string, n: number) =>
  `bsq:epoch:${ns}:${file}:${n}`;

/**
 * The highest epoch any realm in this origin has published under `prefix`.
 *
 * The tail after the prefix must be ALL digits, which is stricter than a
 * prefix match plus `lastIndexOf(':')` and is the point: a normalized file may
 * contain a colon (`new URL('./a:b', 'file://').pathname` is `a:b`), so the
 * loose form would read another database's epoch as this one's.
 */
export const maxEpochIn = (heldNames: string[], prefix: string): number => {
  let max = 0;
  for (const name of heldNames) {
    if (!name.startsWith(`${prefix}:`)) continue;
    const tail = name.slice(prefix.length + 1);
    if (!/^\d+$/.test(tail)) continue;
    const n = Number(tail);
    if (n > max) max = n;
  }
  return max;
};

const REGISTRY_KEY = Symbol.for('browser-sqlite.epochs.v1');

type Cell = { value: number; releaseMarker?: () => void };
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
  /** The number of commits observed for this database, floor included. */
  current: () => number;
  /** Records one commit and returns the new epoch. */
  bump: () => number;
  /** Raises the local floor. Never lowers it. */
  raiseTo: (n: number) => void;
  /** The highest epoch published by any realm in this origin. */
  originMax: () => Promise<number>;
  /** Publishes `n` for this realm, replacing its previous marker. */
  publish: (n: number) => Promise<void>;
};

/**
 * Handles onto the counter for `(namespace, file)`, which MUST already be
 * normalized by `normalizeDatabaseFile`. Entries are never removed: deleting
 * one would restart the counter at 0, and a worker still alive with `seen = 5`
 * would then read `5 > 0`, believe itself current forever, and serve stale
 * data.
 *
 * The cell is realm-wide, so every client in a tab shares one counter AND one
 * marker — publication is per realm, not per client.
 */
export const epochsFor = (
  vfs: SQLiteVFS,
  file: string,
  locks: Locks,
): Epochs => {
  const ns = namespaceFor(vfs);
  const key = `${ns}:${file}`;
  const map = registry();
  const existing = map.get(key);
  const cell: Cell = existing ?? { value: 0 };
  if (!existing) map.set(key, cell);

  const prefix = `bsq:epoch:${ns}:${file}`;

  return {
    current: () => cell.value,
    bump: () => {
      cell.value += 1;
      return cell.value;
    },
    raiseTo: (n) => {
      if (n > cell.value) cell.value = n;
    },
    originMax: async () =>
      locks.available ? maxEpochIn(await locks.heldNames(), prefix) : 0,
    publish: async (n) => {
      if (!locks.available) return;
      const previous = cell.releaseMarker;
      // New before old, always: `max` must never dip between the two.
      cell.releaseMarker = await locks.hold(epochLockName(ns, file, n), {
        mode: 'shared',
      });
      previous?.();
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
