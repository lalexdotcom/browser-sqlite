import type { ParamsBlock } from './types/protocol';
import { type Bindable, convertParams } from './values';

const CHUNK_BYTES = 1 << 20;
const utf8 = new TextEncoder();

/** Params ready to send. Its chunks are transferred, so it is sent once. */
export class EncodedParams {
  #sent = false;
  constructor(
    readonly chunks: ArrayBuffer[],
    readonly used: number[],
    readonly count: number,
    readonly rows: number,
    readonly pattern: string | undefined,
  ) {}

  toMessage(): ParamsBlock {
    if (this.#sent) throw new Error('encoded params were already sent');
    this.#sent = true;
    return {
      chunks: this.chunks,
      used: this.used,
      count: this.count,
      rows: this.rows,
    };
  }
}

/** Writes values into 1 MiB chunks; a row can be rolled back to its mark. */
export class ParamsWriter {
  rows = 0;
  #chunks: ArrayBuffer[] = [];
  #used: number[] = [];
  #buf: ArrayBuffer | undefined;
  #u8 = new Uint8Array(0);
  #dv = new DataView(new ArrayBuffer(0));
  #off = 0;
  #count = 0;
  #markChunks = 0;
  #markOff = 0;
  #markCount = 0;
  #markBuf: ArrayBuffer | undefined;

  /** `initial` sizes the first chunk; otherwise it is allocated on first use. */
  constructor(initial?: number) {
    if (initial !== undefined) this.#open(initial);
  }

  get count() {
    return this.#count;
  }

  #open(bytes: number) {
    this.#buf = new ArrayBuffer(bytes);
    this.#u8 = new Uint8Array(this.#buf);
    this.#dv = new DataView(this.#buf);
    this.#off = 0;
  }

  /** Room for `n` more bytes, in a new chunk if this one cannot hold them. */
  #room(n: number) {
    if (this.#buf && this.#off + n <= this.#buf.byteLength) return;
    if (this.#buf) {
      this.#chunks.push(this.#buf);
      this.#used.push(this.#off);
    }
    this.#open(Math.max(CHUNK_BYTES, n));
  }

  mark() {
    this.#markChunks = this.#chunks.length;
    this.#markOff = this.#off;
    this.#markCount = this.#count;
    this.#markBuf = this.#buf;
  }

  rollback() {
    if (this.#buf !== this.#markBuf) {
      this.#chunks.length = this.#markChunks;
      this.#used.length = this.#markChunks;
      if (this.#markBuf) {
        this.#buf = this.#markBuf;
        this.#u8 = new Uint8Array(this.#buf);
        this.#dv = new DataView(this.#buf);
      } else {
        this.#buf = undefined;
      }
    }
    this.#off = this.#markOff;
    this.#count = this.#markCount;
  }

  endRow() {
    this.rows++;
  }

  value(v: Bindable) {
    this.#count++;
    if (v === null || v === undefined) {
      this.#room(1);
      this.#u8[this.#off++] = 0;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : v;
      if (n === (n | 0)) {
        this.#room(5);
        this.#u8[this.#off] = 1;
        this.#dv.setInt32(this.#off + 1, n, true);
        this.#off += 5;
      } else {
        this.#room(9);
        this.#u8[this.#off] = 2;
        this.#dv.setFloat64(this.#off + 1, n, true);
        this.#off += 9;
      }
    } else if (typeof v === 'bigint') {
      this.#room(9);
      this.#u8[this.#off] = 5;
      this.#dv.setBigInt64(this.#off + 1, v, true);
      this.#off += 9;
    } else if (typeof v === 'string') {
      // Worst case: 3 UTF-8 bytes per UTF-16 unit.
      this.#room(5 + v.length * 3);
      const { written } = utf8.encodeInto(v, this.#u8.subarray(this.#off + 5));
      this.#u8[this.#off] = 3;
      this.#dv.setUint32(this.#off + 1, written, true);
      this.#off += 5 + written;
    } else {
      this.#room(5 + v.byteLength);
      this.#u8[this.#off] = 4;
      this.#dv.setUint32(this.#off + 1, v.byteLength, true);
      this.#u8.set(v, this.#off + 5);
      this.#off += 5 + v.byteLength;
    }
  }

  finish(pattern?: string): EncodedParams {
    if (this.#buf) {
      this.#chunks.push(this.#buf);
      this.#used.push(this.#off);
    }
    return new EncodedParams(
      this.#chunks,
      this.#used,
      this.#count,
      this.rows,
      pattern,
    );
  }
}

/** One query's params, sized for the worst case so most fit one chunk. */
export const encodeParams = (values: readonly Bindable[]): EncodedParams => {
  let bytes = 0;
  for (const v of values) {
    if (typeof v === 'string') bytes += 5 + v.length * 3;
    else if (v instanceof Uint8Array) bytes += 5 + v.byteLength;
    else bytes += 9;
  }
  const w = new ParamsWriter(Math.max(16, Math.min(bytes, CHUNK_BYTES)));
  for (const v of values) w.value(v);
  return w.finish();
};

export type QueryParams = readonly Bindable[] | EncodedParams;

/** At each entry point: converted params, or a block `bulk.ts` encoded. */
export const prepareParams = (
  params: readonly unknown[] | EncodedParams | undefined,
): QueryParams | undefined =>
  params instanceof EncodedParams ? params : convertParams(params);
