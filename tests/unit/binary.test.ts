import { describe, expect, it } from '@rstest/core';
import {
  decodeRows,
  EncodedParams,
  encodeParams,
  ParamsWriter,
  prepareParams,
} from '../../src/binary';
import { RowWriter } from '../../src/worker/binary';
import { decodeParams } from './helpers/params';
import { fakeModule, rowsBlock } from './helpers/rows';

const MiB = 1 << 20;

describe('encodeParams', () => {
  it('round-trips every bindable value', () => {
    const blob = Uint8Array.of(0, 255, 7);
    const values = [
      null,
      undefined,
      0,
      -1,
      2 ** 31 - 1,
      -(2 ** 31),
      2 ** 31,
      1.5,
      -0,
      Number.NaN,
      2n ** 63n - 1n,
      -(2n ** 63n),
      '',
      'é€😀',
      blob,
      new Uint8Array(0),
      true,
      false,
    ];
    expect(decodeParams(encodeParams(values))).toEqual([
      null,
      null,
      0,
      -1,
      2 ** 31 - 1,
      -(2 ** 31),
      2 ** 31,
      1.5,
      0,
      Number.NaN,
      2n ** 63n - 1n,
      -(2n ** 63n),
      '',
      'é€😀',
      blob,
      new Uint8Array(0),
      1,
      0,
    ]);
  });

  it('counts values and leaves rows at 0', () => {
    const p = encodeParams([1, 'a']);
    expect(p.count).toBe(2);
    expect(p.rows).toBe(0);
    expect(p.pattern).toBeUndefined();
  });

  it('gives a value larger than a chunk a chunk of its own', () => {
    const big = 'x'.repeat(MiB + 10);
    const p = encodeParams(['a', big, 'b']);
    expect(decodeParams(p)).toEqual(['a', big, 'b']);
    for (let k = 0; k < p.chunks.length; k++) {
      const used = p.used[k] as number;
      expect(used).toBeGreaterThan(0);
      expect(used).toBeLessThanOrEqual((p.chunks[k] as ArrayBuffer).byteLength);
    }
  });

  it('does not allocate empty chunks for a single large value', () => {
    const big = 'x'.repeat(MiB + 10);
    const p = encodeParams([big]);
    expect(p.chunks).toHaveLength(1);
    expect(p.used[0]).toBeGreaterThan(0);
    expect((p.chunks[0] as ArrayBuffer).byteLength).toBe(5 + big.length * 3);
  });

  it('refuses to be sent twice', () => {
    const p = encodeParams([1]);
    p.toMessage();
    expect(() => p.toMessage()).toThrow('encoded params were already sent');
  });
});

describe('ParamsWriter', () => {
  it('never splits a value across chunks', () => {
    const w = new ParamsWriter();
    const s = 'y'.repeat(1000);
    for (let i = 0; i < 3000; i++) w.value(s); // ~3 MB: several chunks
    const p = w.finish();
    expect(p.chunks.length).toBeGreaterThan(1);
    expect(decodeParams(p)).toEqual(new Array(3000).fill(s));
  });

  it('rolls a row back, also after it opened a new chunk', () => {
    const w = new ParamsWriter();
    w.mark();
    w.value(1);
    w.value('a');
    w.endRow();
    // Reserved at 3 bytes per unit, this string cannot fit the first chunk:
    // the row's second value opens a second one, which the rollback drops.
    w.mark();
    w.value(2);
    w.value('z'.repeat(MiB / 2));
    w.rollback();
    w.mark();
    w.value(3);
    w.value('c');
    w.endRow();
    const p = w.finish('(?,?)');
    expect(p.chunks).toHaveLength(1);
    expect(p.rows).toBe(2);
    expect(p.count).toBe(4);
    expect(p.pattern).toBe('(?,?)');
    expect(decodeParams(p)).toEqual([1, 'a', 3, 'c']);
  });

  it('restores coherent state on rollback of lazy writer mark', () => {
    const w = new ParamsWriter();
    w.mark();
    w.value('z'.repeat(MiB / 2));
    w.rollback();
    w.mark();
    w.value(1);
    w.endRow();
    const p = w.finish();
    expect(p.chunks).toHaveLength(1);
    expect(decodeParams(p)).toEqual([1]);
  });
});

describe('prepareParams', () => {
  it('passes an EncodedParams through and converts an array', () => {
    const p = encodeParams([1]);
    expect(prepareParams(p)).toBe(p);
    expect(prepareParams([{ a: 1 }])).toEqual(['{"a":1}']);
    expect(prepareParams(undefined)).toBeUndefined();
    expect(p).toBeInstanceOf(EncodedParams);
  });
});

