import type { RowsBlock } from '../../../src/types/protocol';

/** One encoded value, by tag. */
export type Cell =
  | null
  | { int32: number }
  | { int64: bigint }
  | { float: number }
  | { text: string | Uint8Array }
  | { blob: Uint8Array };

const utf8 = new TextEncoder();

/** Test-only: a block of `cells.length / columns.length` rows. */
export const rowsBlock = (columns: string[], cells: Cell[]): RowsBlock => {
  const parts: Uint8Array[] = [];
  for (const c of cells) {
    if (c === null) {
      parts.push(Uint8Array.of(0));
    } else if ('int32' in c) {
      const b = new Uint8Array(5);
      b[0] = 1;
      new DataView(b.buffer).setInt32(1, c.int32, true);
      parts.push(b);
    } else if ('int64' in c) {
      const b = new Uint8Array(9);
      b[0] = 5;
      const dv = new DataView(b.buffer);
      dv.setInt32(1, Number(BigInt.asIntN(32, c.int64)), true);
      dv.setInt32(5, Number(c.int64 >> 32n), true);
      parts.push(b);
    } else if ('float' in c) {
      const b = new Uint8Array(9);
      b[0] = 2;
      new DataView(b.buffer).setFloat64(1, c.float, true);
      parts.push(b);
    } else {
      const isText = 'text' in c;
      const raw = isText ? c.text : c.blob;
      const bytes = typeof raw === 'string' ? utf8.encode(raw) : raw;
      const b = new Uint8Array(5 + bytes.length);
      b[0] = isText ? 3 : 4;
      new DataView(b.buffer).setUint32(1, bytes.length, true);
      b.set(bytes, 5);
      parts.push(b);
    }
  }
  const used = parts.reduce((n, p) => n + p.length, 0);
  // Larger than `used`, as the worker's buffers are.
  const buffer = new ArrayBuffer(used + 16);
  const u8 = new Uint8Array(buffer);
  let off = 0;
  for (const p of parts) {
    u8.set(p, off);
    off += p.length;
  }
  return {
    columns,
    rows: columns.length ? cells.length / columns.length : 0,
    buffer,
    used,
  };
};

/** One column of the fake statement's current row, as SQLite would type it. */
export type FakeCell =
  | { type: 1; value: bigint }
  | { type: 2; value: number }
  | { type: 3 | 4; bytes: Uint8Array }
  | { type: 5 };

/**
 * Test-only: the column API of a statement whose current row is `cells`,
 * text and blobs placed in a fake heap. A blob of length 0 has pointer 0, as
 * `sqlite3_column_blob` returns for an empty blob.
 */
export const fakeModule = (cells: FakeCell[]): WASQLiteModule => {
  const HEAPU8 = new Uint8Array(1 << 20);
  const ptrs: number[] = [];
  let at = 8;
  for (const c of cells) {
    if ((c.type === 3 || c.type === 4) && c.bytes.length > 0) {
      HEAPU8.set(c.bytes, at);
      ptrs.push(at);
      at += c.bytes.length;
    } else {
      ptrs.push(0);
    }
  }
  let tempRet = 0;
  const cell = (i: number) => cells[i] as FakeCell;
  return {
    HEAPU8,
    _sqlite3_column_type: (_s: number, i: number) => cell(i).type,
    _sqlite3_column_int64: (_s: number, i: number) => {
      const v = (cell(i) as { value: bigint }).value;
      tempRet = Number(v >> 32n);
      return Number(BigInt.asIntN(32, v));
    },
    getTempRet0: () => tempRet,
    _sqlite3_column_double: (_s: number, i: number) =>
      (cell(i) as { value: number }).value,
    _sqlite3_column_text: (_s: number, i: number) => ptrs[i] as number,
    _sqlite3_column_blob: (_s: number, i: number) => ptrs[i] as number,
    _sqlite3_column_bytes: (_s: number, i: number) =>
      (cell(i) as { bytes: Uint8Array }).bytes.length,
  } as unknown as WASQLiteModule;
};
