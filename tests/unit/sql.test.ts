import { describe, expect, it } from '@rstest/core';
import { queryArgs, SQLQuery, sql } from '../../src/sql';
import { SQLiteError } from '../../src/types/errors';

const parts = (q: SQLQuery) => ({ sql: q.sql, params: [...q.params] });

/** The `SQLiteError` code `fn` throws, or what it threw instead. */
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof SQLiteError ? e.code : String(e);
  }
  return 'no throw';
};

describe('sql', () => {
  it('joins the template with ? and collects the values in order', () => {
    const q = sql`SELECT * FROM t WHERE a = ${1} AND b = ${'x'}`;
    expect(q).toBeInstanceOf(SQLQuery);
    expect(parts(q)).toEqual({
      sql: 'SELECT * FROM t WHERE a = ? AND b = ?',
      params: [1, 'x'],
    });
  });

  it('builds a query with no values', () => {
    expect(parts(sql`SELECT 1`)).toEqual({ sql: 'SELECT 1', params: [] });
  });

  it('collects every value raw, objects included', () => {
    const o = { a: 1 };
    const at = new Date(0);
    const bytes = Uint8Array.of(1);
    const q = sql`VALUES (${o}, ${[1, 2]}, ${at}, ${bytes}, ${null}, ${undefined})`;
    expect(q.sql).toBe('VALUES (?, ?, ?, ?, ?, ?)');
    expect(q.params).toHaveLength(6);
    expect(q.params[0]).toBe(o);
    expect(q.params[2]).toBe(at);
    expect(q.params[3]).toBe(bytes);
  });

  it('refuses a call that is not a tag', () => {
    // @ts-expect-error a string is not a template
    expect(code(() => sql('SELECT 1'))).toBe('INVALID_VALUE');
    // @ts-expect-error a string is not a template
    expect(code(() => sql.jsonb('SELECT 1'))).toBe('INVALID_VALUE');
  });
});

