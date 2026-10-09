import { describe, expect, it } from '@rstest/core';
import type { SQLiteDB } from '../../src/api';
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
  it('joins the template with numbered placeholders and collects the values in order', () => {
    const q = sql`SELECT * FROM t WHERE a = ${1} AND b = ${'x'}`;
    expect(q).toBeInstanceOf(SQLQuery);
    expect(parts(q)).toEqual({
      sql: 'SELECT * FROM t WHERE a = ?1 AND b = ?2',
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
    expect(q.sql).toBe('VALUES (?1, ?2, ?3, ?4, ?5, ?6)');
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
  it('wraps objects and arrays in jsonb(…) and nothing else', () => {
    const q = sql.jsonb`VALUES (${{ a: 1 }}, ${[1]}, ${new Map()}, ${'s'}, ${true}, ${1}, ${2n}, ${null}, ${undefined}, ${new Date(0)}, ${Uint8Array.of(1)}, ${new ArrayBuffer(1)}, ${new DataView(new ArrayBuffer(1))})`;
    expect(q.sql).toBe(
      'VALUES (jsonb(?1), jsonb(?2), jsonb(?3), ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)',
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
      sql: 'SELECT * FROM t WHERE a = ?1 AND b = ?2 AND c = ?3',
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
    expect(q.sql).toBe('INSERT INTO t VALUES (?1, jsonb(?2), ?3)');
    expect(q.params).toEqual([1, { a: 1 }, { b: 2 }]);
  });

  it('inlines a fragment inside sql.jsonb rather than wrapping it', () => {
    expect(parts(sql.jsonb`SELECT ${sql`${1}`}, ${{ a: 1 }}`)).toEqual({
      sql: 'SELECT ?1, jsonb(?2)',
      params: [1, { a: 1 }],
    });
  });

  it('repeats a fragment used twice, with its params each time', () => {
    const f = sql`id = ${7}`;
    expect(parts(sql`SELECT 1 WHERE ${f} OR ${f}`)).toEqual({
      sql: 'SELECT 1 WHERE id = ?1 OR id = ?2',
      params: [7, 7],
    });
  });

  it('treats a plain { sql, params } object as a value, never as SQL', () => {
    const forged = { sql: 'DROP TABLE t', params: [] };
    const q = sql`SELECT ${forged}`;
    expect(q.sql).toBe('SELECT ?1');
    expect(q.params[0]).toBe(forged);
    expect(sql.jsonb`SELECT ${forged}`.sql).toBe('SELECT jsonb(?1)');
  });
});

describe('sql.raw', () => {
  it('inlines its text with no params', () => {
    expect(
      parts(sql`SELECT * FROM t ORDER BY ${sql.raw('id DESC')} LIMIT ${5}`),
    ).toEqual({
      sql: 'SELECT * FROM t ORDER BY id DESC LIMIT ?1',
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
    expect(q.sql).toBe('(SELECT value FROM json_each(?1))');
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
      sql: 'SELECT * FROM t WHERE id IN (SELECT value FROM json_each(?1)) AND a = ?2',
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
    expect(args.sql).toBe('SELECT ?1');
    expect(args.params).toBe(q.params);
    expect(args.options).toBe(options);
  });

  it('refuses a query followed by a params array', () => {
    expect(code(() => queryArgs(sql`SELECT ${1}`, [1], undefined))).toBe(
      'INVALID_VALUE',
    );
  });
});

// Compile-time only, never called. Falsifiable: drop the SQLQuery overload
// from SQLiteQueryAPI.read or .write.
const _overloads = async (db: SQLiteDB) => {
  await db.read(sql`SELECT 1`, { chunkSize: 1 });
  await db.write(sql`SELECT 1`);
  await db.read('SELECT ?', [1], { chunkSize: 1 });
  // @ts-expect-error a query built by sql takes no params array
  await db.read(sql`SELECT 1`, [1]);
};

describe('review fixes', () => {
  it('refuses a template with an invalid escape rather than dropping its text', () => {
    expect(code(() => sql`DELETE FROM t WHERE id = ${1} AND p <> '\x'`)).toBe(
      'INVALID_VALUE',
    );
    expect(code(() => sql.jsonb`SELECT '\u' || ${1}`)).toBe('INVALID_VALUE');
  });

  it('refuses a first argument that is neither SQL nor a query built by sql', () => {
    expect(
      code(() =>
        queryArgs(
          { sql: 'SELECT 1', params: [] } as never,
          undefined,
          undefined,
        ),
      ),
    ).toBe('INVALID_VALUE');
  });
});

// Compile-time only, never called. Falsifiable: make SQLQuery structural
// again, or declare the string overload first.
const _nominal = async (db: SQLiteDB) => {
  // @ts-expect-error a plain object is not a query built by sql
  await db.read({ sql: 'SELECT 1', params: [] });
  // A wrapper typed from the method keeps the string form: TypeScript reads
  // the last overload.
  const args: Parameters<SQLiteDB['read']> = [
    'SELECT ?',
    [1],
    { chunkSize: 1 },
  ];
  await db.read(...args);
};

describe('numbering', () => {
  it('numbers placeholders across nested fragments', () => {
    const inner = sql`b = ${2} AND c = ${sql.jsonb`${{ x: 1 }}`}`;
    expect(
      parts(sql`SELECT * FROM t WHERE a = ${1} AND ${inner} AND d = ${4}`),
    ).toEqual({
      sql: 'SELECT * FROM t WHERE a = ?1 AND b = ?2 AND c = jsonb(?3) AND d = ?4',
      params: [1, 2, { x: 1 }, 4],
    });
  });

  it('numbers a fragment from 1 when it stands alone', () => {
    expect(sql`b = ${2}`.sql).toBe('b = ?1');
  });

  it('joins a fragment at either end of a template without a stray placeholder', () => {
    const f = sql`a = ${1}`;
    expect(parts(sql`${f}`)).toEqual({ sql: 'a = ?1', params: [1] });
    expect(parts(sql`${f} AND ${f}`)).toEqual({
      sql: 'a = ?1 AND a = ?2',
      params: [1, 1],
    });
  });
});

describe('the template scan', () => {
  it('refuses a placeholder of its own, in every form SQLite reads', () => {
    const made = [
      () => sql`SELECT ?`,
      () => sql`SELECT ?3`,
      () => sql`SELECT :name`,
      () => sql`SELECT @name`,
      () => sql`SELECT $name`,
      () => sql`SELECT #name`,
      () => sql`SELECT ${1}, ?`,
    ];
    for (const make of made) expect(code(make)).toBe('INVALID_VALUE');
  });

  it('lets placeholder characters through inside literals, quoted names and comments', () => {
    const q = sql`SELECT 'what?', 'it''s :x ?', "a?b", \`c?\`, [d?], json_extract(doc, '$.a'), a$b -- why? :x
      /* @y ?2 */ FROM t WHERE id = ${1}`;
    expect(q.params).toEqual([1]);
    expect(q.sql.endsWith('WHERE id = ?1')).toBe(true);
  });

  it('refuses a value inside a literal, a quoted name or a comment', () => {
    const made = [
      () => sql`SELECT * FROM t WHERE name LIKE '%${'x'}%'`,
      () => sql`SELECT "${'x'}"`,
      () => sql`SELECT \`${'x'}\``,
      () => sql`SELECT [${'x'}]`,
      () => sql`SELECT 1 -- ${'x'}
        `,
      () => sql`SELECT 1 /* ${'x'} */`,
    ];
    for (const make of made) expect(code(make)).toBe('INVALID_VALUE');
  });

  it('accepts a line comment that ends before the value', () => {
    expect(
      sql`SELECT 1 -- note
        , ${2}`.params,
    ).toEqual([2]);
  });

  it('does not scan sql.raw text', () => {
    expect(sql`SELECT ${sql.raw('?')}`.sql).toBe('SELECT ?');
  });

  it('scans a call site once and remembers the result', () => {
    // A real template's strings are frozen; mutating this hand-made one only
    // shows that the result is cached on the object.
    const strings = Object.assign(['SELECT ? + ', ''], {
      raw: ['SELECT ? + ', ''],
    });
    const tag = () => sql(strings as unknown as TemplateStringsArray, 1);
    expect(code(tag)).toBe('INVALID_VALUE');
    strings[0] = 'SELECT 1 + ';
    expect(code(tag)).toBe('INVALID_VALUE');
  });
});

describe('review fixes, amendment', () => {
  it('refuses a template that ends inside a string, a quoted name or a block comment', () => {
    const made = [
      () => sql`SELECT 'a`,
      () => sql`SELECT "a`,
      () => sql`SELECT \`a`,
      () => sql`SELECT [a`,
      () => sql`SELECT 1 /* a`,
    ];
    for (const make of made) expect(code(make)).toBe('INVALID_VALUE');
  });

  it('ends a template that ends in a line comment, so a fragment cannot swallow what follows', () => {
    const active = sql`a > ${0} -- first filter`;
    expect(sql`SELECT * FROM t WHERE ${active} AND a < ${3}`.sql).toBe(
      'SELECT * FROM t WHERE a > ?1 -- first filter\n AND a < ?2',
    );
  });

  it('keeps a join from forming a comment', () => {
    expect(sql`SELECT 5 -${sql`-${1}`}, ${2}`.sql).toBe('SELECT 5 - -?1, ?2');
    expect(sql`SELECT 5 ${sql`${1} -`}- 2`.sql).toBe('SELECT 5 ?1 - - 2');
    expect(sql`SELECT 4 /${sql`* ${1}`}`.sql).toBe('SELECT 4 / * ?1');
  });

  it("keeps a value's number apart from a digit that follows it", () => {
    expect(sql`SELECT ${1}0`.sql).toBe('SELECT ?1 0');
  });

  it('refuses :, @ and # right after a word, but not $ inside one', () => {
    const made = [
      () => sql`SELECT * FROM t WHERE a IS:x AND b = ${1}`,
      () => sql`SELECT * FROM t LIMIT:n`,
      () => sql`SELECT a@b`,
      () => sql`SELECT a#b`,
    ];
    for (const make of made) expect(code(make)).toBe('INVALID_VALUE');
    expect(sql`SELECT a$b FROM t`.params).toEqual([]);
  });
});
