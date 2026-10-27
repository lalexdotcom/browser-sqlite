import type { Verdict } from './types/protocol';

/**
 * A client's verdicts by SQL text: settled, or still being asked. A verdict
 * depends on the text alone, so no entry is ever invalidated.
 */
export type VerdictMemo = {
  /** The entry for `sql`, which becomes the most recently used. */
  get(sql: string): Verdict | Promise<Verdict> | undefined;
  set(sql: string, v: Verdict | Promise<Verdict>): void;
  delete(sql: string): void;
  readonly size: number;
};

/**
 * An LRU of verdicts. A text longer than `maxLength` is never stored, which
 * bounds the bytes as `maxEntries` bounds the count.
 */
export const createVerdictMemo = (bounds: {
  maxEntries: number;
  maxLength: number;
}): VerdictMemo => {
  // A Map iterates in insertion order: re-inserting on use keeps the least
  // recently used entry first.
  const entries = new Map<string, Verdict | Promise<Verdict>>();
  return {
    get: (sql) => {
      const entry = entries.get(sql);
      if (entry === undefined) return undefined;
      entries.delete(sql);
      entries.set(sql, entry);
      return entry;
    },
    set: (sql, v) => {
      if (sql.length > bounds.maxLength) return;
      entries.delete(sql);
      entries.set(sql, v);
      if (entries.size <= bounds.maxEntries) return;
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    },
    delete: (sql) => {
      entries.delete(sql);
    },
    get size() {
      return entries.size;
    },
  };
};