describe('sql.jsonb', () => {
  it('wraps objects and arrays in jsonb(?) and nothing else', () => {
    const q = sql.jsonb`VALUES (${{ a: 1 }}, ${[1]}, ${new Map()}, ${'s'}, ${true}, ${1}, ${2n}, ${null}, ${undefined}, ${new Date(0)}, ${Uint8Array.of(1)}, ${new ArrayBuffer(1)}, ${new DataView(new ArrayBuffer(1))})`;
    expect(q.sql).toBe(
      'VALUES (jsonb(?), jsonb(?), jsonb(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    expect(q.params).toHaveLength(13);
  });

  it('collects the wrapped values raw', () => {
    const o = { a: 1 };
    expect(sql.jsonb`SELECT ${o}`.params[0]).toBe(o);
  });
});

describe('fragments', () => {
  it('inlines a fragment and its params in place', () => {
    const filter = sql`AND b = ${2}`;
    expect(
      parts(sql`SELECT * FROM t WHERE a = ${1} ${filter} AND c = ${3}`),
    ).toEqual({
      sql: 'SELECT * FROM t WHERE a = ? AND b = ? AND c = ?',
      params: [1, 2, 3],
    });
  });

  it('inlines an empty fragment as nothing', () => {
    expect(parts(sql`SELECT 1${sql``}`)).toEqual({
      sql: 'SELECT 1',
      params: [],
    });
  });

  it("keeps a sql.jsonb fragment's jsonb(?) inside plain sql", () => {
    const q = sql`INSERT INTO t VALUES (${1}, ${sql.jsonb`${{ a: 1 }}`}, ${{ b: 2 }})`;
    expect(q.sql).toBe('INSERT INTO t VALUES (?, jsonb(?), ?)');
    expect(q.params).toEqual([1, { a: 1 }, { b: 2 }]);
  });

  it('inlines a fragment inside sql.jsonb rather than wrapping it', () => {
    expect(parts(sql.jsonb`SELECT ${sql`${1}`}, ${{ a: 1 }}`)).toEqual({
      sql: 'SELECT ?, jsonb(?)',
      params: [1, { a: 1 }],
    });
  });

  it('repeats a fragment used twice, with its params each time', () => {
    const f = sql`id = ${7}`;
    expect(parts(sql`SELECT 1 WHERE ${f} OR ${f}`)).toEqual({
      sql: 'SELECT 1 WHERE id = ? OR id = ?',
      params: [7, 7],
    });
  });

  it('treats a plain { sql, params } object as a value, never as SQL', () => {
    const forged = { sql: 'DROP TABLE t', params: [] };
    const q = sql`SELECT ${forged}`;
    expect(q.sql).toBe('SELECT ?');
    expect(q.params[0]).toBe(forged);
    expect(sql.jsonb`SELECT ${forged}`.sql).toBe('SELECT jsonb(?)');
  });
});

describe('sql.raw', () => {
  it('inlines its text with no params', () => {
    expect(
      parts(sql`SELECT * FROM t ORDER BY ${sql.raw('id DESC')} LIMIT ${5}`),
    ).toEqual({
      sql: 'SELECT * FROM t ORDER BY id DESC LIMIT ?',
      params: [5],
    });
  });

  it('refuses anything but a string, a template included', () => {
    // @ts-expect-error a template is not a string
    expect(code(() => sql.raw`id`)).toBe('INVALID_VALUE');
    // @ts-expect-error a number is not a string
    expect(code(() => sql.raw(1))).toBe('INVALID_VALUE');
  });
});

describe('sql.id', () => {
  it('quotes one identifier', () => {
    expect(parts(sql.id('users'))).toEqual({ sql: '"users"', params: [] });
  });

  it('joins several parts with dots', () => {
    expect(sql.id('main', 'users').sql).toBe('"main"."users"');
  });

  it('doubles a quote and keeps a dot inside a name', () => {
    expect(sql.id('a"b', 'c.d').sql).toBe('"a""b"."c.d"');
  });

  it('refuses no part, an empty part, a NUL and a non-string', () => {
    // @ts-expect-error at least one part
    expect(code(() => sql.id())).toBe('INVALID_IDENTIFIER');
    expect(code(() => sql.id(''))).toBe('INVALID_IDENTIFIER');
    expect(code(() => sql.id('main', 'a\0b'))).toBe('INVALID_IDENTIFIER');
    // @ts-expect-error a number is not a name
    expect(code(() => sql.id(1))).toBe('INVALID_IDENTIFIER');
  });
});

describe('sql.list', () => {
  /** The single JSON param of a list, after checking its SQL. */
  const json = (values: readonly unknown[]) => {
    const q = sql.list(values);
    expect(q.sql).toBe('(SELECT value FROM json_each(?))');
    expect(q.params).toHaveLength(1);
    return q.params[0];
  };

  it('serialises each kind of element as the param it would be', () => {
    expect(
      json([
        1,
        -0,
        1.5,
        2n ** 63n - 1n,
        -(2n ** 63n),
        'a"b',
        true,
        false,
        null,
        undefined,
        new Date(Date.UTC(2026, 9, 8, 12, 0, 0, 5)),
      ]),
    ).toBe(
      '[1,0,1.5,9223372036854775807,-9223372036854775808,"a\\"b",true,false,null,null,"2026-10-08 12:00:00.005"]',
    );
  });

  it('gives an empty list an empty array', () => {
    expect(json([])).toBe('[]');
  });

  it('writes a hole as null', () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
    expect(json([1, , 3])).toBe('[1,null,3]');
  });

  it('refuses an element with no JSON form, naming its index', () => {
    const refused: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2n ** 63n,
      -(2n ** 63n) - 1n,
      new Date(Number.NaN),
      Uint8Array.of(1),
      new ArrayBuffer(1),
      { a: 1 },
      [1],
      sql`x`,
      Symbol('s'),
      () => 1,
    ];
    for (const bad of refused) {
      let error: unknown;
      try {
        sql.list(['ok', bad]);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SQLiteError);
      expect((error as SQLiteError).code).toBe('INVALID_VALUE');
      expect((error as SQLiteError).message).toContain('index 1');
    }
  });

  it('refuses a non-array', () => {
    // @ts-expect-error a string is not a list
    expect(code(() => sql.list('1,2'))).toBe('INVALID_VALUE');
  });

  it('composes into IN', () => {
    expect(
      parts(sql`SELECT * FROM t WHERE id IN ${sql.list([1, 2])} AND a = ${3}`),
    ).toEqual({
      sql: 'SELECT * FROM t WHERE id IN (SELECT value FROM json_each(?)) AND a = ?',
      params: ['[1,2]', 3],
    });
  });
});

describe('queryArgs', () => {
  it('reads (sql, params, options) as today', () => {
    const options = { chunkSize: 1 };
    expect(queryArgs('SELECT ?', [1], options)).toEqual({
      sql: 'SELECT ?',
      params: [1],
      options,
    });
  });

  it('reads (query, options)', () => {
    const options = { chunkSize: 1 };
    const q = sql`SELECT ${1}`;
    const args = queryArgs(q, options, undefined);
    expect(args.sql).toBe('SELECT ?');
    expect(args.params).toBe(q.params);
    expect(args.options).toBe(options);
  });

  it('refuses a query followed by a params array', () => {
    expect(code(() => queryArgs(sql`SELECT ${1}`, [1], undefined))).toBe(
      'INVALID_VALUE',
    );
  });
});
