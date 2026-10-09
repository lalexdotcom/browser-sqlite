import type { EncodedParams } from './binary';
import { SQLiteError } from './types/errors';
import { quoteIdent } from './utils';
import { MAX_INT64, MIN_INT64, takesJson, toSQLiteDate } from './values';

/** Each query's texts between placeholders: one more than its params (spec D12). */
const partsOf = new WeakMap<SQLQuery, readonly string[]>();

/**
 * `parts[0] ?1 parts[1] ?2 … parts[N]`. Numbered, so each statement of a
 * multi-statement string binds its own values: the worker binds the params
 * to every statement from the first one.
 */
const render = (parts: readonly string[]): string => {
  let text = parts[0] as string;
  for (let i = 1; i < parts.length; i++) text += `?${i}${parts[i]}`;
  return text;
};

/**
 * A query built by the `sql` tag: its text, with numbered placeholders, and
 * its params in order. Only `sql` and its helpers build one; a fragment is
 * recognised by `instanceof`, so an object of the same shape stays a value.
 */
export class SQLQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  // Type-only and private: makes the type nominal, so a plain `{ sql, params }`
  // does not type-check where a query built by sql is expected.
  private declare readonly nominal: never;

  constructor(parts: readonly string[], params: readonly unknown[]) {
    partsOf.set(this, parts);
    this.sql = render(parts);
    this.params = params;
  }
}

// What the scan waits for inside a literal or a comment; NONE outside one.
const NONE = 0;
const LINE_END = -1;
const BLOCK_END = -2;

/** SQLite's identifier characters: letters, digits, `_`, `$` and anything past ASCII. */
const isIdentChar = (c: number) =>
  (c >= 48 && c <= 57) ||
  (c >= 65 && c <= 90) ||
  (c >= 97 && c <= 122) ||
  c === 95 ||
  c === 36 ||
  c > 127;

/**
 * Why a template's text cannot be used, or undefined (spec D13): an invalid
 * escape, a placeholder of its own, or a value inside a literal or a comment.
 */
const templateError = (
  strings: readonly (string | undefined)[],
): string | undefined => {
  let close = NONE;
  for (let s = 0; s < strings.length; s++) {
    const text = strings[s];
    if (text === undefined)
      return `part ${s} has an invalid escape sequence: write \\\\ for a backslash`;
    if (s > 0 && close !== NONE)
      return `value ${s} is inside a string, a quoted name or a comment`;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (close !== NONE) {
        const ends =
          close === LINE_END
            ? c === 10
            : close === BLOCK_END
              ? c === 42 && text.charCodeAt(i + 1) === 47
              : c === close;
        if (ends) {
          if (close === BLOCK_END) i++;
          close = NONE;
        }
        continue;
      }
      switch (c) {
        case 39: // '
        case 34: // "
        case 96: // `
          close = c;
          break;
        case 91: // [ … ]
          close = 93;
          break;
        case 45: // --
          if (text.charCodeAt(i + 1) === 45) {
            close = LINE_END;
            i++;
          }
          break;
        case 47: // /*
          if (text.charCodeAt(i + 1) === 42) {
            close = BLOCK_END;
            i++;
          }
          break;
        case 63: // ?
          return 'it holds a placeholder of its own (?)';
        case 58: // :
        case 64: // @
        case 36: // $
        case 35: // #
          if (
            (i === 0 || !isIdentChar(text.charCodeAt(i - 1))) &&
            isIdentChar(text.charCodeAt(i + 1))
          )
            return `it holds a placeholder of its own (${text.slice(i, i + 2)}…)`;
      }
    }
  }
  return undefined;
};

/** One scan per call site: a call site hands the same strings at every evaluation. */
const scanned = new WeakMap<object, string | null>();

const checkTemplate = (strings: TemplateStringsArray) => {
  let error = scanned.get(strings);
  if (error === undefined) {
    error = templateError(strings) ?? null;
    scanned.set(strings, error);
  }
  if (error !== null)
    throw new SQLiteError('INVALID_VALUE', `sql template refused: ${error}`);
};

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
  checkTemplate(strings);
  const parts: string[] = [strings[0] as string];
  const params: unknown[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const after = strings[i + 1] as string;
    if (value instanceof SQLQuery) {
      const inner = partsOf.get(value) as readonly string[];
      parts[parts.length - 1] += inner[0] as string;
      for (let k = 1; k < inner.length; k++) parts.push(inner[k] as string);
      // A loop, not push(...): a fragment may carry more params than a call
      // takes arguments.
      for (const p of value.params) params.push(p);
      parts[parts.length - 1] += after;
    } else if (jsonb && takesJson(value)) {
      parts[parts.length - 1] += 'jsonb(';
      parts.push(`)${after}`);
      params.push(value);
    } else {
      parts.push(after);
      params.push(value);
    }
  }
  return new SQLQuery(parts, params);
};

const raw = (text: string): SQLQuery => {
  if (typeof text !== 'string')
    throw new SQLiteError(
      'INVALID_VALUE',
      `sql.raw() takes a string, got ${Array.isArray(text) ? 'a template' : typeof text}`,
    );
  return new SQLQuery([text], []);
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
  return new SQLQuery([quoted.join('.')], []);
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
  return new SQLQuery(['(SELECT value FROM json_each(', '))'], [json]);
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
