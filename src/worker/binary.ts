import * as SQLite from 'wa-sqlite/src/sqlite-api.js';
import {
  SQLITE_BLOB,
  SQLITE_FLOAT,
  SQLITE_INTEGER,
  SQLITE_MISUSE,
  SQLITE_NOMEM,
  SQLITE_OK,
  SQLITE_TEXT,
} from 'wa-sqlite/src/sqlite-constants.js';
import type { ParamsBlock, RowsBlock } from '../types/protocol';

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
  let total = 0;
  for (const n of block.used) total += n;
  const ptr: number = module._sqlite3_malloc(Math.max(1, total));
  if (!ptr)
    throw new SQLite.SQLiteError('out of memory binding params', SQLITE_NOMEM);
  try {
    let at = ptr;
    for (let k = 0; k < block.chunks.length; k++) {
      const n = block.used[k] as number;
      // HEAPU8 is read at each use: a malloc may have grown the heap.
      module.HEAPU8.set(
        new Uint8Array(block.chunks[k] as ArrayBuffer, 0, n),
        at,
      );
      at += n;
    }
    const bound = Math.min(block.count, sqlite.bind_parameter_count(stmt));
    let heap: Uint8Array = module.HEAPU8;
    let dv = new DataView(heap.buffer);
    let off = ptr;
    for (let i = 1; i <= bound; i++) {
      if (heap.buffer !== module.HEAPU8.buffer) {
        heap = module.HEAPU8;
        dv = new DataView(heap.buffer);
      }
      const tag = heap[off];
      let rc: number;
      if (tag === 0) {
        rc = module._sqlite3_bind_null(stmt, i);
        off += 1;
      } else if (tag === 1) {
        rc = module._sqlite3_bind_int(stmt, i, dv.getInt32(off + 1, true));
        off += 5;
      } else if (tag === 2) {
        rc = module._sqlite3_bind_double(stmt, i, dv.getFloat64(off + 1, true));
        off += 9;
      } else if (tag === 5) {
        rc = sqlite.bind_int64(stmt, i, dv.getBigInt64(off + 1, true));
        off += 9;
      } else if (tag === 3 || tag === 4) {
        const n = dv.getUint32(off + 1, true);
        rc =
          tag === 3
            ? module._sqlite3_bind_text(stmt, i, off + 5, n, 0)
            : module._sqlite3_bind_blob(stmt, i, off + 5, n, 0);
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
    module._sqlite3_free(ptr);
    throw e;
  }
  return ptr;
};

const MIN_ROW_BYTES = 4096;

/**
 * Writes a chunk of result rows into one buffer, read straight from SQLite's
 * column API, in `RowsBlock`'s format. The buffer starts at 4 KiB or at
 * `initial` — the size the query's previous chunk needed — and doubles by
 * copy: `ArrayBuffer.prototype.transfer` is newer than the Firefox floor.
 */
export class RowWriter {
  rows = 0;
  #buffer: ArrayBuffer;
  #u8: Uint8Array;
  #dv: DataView;
  #off = 0;

  constructor(initial = 0) {
    this.#buffer = new ArrayBuffer(Math.max(MIN_ROW_BYTES, initial));
    this.#u8 = new Uint8Array(this.#buffer);
    this.#dv = new DataView(this.#buffer);
  }

  #room(n: number) {
    const need = this.#off + n;
    if (need <= this.#buffer.byteLength) return;
    let size = this.#buffer.byteLength * 2;
    while (size < need) size *= 2;
    const next = new ArrayBuffer(size);
    const u8 = new Uint8Array(next);
    u8.set(this.#u8.subarray(0, this.#off));
    this.#buffer = next;
    this.#u8 = u8;
    this.#dv = new DataView(next);
  }

  /** Appends the statement's current row, its first `n` columns. */
  row(module: WASQLiteModule, stmt: number, n: number) {
    for (let i = 0; i < n; i++) {
      const type = module._sqlite3_column_type(stmt, i);
      if (type === SQLITE_INTEGER) {
        const lo = module._sqlite3_column_int64(stmt, i);
        const hi = module.getTempRet0();
        if (hi === lo >> 31) {
          this.#room(5);
          this.#u8[this.#off] = 1;
          this.#dv.setInt32(this.#off + 1, lo, true);
          this.#off += 5;
        } else {
          this.#room(9);
          this.#u8[this.#off] = 5;
          this.#dv.setInt32(this.#off + 1, lo, true);
          this.#dv.setInt32(this.#off + 5, hi, true);
          this.#off += 9;
        }
      } else if (type === SQLITE_FLOAT) {
        this.#room(9);
        this.#u8[this.#off] = 2;
        this.#dv.setFloat64(
          this.#off + 1,
          module._sqlite3_column_double(stmt, i),
          true,
        );
        this.#off += 9;
      } else if (type === SQLITE_TEXT || type === SQLITE_BLOB) {
        // Pointer first, then the byte count: SQLite's recommended order,
        // which wa-sqlite's column_text follows.
        const ptr =
          type === SQLITE_TEXT
            ? module._sqlite3_column_text(stmt, i)
            : module._sqlite3_column_blob(stmt, i);
        const len = module._sqlite3_column_bytes(stmt, i);
        if (type === SQLITE_TEXT && ptr === 0) {
          // An allocation failure: wa-sqlite's readUTF8 gives null.
          this.#room(1);
          this.#u8[this.#off] = 0;
          this.#off += 1;
          continue;
        }
        this.#room(5 + len);
        this.#u8[this.#off] = type === SQLITE_TEXT ? 3 : 4;
        this.#dv.setUint32(this.#off + 1, len, true);
        // HEAPU8 read after the calls: the heap may have grown during them.
        this.#u8.set(module.HEAPU8.subarray(ptr, ptr + len), this.#off + 5);
        this.#off += 5 + len;
      } else {
        this.#room(1);
        this.#u8[this.#off] = 0;
        this.#off += 1;
      }
    }
    this.rows++;
  }

  /** The chunk, ready to send; its buffer is transferred, so the writer is spent. */
  finish(columns: string[]): RowsBlock {
    return {
      columns,
      rows: this.rows,
      buffer: this.#buffer,
      used: this.#off,
    };
  }
}
