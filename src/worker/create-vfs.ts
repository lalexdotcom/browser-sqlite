import { isHeldElsewhere } from './held';

/** How long to keep waiting for a dying worker to let go, and how often. */
const ACQUIRE_RETRY_BUDGET_MS = 10_000;
export const ACQUIRE_RETRY_INTERVAL_MS = 100;

/**
 * How long to keep retrying an IndexedDB open that Firefox gave up on, counted
 * from its first `UnknownError`.
 *
 * Firefox's parent retries a SQLite open that answers `NS_ERROR_STORAGE_BUSY`
 * for 10 s, then fails the `indexedDB.open()` with `UnknownError` — the file is
 * still busy with the previous connection closing (Mozilla bug 1541550). Both
 * IndexedDB VFS keep every database in one IndexedDB database of their name, so
 * a client's close and the next open meet on the same file. On Windows runners
 * an I/O stall stretched that close to ~17 s; the next open, 7 s later,
 * succeeded (`mem:follow-ups/idb-unknown-error-delete`). Kept for the Firefox
 * versions without a fix, even once 1541550 lands.
 *
 * Counted from the first failure, not from the first attempt: that failure
 * arrives only after Firefox's own 10 s, past `ACQUIRE_RETRY_BUDGET_MS`.
 */
export const BUSY_RETRY_BUDGET_MS = 10_000;

/**
 * `UnknownError` is WebIDL's "unknown transient reason", the name Firefox's
 * busy open surfaces as. Never match on the message, which is engine prose.
 */
const isBusyAtOpen = (error: unknown): boolean =>
  (error as { name?: unknown } | undefined)?.name === 'UnknownError';

/**
 * Instantiates the VFS, waiting out a worker of this origin that has just died
 * and still holds the files.
 *
 * `AccessHandlePoolVFS` acquires EVERY file in its directory exclusively, and a
 * worker killed INSIDE a statement keeps its OPFS sync access handles far
 * longer than an idle one: ~2000 ms against ~65 ms, measured on Chromium
 * 2026-09-16. Both callers open squarely inside that window — a pool worker
 * restarted by `handleDeath`, which terminates and respawns in one synchronous
 * pass, and the delete worker a consumer reaches by calling `close()` and then
 * `deleteDatabase()`, which is the ordinary sequence.
 *
 * **Waiting here is waiting for a corpse, not hoping.** The caller already
 * holds the connection lock exclusively, so no other CLIENT can be in this
 * file; on a VFS that takes its whole directory the only possible holder is a
 * worker of ours on its way out. That is what makes a retry correct rather
 * than a papering-over.
 *
 * Bounded at 10 s although `openTimeout` and `DELETE_TIMEOUT` (30 s each)
 * already bound it from outside — deliberately, and below them: a holder that
 * is NOT ours (another application on this origin using the same VFS directly)
 * must still surface the engine's own error, which says what is wrong, rather
 * than the caller's timeout, which does not. The 10 s is one measurement plus
 * margin, not a ceiling: 2039 ms was one machine, one engine, one statement.
 *
 * An IndexedDB open Firefox gave up on is retried too, on a budget of its own
 * (`BUSY_RETRY_BUDGET_MS`).
 */
export const createVfsInstance = async (
  vfsClass: VFSClass,
  vfs: string,
  module: WASQLiteModule,
  onWait: () => void,
): Promise<unknown> => {
  const heldDeadline = Date.now() + ACQUIRE_RETRY_BUDGET_MS;
  let busyDeadline: number | undefined;
  let waiting = false;
  for (;;) {
    try {
      return await vfsClass.create(vfs, module, { lockPolicy: 'shared' });
    } catch (error) {
      const now = Date.now();
      let deadline: number | undefined;
      if (isHeldElsewhere(error)) deadline = heldDeadline;
      else if (isBusyAtOpen(error)) {
        deadline = busyDeadline ??= now + BUSY_RETRY_BUDGET_MS;
      }
      if (deadline === undefined || now >= deadline) throw error;
      if (!waiting) {
        waiting = true;
        onWait();
      }
      await new Promise((resolve) =>
        setTimeout(resolve, ACQUIRE_RETRY_INTERVAL_MS),
      );
    }
  }
};
