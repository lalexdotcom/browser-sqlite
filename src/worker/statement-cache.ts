/**
 * A per-worker LRU of prepared statements, keyed by the exact SQL string.
 *
 * Pure bookkeeping: this module prepares nothing and finalises nothing.
 * `worker.ts` owns every effect, which is what lets the policy be tested in
 * Node against plain integers in a subsystem whose remainder only runs in a
 * browser — the role `mem:architecture` describes for `scheduler.ts` and
 * `supervisor.ts`.
 */

/** A `sqlite3_stmt` pointer. Opaque here: the cache only files it. */
export type StatementHandle = number;

/**
 * `null` marks SQL that must never be cached — a multi-statement string,
 * whose first statement would otherwise be replayed alone under the key of
 * the whole string. The marking shares the LRU with real entries on purpose:
 * kept apart, generated SQL would grow a second unbounded map beside the one
 * this bound exists to close.
 */
type Entry = StatementHandle | null;

export type StatementCache = {
  get: (sql: string) => StatementHandle | 'uncacheable' | undefined;
  /** Returns the handles evicted by this insertion; the caller finalises them. */
  set: (sql: string, handle: StatementHandle) => StatementHandle[];
  /** Returns the handles evicted by this marking; the caller finalises them. */
  markUncacheable: (sql: string) => StatementHandle[];
  delete: (sql: string) => StatementHandle | undefined;
  /** Empties the cache and returns every live handle, for close. */
  drain: () => StatementHandle[];
};

export const createStatementCache = (capacity: number): StatementCache => {
  const entries = new Map<string, Entry>();

  // A Map iterates in insertion order, so re-inserting is how an entry
  // becomes the most recently used and keys().next() is the least.
  const touch = (sql: string, entry: Entry) => {
    entries.delete(sql);
    entries.set(sql, entry);
  };

  const evict = (): StatementHandle[] => {
    const evicted: StatementHandle[] = [];
    while (entries.size > capacity) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      const entry = entries.get(oldest.value);
      entries.delete(oldest.value);
      if (typeof entry === 'number') evicted.push(entry);
    }
    return evicted;
  };

  return {
    get: (sql) => {
      const entry = entries.get(sql);
      if (entry === undefined) return undefined;
      touch(sql, entry);
      return entry === null ? 'uncacheable' : entry;
    },
    set: (sql, handle) => {
      touch(sql, handle);
      return evict();
    },
    markUncacheable: (sql) => {
      touch(sql, null);
      return evict();
    },
    delete: (sql) => {
      const entry = entries.get(sql);
      entries.delete(sql);
      return typeof entry === 'number' ? entry : undefined;
    },
    drain: () => {
      const live: StatementHandle[] = [];
      for (const entry of entries.values()) {
        if (typeof entry === 'number') live.push(entry);
      }
      entries.clear();
      return live;
    },
  };
};
