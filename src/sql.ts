import type { EncodedParams } from './binary';
import { SQLiteError } from './types/errors';
import { quoteIdent } from './utils';
import { MAX_INT64, MIN_INT64, takesJson, toSQLiteDate } from './values';

/**
 * A query built by the `sql` tag: its text, with `?` placeholders, and its
 * params in order. Only `sql` and its helpers build one; a fragment is
 * recognised by `instanceof`, so an object of the same shape stays a value.
 */
export class SQLQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  // Type-only and private: makes the type nominal, so a plain `{ sql, params }`
  // does not type-check where a query built by sql is expected.
  private declare readonly nominal: never;

  constructor(sql: string, params: readonly unknown[]) {
    this.sql = sql;
    this.params = params;
  }
}

const build = (
  strings: TemplateStringsArray,
  values: readonly unknown[],
  jsonb: boolean,
): SQLQuery => {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw))
    throw new SQLiteError(
      'INVALID_VALUE',
      'sql is a template tag: write sql`…`, not sql(…)',
    );
  const segment = (i: number): string => {
    const text: string | undefined = strings[i];
    // A tagged template's text is undefined after an invalid escape such as
    // `\x`: skipping it would silently drop that part of the SQL.
    if (text === undefined)
      throw new SQLiteError(
        'INVALID_VALUE',
        `sql template part ${i} has an invalid escape sequence: write \\\\ for a backslash`,
      );
    return text;
  };
  let text = segment(0);
  const params: unknown[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value instanceof SQLQuery) {
      text += value.sql;
      // A loop, not push(...): a fragment may carry more params than a call
      // takes arguments.
      for (const p of value.params) params.push(p);
    } else {
      text += jsonb && takesJson(value) ? 'jsonb(?)' : '?';
      params.push(value);
    }
    text += segment(i + 1);
  }
  return new SQLQuery(text, params);
};

const raw = (text: string): SQLQuery => {
  if (typeof text !== 'string')
    throw new SQLiteError(
      'INVALID_VALUE',
      `sql.raw() takes a string, got ${Array.isArray(text) ? 'a template' : typeof text}`,
    );
  return new SQLQuery(text, []);
};

const id = (...parts: [string, ...string[]]): SQLQuery => {
  if (parts.length === 0)
    throw new SQLiteError(
      'INVALID_IDENTIFIER',
      'sql.id() needs at least one name',
    );
  const quoted = parts.map((part) => {
    if (typeof part !== 'string')
      throw new SQLiteError(
        'INVALID_IDENTIFIER',
        `sql.id() takes strings, got ${typeof part}`,
      );
    return quoteIdent(part);
  });
  return new SQLQuery(quoted.join('.'), []);
};

/** A refused value's kind, for a message: never the value itself, which may be a Symbol. */
const kindOf = (value: unknown): string =>
  typeof value === 'object' && value !== null
    ? (value.constructor?.name ?? 'object')
    : typeof value;

/** One element of a `sql.list`, as JSON text `json_each` reads back as the param it would be. */
const listElement = (value: unknown, index: number): string => {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (Number.isFinite(value)) return JSON.stringify(value);
      break;
    case 'bigint':
      // Digits, not a JSON.stringify'd Number: SQLite reads them as an exact
      // 64-bit integer.
      if (value <= MAX_INT64 && value >= MIN_INT64) return value.toString();
      break;
    default:
      if (value instanceof Date && !Number.isNaN(value.getTime()))
        return JSON.stringify(toSQLiteDate(value));
  }
  throw new SQLiteError(
    'INVALID_VALUE',
    `sql.list() index ${index}: a ${kindOf(value)} has no list form`,
  );
};

const list = (values: readonly unknown[]): SQLQuery => {
  if (!Array.isArray(values))
    throw new SQLiteError(
      'INVALID_VALUE',
      `sql.list() takes an array, got ${typeof values}`,
    );
  // Array.from, not map: map skips a hole, which would leave `[1,,3]`.
  const json = `[${Array.from(values, listElement).join(',')}]`;
  return new SQLQuery('(SELECT value FROM json_each(?))', [json]);
};

/**
 * Builds a query from a template: each value becomes a `?` param, a `SQLQuery`
 * is inlined with its params. `sql.jsonb` also wraps objects and arrays in
 * `jsonb(?)`.
 */
export const sql = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]): SQLQuery =>
    build(strings, values, false),
  {
    jsonb: (strings: TemplateStringsArray, ...values: unknown[]): SQLQuery =>
      build(strings, values, true),
    raw,
    id,
    list,
  },
);

/**
 * A query method's arguments in either form: `(sql, params?, options?)` or
 * `(query, options?)`.
 */
export const queryArgs = <O>(
  first: string | SQLQuery,
  second: unknown,
  third: O | undefined,
): {
  sql: string;
  params: readonly unknown[] | EncodedParams | undefined;
  options: O | undefined;
} => {
  if (typeof first === 'string')
    return {
      sql: first,
      params: second as readonly unknown[] | EncodedParams | undefined,
      options: third,
    };
  if (!(first instanceof SQLQuery))
    throw new SQLiteError(
      'INVALID_VALUE',
      'A query must be a SQL string or a query built by sql',
    );
  if (Array.isArray(second))
    throw new SQLiteError(
      'INVALID_VALUE',
      'A query built by sql takes no params array: its values are in the template',
    );
  return {
    sql: first.sql,
    params: first.params,
    options: second as O | undefined,
  };
};
