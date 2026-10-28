import { SQLITE_CODES } from './const/sqlite';
import type { Lease } from './scheduler';
import { SQLiteError } from './types/errors';
import type { Verdict } from './types/protocol';

/**
 * A client's verdicts by SQL text: settled, or still being asked. A verdict
 * can depend on the schema — `DROP TRIGGER IF EXISTS` reads while the trigger
 * is absent — so a read verdict is never trusted alone: whatever runs on it
 * carries a refusal, and a refused one is set to `write` (`RoutedAsRead`).
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

/**
 * A statement sent down the read path that the worker found to write, before
 * it changed anything. Internal: the client sends it to the writer instead.
 */
export class RoutedAsRead extends Error {
  constructor() {
    super('A write was routed as a read.');
    this.name = 'RoutedAsRead';
  }
}

/**
 * A failed prepare SQLite can give a statement it would prepare fine: a
 * neighbour's progress handler (INTERRUPT) or a lock (BUSY, LOCKED).
 */
const isPassingFailure = (error: unknown) =>
  error instanceof SQLiteError &&
  (error.sqliteCode === SQLITE_CODES.INTERRUPT ||
    error.sqliteCode === SQLITE_CODES.BUSY ||
    error.sqliteCode === SQLITE_CODES.LOCKED);

const isFailedPrepare = (error: unknown) =>
  error instanceof SQLiteError &&
  error.code === 'STATEMENT_FAILED' &&
  !isPassingFailure(error);

/** What `askVerdict` needs of a worker. */
export type VerdictWorker = {
  verdict: (sql: string) => Promise<Verdict>;
  readonly status: string;
  quiesce: () => Promise<unknown>;
};

/**
 * Asks until a worker gives `sql` a verdict (spec 2026-10-26, § Routing by
 * verdict). `acquire` is the scheduler's verdict lease: no write lock, no
 * barrier up front, no debug request. Nothing bounds a verdict but `cancel`:
 * a worker that dies silently is not detected (B2).
 *
 * A failed prepare is not a verdict. On a free worker it is asked once more
 * past the barrier, and only that second failure is the statement's; on a
 * transaction's worker, where no barrier applies, a free worker is asked —
 * never another transaction's, which `offer()` could otherwise lend. A
 * passing failure is asked once more, as `readWithRetry` does, then surfaces
 * as it is; a detected death, likewise once.
 */
export const askVerdict = async <W extends VerdictWorker>(
  sql: string,
  cancel: AbortSignal,
  deps: {
    /** `free`: a free worker only, never a transaction's through `offer()`. */
    acquire: (signal: AbortSignal, free: boolean) => Promise<Lease<W>>;
    applyBarrier: (worker: W) => Promise<void>;
  },
): Promise<Verdict> => {
  let deaths = 0;
  let passes = 0;
  // Set once a transaction's worker failed the prepare: from then on only a
  // free worker is asked, where the barrier applies.
  let free = false;
  while (true) {
    const lease = await deps.acquire(cancel, free);
    const { worker } = lease;
    let barrier = false;
    try {
      try {
        return await worker.verdict(sql);
      } catch (error) {
        if (lease.borrowed || !isFailedPrepare(error)) throw error;
        barrier = true;
        // A failing barrier is the call's error, unless its worker died.
        await deps.applyBarrier(worker);
        return await worker.verdict(sql);
      }
    } catch (error) {
      if (worker.status === 'DEAD') {
        deaths += 1;
        if (deaths > 1) throw error;
      } else if (isPassingFailure(error)) {
        passes += 1;
        if (passes > 1) throw error;
      } else if (lease.borrowed && isFailedPrepare(error)) {
        free = true;
      } else {
        throw error;
      }
    } finally {
      // The barrier is a query: the worker goes back once it is idle.
      if (barrier) {
        void worker.quiesce().then(
          () => lease.release(),
          () => lease.release(),
        );
      } else {
        lease.release();
      }
    }
  }
};
