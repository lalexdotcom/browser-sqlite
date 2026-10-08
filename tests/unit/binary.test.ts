import { describe, expect, it } from '@rstest/core';
import {
  decodeRows,
  EncodedParams,
  encodeParams,
  ParamsWriter,
  prepareParams,
} from '../../src/binary';
import { decodeParams } from './helpers/params';
import { rowsBlock } from './helpers/rows';

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

  it('decodes an empty block', () => {
    expect(decodeRows(rowsBlock(['a'], []))).toEqual([]);
  });
});
