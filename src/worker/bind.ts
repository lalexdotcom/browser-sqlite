import * as SQLite from 'wa-sqlite/src/sqlite-api.js';
import {
  SQLITE_MISUSE,
  SQLITE_NOMEM,
  SQLITE_OK,
} from 'wa-sqlite/src/sqlite-constants.js';
import type { ParamsBlock } from '../types/protocol';

/**
 * Copies the block into one wasm allocation and binds from it, SQLITE_STATIC:
 * the allocation must outlive the bindings, so the caller frees the returned
 * pointer only after clearing them. Binds as many values as the statement has
 * parameters, by index, as wa-sqlite's `bind_collection` does.
 */
export const bindBlock = (
  module: WASQLiteModule,
  sqlite: SQLiteAPI,
  stmt: number,
  block: ParamsBlock,
): number => {
  const m = module as any;
  let total = 0;
  for (const n of block.used) total += n;
  const ptr: number = m._sqlite3_malloc(Math.max(1, total));
  if (!ptr)
    throw new SQLite.SQLiteError('out of memory binding params', SQLITE_NOMEM);
  try {
    let at = ptr;
    for (let k = 0; k < block.chunks.length; k++) {
      const n = block.used[k] as number;
      // HEAPU8 is read at each use: a malloc may have grown the heap.
      m.HEAPU8.set(new Uint8Array(block.chunks[k] as ArrayBuffer, 0, n), at);
      at += n;
    }
    const bound = Math.min(block.count, sqlite.bind_parameter_count(stmt));
    let heap: Uint8Array = m.HEAPU8;
    let dv = new DataView(heap.buffer);
    let off = ptr;
    for (let i = 1; i <= bound; i++) {
      if (heap.buffer !== m.HEAPU8.buffer) {
        heap = m.HEAPU8;
        dv = new DataView(heap.buffer);
      }
      const tag = heap[off];
      let rc: number;
      if (tag === 0) {
        rc = m._sqlite3_bind_null(stmt, i);
        off += 1;
      } else if (tag === 1) {
        rc = m._sqlite3_bind_int(stmt, i, dv.getInt32(off + 1, true));
        off += 5;
      } else if (tag === 2) {
        rc = m._sqlite3_bind_double(stmt, i, dv.getFloat64(off + 1, true));
        off += 9;
      } else if (tag === 5) {
        rc = sqlite.bind_int64(stmt, i, dv.getBigInt64(off + 1, true));
        off += 9;
      } else if (tag === 3 || tag === 4) {
        const n = dv.getUint32(off + 1, true);
        rc =
          tag === 3
            ? m._sqlite3_bind_text(stmt, i, off + 5, n, 0)
            : m._sqlite3_bind_blob(stmt, i, off + 5, n, 0);
        off += 5 + n;
      } else {
        throw new SQLite.SQLiteError(
          `unknown params tag ${tag}`,
          SQLITE_MISUSE,
        );
      }
      if (rc !== SQLITE_OK)
        throw new SQLite.SQLiteError(`binding parameter ${i} failed`, rc);
    }
  } catch (e) {
    m._sqlite3_free(ptr);
    throw e;
  }
  return ptr;
};
