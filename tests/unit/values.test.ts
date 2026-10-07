import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/types/errors';
import {
  convertParams,
  jsonbColumns,
  toBindable,
  toSQLiteDate,
} from '../../src/values';

const instant = new Date(Date.UTC(2026, 9, 6, 12, 34, 56, 789));

describe('toSQLiteDate', () => {
  it('formats in UTC with milliseconds, as strftime %f does', () => {
    expect(toSQLiteDate(instant)).toBe('2026-10-06 12:34:56.789');
    expect(toSQLiteDate(new Date(Date.UTC(2026, 0, 1)))).toBe(
      '2026-01-01 00:00:00.000',
    );
  });

  it('throws RangeError on an invalid Date', () => {
    expect(() => toSQLiteDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('toBindable, ordinary column', () => {
  it('passes primitives and Uint8Array through', () => {
    const bytes = Uint8Array.of(1, 2, 44);
    for (const v of ['s', 1, 1.5, 10n, true, false, null, undefined, bytes]) {
      expect(toBindable(v, false)).toBe(v);
    }
  });

  it('binds an ArrayBuffer, a DataView and other typed arrays as their bytes', () => {
    const f32 = Float32Array.of(1, 2);
    const kinds: [string, unknown, number[]][] = [
      ['ArrayBuffer', Uint8Array.of(7, 8, 9).buffer, [7, 8, 9]],
      ['Float32Array', f32, [0, 0, 128, 63, 0, 0, 0, 64]],
      ['Int16Array', Int16Array.of(1, -2), [1, 0, 254, 255]],
      ['Uint8ClampedArray', Uint8ClampedArray.of(5, 6), [5, 6]],
      ['BigInt64Array', BigInt64Array.of(1n), [1, 0, 0, 0, 0, 0, 0, 0]],
      ['DataView', new DataView(Uint8Array.of(3, 4).buffer), [3, 4]],
    ];
    for (const [name, v, bytes] of kinds) {
      for (const jsonb of [false, true]) {
        const bound = toBindable(v, jsonb);
        expect(bound, name).toBeInstanceOf(Uint8Array);
        expect([...(bound as Uint8Array)], name).toEqual(bytes);
      }
    }
  });

  it('binds the range a sub-view covers, not its whole buffer', () => {
    const buf = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7).buffer;
    const view = new DataView(buf, 2, 3);
    expect([...(toBindable(view, false) as Uint8Array)]).toEqual([2, 3, 4]);
    const i16 = new Int16Array(buf, 4, 2);
    expect([...(toBindable(i16, true) as Uint8Array)]).toEqual([4, 5, 6, 7]);
    const u8 = new Uint8Array(buf, 1, 2);
    expect(toBindable(u8, false)).toBe(u8);
  });

  it('binds the bytes of a view over a SharedArrayBuffer', () => {
    const sab = new SharedArrayBuffer(4);
    new Uint8Array(sab).set([9, 8, 7, 6]);
    const bound = toBindable(new Int16Array(sab, 2, 1), false) as Uint8Array;
    expect([...bound]).toEqual([7, 6]);
    const target = new Uint8Array(2);
    target.set(bound);
    expect([...target]).toEqual([7, 6]);
  });

  it('stringifies objects and arrays', () => {
    expect(toBindable({ a: 1, b: [true, null] }, false)).toBe(
      '{"a":1,"b":[true,null]}',
    );
    expect(toBindable([1, 2, 300], false)).toBe('[1,2,300]');
    expect(toBindable(new Map([['a', 1]]), false)).toBe('{}');
    expect(toBindable({ toJSON: () => 'x' }, false)).toBe('"x"');
  });

  it('binds a Date in SQLite format, and a nested Date as JSON does', () => {
    expect(toBindable(instant, false)).toBe('2026-10-06 12:34:56.789');
    expect(toBindable({ at: instant }, false)).toBe(
      '{"at":"2026-10-06T12:34:56.789Z"}',
    );
  });

  it('binds undefined when toJSON returns undefined', () => {
    expect(toBindable({ toJSON: () => undefined }, false)).toBeUndefined();
  });
});

describe('toBindable, JSONB column', () => {
  it('passes numbers, bigint, null, undefined and Uint8Array through', () => {
    const bytes = Uint8Array.of(1);
    for (const v of [5, 10n, null, undefined, bytes]) {
      expect(toBindable(v, true)).toBe(v);
    }
  });

  it('stringifies strings, booleans, Dates, objects and arrays', () => {
    expect(toBindable('abc', true)).toBe('"abc"');
    expect(toBindable('{"a":1}', true)).toBe('"{\\"a\\":1}"');
    expect(toBindable(true, true)).toBe('true');
    expect(toBindable(false, true)).toBe('false');
    expect(toBindable(instant, true)).toBe('"2026-10-06T12:34:56.789Z"');
    expect(toBindable(new Date(Number.NaN), true)).toBe('null');
    expect(toBindable({ a: [1] }, true)).toBe('{"a":[1]}');
  });
});

describe('toBindable refusals', () => {
  const refused = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as SQLiteError;
    }
    throw new Error('expected a refusal');
  };

  it('wraps a conversion failure in INVALID_VALUE with the cause', () => {
    const nested = refused(() => toBindable({ n: 1n }, false, 'param 2'));
    expect(nested).toBeInstanceOf(SQLiteError);
    expect(nested.code).toBe('INVALID_VALUE');
    expect(nested.message).toContain('param 2');
    expect(nested.cause).toBeInstanceOf(TypeError);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(refused(() => toBindable(cycle, false)).cause).toBeInstanceOf(
      TypeError,
    );
    expect(
      refused(() => toBindable(new Date(Number.NaN), false)).cause,
    ).toBeInstanceOf(RangeError);
  });

  it('keeps the cause of a toJSON that throws a non-Error', () => {
    const e = refused(() =>
      toBindable(
        {
          toJSON: () => {
            throw 'x';
          },
        },
        false,
      ),
    );
    expect(e.code).toBe('INVALID_VALUE');
    expect(e.message).toContain('x');
    expect(e.cause).toBe('x');
    const n = refused(() =>
      toBindable(
        {
          toJSON: () => {
            throw null;
          },
        },
        false,
      ),
    );
    expect(n.code).toBe('INVALID_VALUE');
    expect(n.cause).toBeNull();
  });

  it('refuses a Symbol and a function, in both column kinds', () => {
    for (const jsonb of [false, true]) {
      expect(refused(() => toBindable(Symbol('s'), jsonb)).code).toBe(
        'INVALID_VALUE',
      );
      expect(refused(() => toBindable(() => 1, jsonb)).code).toBe(
        'INVALID_VALUE',
      );
    }
  });

  it('refuses a bigint outside int64 and keeps the bounds', () => {
    expect(toBindable(2n ** 63n - 1n, false)).toBe(2n ** 63n - 1n);
    expect(toBindable(-(2n ** 63n), false)).toBe(-(2n ** 63n));
    expect(refused(() => toBindable(2n ** 63n, false)).code).toBe(
      'INVALID_VALUE',
    );
    expect(refused(() => toBindable(-(2n ** 63n) - 1n, true)).code).toBe(
      'INVALID_VALUE',
    );
  });
});

describe('convertParams', () => {
  it('converts an array and passes undefined through', () => {
    expect(convertParams(undefined)).toBeUndefined();
    expect(convertParams([1, true, 'a'])).toEqual([1, true, 'a']);
  });

  it('refuses params that are not an array', () => {
    for (const bad of [{ ':a': 1 }, 5, 'x', null]) {
      let error: unknown;
      try {
        convertParams(bad as never);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SQLiteError);
      expect((error as SQLiteError).code).toBe('INVALID_VALUE');
      expect((error as SQLiteError).message).toContain(
        'params must be an array',
      );
    }
  });
});

describe('jsonbColumns', () => {
  it('flags the JSONB columns in keys order', () => {
    expect(jsonbColumns(['a', 'b', 'c'], { c: 'JSONB', a: 'JSONB' })).toEqual([
      true,
      false,
      true,
    ]);
    expect(jsonbColumns(['a'], undefined)).toEqual([false]);
    expect(jsonbColumns(['a'], { a: undefined })).toEqual([false]);
  });

  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof SQLiteError ? e.code : e;
    }
    return 'no throw';
  };

  it('refuses a key that is not a column', () => {
    expect(codeOf(() => jsonbColumns(['a'], { b: 'JSONB' }))).toBe(
      'INVALID_OPTION',
    );
  });

  it('refuses a type other than JSONB', () => {
    expect(codeOf(() => jsonbColumns(['a'], { a: 'jsonb' }))).toBe(
      'INVALID_OPTION',
    );
    expect(codeOf(() => jsonbColumns(['a'], { a: 'TEXT' }))).toBe(
      'INVALID_OPTION',
    );
  });
});

describe('convertParams', () => {
  it('converts every param as an ordinary column', () => {
    const at = new Date(Date.UTC(2026, 9, 6, 12, 34, 56, 789));
    expect(
      convertParams([1, 'a', { a: 1 }, [1, 2], at, null, undefined]),
    ).toEqual([
      1,
      'a',
      '{"a":1}',
      '[1,2]',
      '2026-10-06 12:34:56.789',
      null,
      undefined,
    ]);
    expect(convertParams(undefined)).toBeUndefined();
  });

  it('names the param, 1-based', () => {
    try {
      convertParams([1, Symbol('x')]);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as SQLiteError).code).toBe('INVALID_VALUE');
      expect((e as SQLiteError).message).toContain('param 2');
    }
  });
});