describe('decodeRows', () => {
  const one = (cell: Parameters<typeof rowsBlock>[1][number]) =>
    decodeRows(rowsBlock(['v'], [cell]))[0]?.v;

  it('decodes every tag', () => {
    expect(one(null)).toBe(null);
    expect(one({ int32: -(2 ** 31) })).toBe(-(2 ** 31));
    expect(one({ int32: 2 ** 31 - 1 })).toBe(2 ** 31 - 1);
    expect(one({ float: 1.5 })).toBe(1.5);
    expect(Object.is(one({ float: -0 }), -0)).toBe(true);
    expect(one({ float: 1e308 })).toBe(1e308);
    expect(one({ text: 'é€😀' })).toBe('é€😀');
    expect(one({ text: '' })).toBe('');
    expect(one({ blob: Uint8Array.of(0, 255) })).toEqual(Uint8Array.of(0, 255));
    expect(one({ blob: new Uint8Array(0) })).toEqual(new Uint8Array(0));
  });

  it('applies wa-sqlite cvt32x2AsSafe rule to int64', () => {
    expect(one({ int64: 2n ** 31n })).toBe(2 ** 31);
    expect(one({ int64: -1n })).toBe(-1);
    expect(one({ int64: 2n ** 53n - 1n })).toBe(2 ** 53 - 1);
    expect(one({ int64: -(2n ** 53n) + 1n })).toBe(-(2 ** 53) + 1);
    expect(one({ int64: 2n ** 53n })).toBe(2n ** 53n);
    expect(one({ int64: -(2n ** 53n) })).toBe(-(2 ** 53));
    expect(one({ int64: -(2n ** 53n) - 1n })).toBe(-(2n ** 53n) - 1n);
    expect(one({ int64: 2n ** 63n - 1n })).toBe(2n ** 63n - 1n);
    expect(one({ int64: -(2n ** 63n) })).toBe(-(2n ** 63n));
  });

  it('decodes text as wa-sqlite readUTF8 does', () => {
    expect(one({ text: Uint8Array.of(0xff) })).toBe('�');
    expect(one({ text: Uint8Array.of(0x61, 0, 0x62) })).toBe('a\0b');
    // ignoreBOM: true keeps a leading byte-order mark.
    expect(one({ text: Uint8Array.of(0xef, 0xbb, 0xbf, 0x78) })).toBe('﻿x');
  });

  it('copies each blob into a buffer of its own', () => {
    const block = rowsBlock(
      ['a', 'b'],
      [{ blob: Uint8Array.of(1, 2, 3) }, { int32: 7 }],
    );
    const v = decodeRows(block)[0]?.a as Uint8Array;
    expect(v.buffer).not.toBe(block.buffer);
    expect(v.buffer.byteLength).toBe(3);
    new Uint8Array(block.buffer).fill(0);
    expect(v).toEqual(Uint8Array.of(1, 2, 3));
  });

  it('builds the rows in order, a duplicated column keeping its last value', () => {
    expect(
      decodeRows(
        rowsBlock(
          ['id', 'x', 'x'],
          [
            { int32: 1 },
            { text: 'a' },
            { text: 'b' },
            { int32: 2 },
            null,
            { float: 0.5 },
          ],
        ),
      ),
    ).toEqual([
      { id: 1, x: 'b' },
      { id: 2, x: 0.5 },
    ]);
  });

  it('does not assign a column named __proto__, as the structured clone did', () => {
    const block = rowsBlock(
      ['id', '__proto__'],
      [{ int32: 1 }, null, { int32: 2 }, { blob: Uint8Array.of(1) }],
    );
    for (const row of decodeRows(block)) {
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.keys(row)).toEqual(['id']);
    }
  });

  it('decodes an empty block', () => {
    expect(decodeRows(rowsBlock(['a'], []))).toEqual([]);
  });
});

