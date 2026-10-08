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
