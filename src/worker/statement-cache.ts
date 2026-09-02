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
 * A cached statement and what it weighs. `handle: null` marks SQL that must
 * never be cached; a marking weighs nothing, so it can never evict a real
 * statement by its size alone.
 */
type Entry = { handle: StatementHandle | null; weight: number };

/**
 * The two bounds, both active. `maxEntries` answers the churn that generated
 * SQL produces; `maxBytes` answers the footprint of a `bulkWrite` template,
 * which is three orders of magnitude heavier than an ordinary statement
 * (`mem:measurements`).
 */
export type StatementCacheBounds = {
  maxEntries: number;
  maxBytes: number;
};

export type StatementCache = {
  get: (sql: string) => StatementHandle | 'uncacheable' | undefined;
  /**
   * Returns the handles evicted by this insertion; the caller finalises them.
   * `weight` is `SQLITE_STMTSTATUS_MEMUSED` and is required on purpose: an
   * optional one would silently account a statement as free.
   */
  set: (
    sql: string,
    handle: StatementHandle,
    weight: number,
  ) => StatementHandle[];
  /** Returns the handles evicted by this marking; the caller finalises them. */
  markUncacheable: (sql: string) => StatementHandle[];
  delete: (sql: string) => StatementHandle | undefined;
  /** Empties the cache and returns every live handle, for close. */
  drain: () => StatementHandle[];
};

export const createStatementCache = ({
  maxEntries,
  maxBytes,
}: StatementCacheBounds): StatementCache => {
  const entries = new Map<string, Entry>();
  /** The sum of every retained entry's weight. Never derived, always kept. */
  let total = 0;

  /** Removes an entry from the map AND from the total. */
  const drop = (sql: string): Entry | undefined => {
    const entry = entries.get(sql);
    if (entry === undefined) return undefined;
    entries.delete(sql);
    total -= entry.weight;
    return entry;
  };

  /** Drops the least recently used entry, collecting its handle if live. */
  const evictOldest = (evicted: StatementHandle[]) => {
    const oldest = entries.keys().next();
    if (oldest.done) return;
    const entry = drop(oldest.value);
    if (entry?.handle != null) evicted.push(entry.handle);
  };

  /**
   * The design's §2 rule.
   *
   * Dropping the key first is what makes a re-set REPLACE its weight rather
   * than add to it — `worker.ts`'s `settle` calls `set` on every successful
   * exit, a cache hit included. The dropped entry is deliberately NOT reported
   * as evicted: it is the same statement the caller is still holding, and
   * finalising it would destroy the statement being cached.
   *
   * The byte loop tests the total BEFORE the insertion and never looks at the
   * incoming weight, so an entry heavier than the whole budget is accepted and
   * the overshoot is exactly one entry — which is what keeps a 2.4 MB template
   * cacheable at any budget, and the peak at `maxBytes + largest statement`.
   */
  const insert = (sql: string, entry: Entry): StatementHandle[] => {
    drop(sql);

    const evicted: StatementHandle[] = [];
    while (total >= maxBytes && entries.size > 0) evictOldest(evicted);

    entries.set(sql, entry);
    total += entry.weight;

    while (entries.size > maxEntries) evictOldest(evicted);
    return evicted;
  };

  return {
    get: (sql) => {
      const entry = entries.get(sql);
      if (entry === undefined) return undefined;
      // A Map iterates in insertion order, so re-inserting is how an entry
      // becomes the most recently used and keys().next() is the least.
      entries.delete(sql);
      entries.set(sql, entry);
      return entry.handle === null ? 'uncacheable' : entry.handle;
    },
    set: (sql, handle, weight) => insert(sql, { handle, weight }),
    markUncacheable: (sql) => insert(sql, { handle: null, weight: 0 }),
    delete: (sql) => drop(sql)?.handle ?? undefined,
    drain: () => {
      const live: StatementHandle[] = [];
      for (const entry of entries.values()) {
        if (entry.handle !== null) live.push(entry.handle);
      }
      entries.clear();
      total = 0;
      return live;
    },
  };
};
