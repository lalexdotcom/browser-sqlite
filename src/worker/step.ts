/**
 * A `step()` that stays synchronous when the call returned a number.
 *
 * wa-sqlite's `sqlite3.step()` is an `async` function awaiting the `async`
 * `retry()`, so every row pays promise turns even when nothing suspended. This
 * module reproduces `retry()` and `check()` from `wa-sqlite/src/sqlite-api.js`
 * (and the raw call `sqlite3.step` makes per build), looking at what the call
 * returned instead of assuming it. `tests/unit/lib/wa-sqlite-pin.test.ts`
 * guards the reproduced code against a repin.
 */
import { SQLiteError } from 'wa-sqlite/src/sqlite-api.js';
import {
  SQLITE_DONE,
  SQLITE_ERROR,
  SQLITE_OK,
  SQLITE_ROW,
} from 'wa-sqlite/src/sqlite-constants.js';
import type { SQLiteBuild } from '../const/builds';

export type Step = (stmt: number) => number | Promise<number>;

export function createStep(
  module: WASQLiteModule,
  build: SQLiteBuild,
  db: number,
): Step {
  // `sync` and `jspi` call the raw export (`jspi`'s is a `promising` one). On
  // `async` the `ccall` without its `async` option returns the number, or a
  // promise when the call unwound.
  const call: Step =
    build === 'async'
      ? (stmt) => module.ccall('sqlite3_step', 'number', ['number'], [stmt])
      : (stmt) => module._sqlite3_step(stmt);

  // `sqlite3.step`'s `check`: only a row or the end is not an error.
  const check = (rc: number): number => {
    if (rc === SQLITE_ROW || rc === SQLITE_DONE) return rc;
    throw new SQLiteError(
      module.ccall('sqlite3_errmsg', 'string', ['number'], [db]),
      rc,
    );
  };

  // `retry()`'s pending-operations wait. Both arrays are read from the module
  // each time: wa-sqlite reassigns them, never clears them in place.
  const settle = async (rc: number): Promise<number> => {
    try {
      await Promise.all(module.pendingOps);
    } catch (e) {
      console.error('Error in pendingOps:', e);
      return (e as { code?: number }).code || SQLITE_ERROR;
    } finally {
      module.pendingOps = [];
    }
    return rc;
  };

  // What `retry()` does after a call that returned `rc`, on attempt `attempt`.
  const after = (
    rc: number,
    stmt: number,
    attempt: number,
  ): number | Promise<number> => {
    if (rc === SQLITE_OK || module.retryOps.length === 0) {
      return module.pendingOps.length === 0
        ? check(rc)
        : settle(rc).then(check);
    }
    return attempt === 0 ? again(stmt, 1) : check(rc);
  };

  // `retry()`'s loop head: wait for the queued retry operations, call, go on.
  const again = async (stmt: number, attempt: number): Promise<number> => {
    if (module.retryOps.length) {
      try {
        await Promise.all(module.retryOps);
      } finally {
        module.retryOps = [];
      }
    }
    return after(await call(stmt), stmt, attempt);
  };

  return (stmt) => {
    if (module.retryOps.length) return again(stmt, 0);
    const rc = call(stmt);
    return typeof rc === 'number'
      ? after(rc, stmt, 0)
      : rc.then((resolved) => after(resolved, stmt, 0));
  };
}
