import { describe, expect, it } from '@rstest/core';
import {
  EncodedParams,
  encodeParams,
  ParamsWriter,
  prepareParams,
} from '../../src/encode';
import { decodeParams } from './helpers/params';

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
    for (let k = 0; k < p.chunks.length; k++)
      expect(p.used[k]).toBeLessThanOrEqual(
        (p.chunks[k] as ArrayBuffer).byteLength,
      );
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
