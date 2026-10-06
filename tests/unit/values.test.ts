import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/types/errors';
import { jsonbColumns, toBindable, toSQLiteDate } from '../../src/values';

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

  it('lets JSON.stringify and toISOString throw', () => {
    expect(() => toBindable({ n: 1n }, false)).toThrow(TypeError);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => toBindable(cycle, false)).toThrow(TypeError);
    expect(() => toBindable(new Date(Number.NaN), false)).toThrow(RangeError);
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
