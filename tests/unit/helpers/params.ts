import { EncodedParams } from '../../../src/encode';
import type { ParamsBlock } from '../../../src/types/protocol';
import type { Bindable } from '../../../src/values';

const utf8 = new TextDecoder();

/** Test-only: the values a block carries, in order. */
export const decodeParams = (p: EncodedParams | ParamsBlock): Bindable[] => {
  const out: Bindable[] = [];
  for (let k = 0; k < p.chunks.length; k++) {
    const buf = p.chunks[k] as ArrayBuffer;
    const end = p.used[k] as number;
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let off = 0;
    while (off < end) {
      const tag = u8[off];
      if (tag === 0) {
        out.push(null);
        off += 1;
      } else if (tag === 1) {
        out.push(dv.getInt32(off + 1, true));
        off += 5;
      } else if (tag === 2) {
        out.push(dv.getFloat64(off + 1, true));
        off += 9;
      } else if (tag === 5) {
        out.push(dv.getBigInt64(off + 1, true));
        off += 9;
      } else {
        const n = dv.getUint32(off + 1, true);
        const bytes = u8.subarray(off + 5, off + 5 + n);
        out.push(tag === 3 ? utf8.decode(bytes) : bytes.slice());
        off += 5 + n;
      }
    }
  }
  return out;
};

/** Test-only: what the worker would run for a call `bulk.ts` made. */
export const expandCall = (sql: string, params: unknown) =>
  params instanceof EncodedParams
    ? {
        sql:
          params.pattern === undefined
            ? sql
            : sql + new Array(params.rows).fill(params.pattern).join(','),
        params: decodeParams(params) as unknown[],
      }
    : { sql, params: params as unknown[] | undefined };