describe('decodeRows short texts', () => {
  const reference = new TextDecoder('utf-8', { ignoreBOM: true });
  const decodeText = (bytes: Uint8Array) =>
    decodeRows(rowsBlock(['v'], [{ text: bytes }]))[0]?.v;
  const utf8 = new TextEncoder();

  it('decodes valid UTF-8 on both sides of 32 bytes as TextDecoder does', () => {
    const texts: string[] = [];
    for (let n = 0; n <= 40; n++) texts.push('a'.repeat(n));
    for (let n = 1; n <= 20; n++) texts.push('é'.repeat(n));
    for (let n = 1; n <= 12; n++) texts.push('€'.repeat(n));
    for (let n = 1; n <= 10; n++) texts.push('😀'.repeat(n));
    texts.push(
      'aé€😀',
      '\0',
      'a\0b',
      '﻿x',
      '﻿',
      '￿',
      '\u{10ffff}',
      '\u0080',
      '߿',
      'ࠀ',
    );
    for (const t of texts) {
      const bytes = utf8.encode(t);
      expect(decodeText(bytes)).toBe(reference.decode(bytes));
      expect(decodeText(bytes)).toBe(t);
    }
  });

  it('decodes invalid UTF-8 exactly as TextDecoder does, short or long', () => {
    const invalid = [
      [0xff],
      [0x80],
      [0xc0, 0xaf],
      [0xc1, 0xbf],
      [0xc3],
      [0xc3, 0x41],
      [0x41, 0xc3],
      [0xe0, 0x80, 0x8f],
      [0xe2, 0x82],
      [0xed, 0xa0, 0x80],
      [0xed, 0xbf, 0xbf],
      [0xf0],
      [0xf0, 0x8f, 0xbf, 0xbf],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf5, 0x80, 0x80, 0x80],
      [0xf0, 0x9f, 0x98],
    ];
    for (const seq of invalid) {
      for (const pad of [0, 28, 40]) {
        const bytes = Uint8Array.from([...Array(pad).fill(0x61), ...seq]);
        expect(decodeText(bytes)).toBe(reference.decode(bytes));
        const after = Uint8Array.from([...seq, ...Array(pad).fill(0x62)]);
        expect(decodeText(after)).toBe(reference.decode(after));
      }
    }
  });

  it('decodes texts of exactly 31, 32 and 33 bytes', () => {
    for (const n of [31, 32, 33]) {
      const ascii = utf8.encode('x'.repeat(n));
      expect(decodeText(ascii)).toBe('x'.repeat(n));
      // A four-byte character straddling the threshold.
      const mixed = utf8.encode(`${'y'.repeat(n - 4)}😀`);
      expect(decodeText(mixed)).toBe(reference.decode(mixed));
    }
  });
});

describe('RowWriter', () => {
  const roundTrip = (cells: Parameters<typeof fakeModule>[0]) => {
    const w = new RowWriter();
    w.row(fakeModule(cells), 0, cells.length);
    const block = w.finish(cells.map((_, i) => `c${i}`));
    return { block, values: Object.values(decodeRows(block)[0] ?? {}) };
  };

  it('writes every column type and decodes back to it', () => {
    const { values } = roundTrip([
      { type: 1, value: 0n },
      { type: 1, value: -(2n ** 31n) },
      { type: 1, value: 2n ** 31n },
      { type: 1, value: 2n ** 53n },
      { type: 1, value: -(2n ** 63n) },
      { type: 2, value: 1.5 },
      { type: 3, bytes: new TextEncoder().encode('é€😀') },
      { type: 3, bytes: new Uint8Array(0) },
      { type: 4, bytes: Uint8Array.of(9, 8) },
      { type: 4, bytes: new Uint8Array(0) },
      { type: 5 },
    ]);
    expect(values).toEqual([
      0,
      -(2 ** 31),
      2 ** 31,
      2n ** 53n,
      -(2n ** 63n),
      1.5,
      'é€😀',
      '',
      Uint8Array.of(9, 8),
      new Uint8Array(0),
      null,
    ]);
  });

  it('writes NULL for a text whose pointer is 0, as readUTF8 gives null', () => {
    const { values } = roundTrip([
      { type: 3, bytes: new Uint8Array(0), nullPointer: true },
      { type: 3, bytes: new Uint8Array(0) },
      { type: 4, bytes: new Uint8Array(0) },
    ]);
    expect(values).toEqual([null, '', new Uint8Array(0)]);
  });

  it('writes an int32 in 5 bytes and a wider integer in 9', () => {
    expect(roundTrip([{ type: 1, value: -1n }]).block.used).toBe(5);
    expect(roundTrip([{ type: 1, value: 2n ** 31n }]).block.used).toBe(9);
  });

  it('grows past its initial size for a large value, by copy', () => {
    const big = new Uint8Array(300_000).fill(7);
    const w = new RowWriter();
    const m1 = fakeModule([{ type: 3, bytes: Uint8Array.of(0x61) }]);
    for (let i = 0; i < 100; i++) w.row(m1, 0, 1);
    w.row(fakeModule([{ type: 4, bytes: big }]), 0, 1);
    const block = w.finish(['v']);
    expect(block.rows).toBe(101);
    expect(block.buffer.byteLength).toBeGreaterThanOrEqual(block.used);
    const rows = decodeRows(block);
    expect(rows[99]).toEqual({ v: 'a' });
    expect(rows[100]?.v).toEqual(big);
  });

  it('starts at the size it is given', () => {
    expect(
      new RowWriter(10_000).finish([]).buffer.byteLength,
    ).toBeGreaterThanOrEqual(10_000);
    expect(new RowWriter().finish([]).buffer.byteLength).toBe(4096);
  });

  it('counts its rows', () => {
    const w = new RowWriter();
    const m = fakeModule([{ type: 5 }, { type: 2, value: 2 }]);
    w.row(m, 0, 2);
    w.row(m, 0, 2);
    expect(w.rows).toBe(2);
    expect(decodeRows(w.finish(['a', 'b']))).toEqual([
      { a: null, b: 2 },
      { a: null, b: 2 },
    ]);
  });
});
