import type { EncodedParams } from './binary';
import { SQLiteError } from './types/errors';
import { quoteIdent } from './utils';
import { MAX_INT64, MIN_INT64, takesJson, toSQLiteDate } from './values';

/**
 * A query's texts between placeholders, each placeholder's param index, and
 * its raw values — a `sql.list` array still behind its marker (spec D12, D14,
 * D15).
 */
type Shape = {
  parts: readonly string[];
  slots: readonly number[];
  values: readonly unknown[];
  lists: boolean;
};
const shapeOf = new WeakMap<SQLQuery, Shape>();

/**
 * `parts[0] ?a parts[1] ?b … parts[N]`. Numbered, so each statement of a
 * multi-statement string binds its own values: the worker binds the params
 * to every statement from the first one.
 */
const render = ({ parts, slots }: Shape): string => {
  let text = parts[0] as string;
  for (let k = 1; k < parts.length; k++) {
    const part = parts[k] as string;
    const n = (slots[k - 1] as number) + 1;
    const digit = part.charCodeAt(0) >= 48 && part.charCodeAt(0) <= 57;
    // A digit right after `?1` would make it `?10`, another value.
    text += digit ? `?${n} ${part}` : `?${n}${part}`;
  }
  return text;
};

/**
 * A `sql.list` array, serialised when the query's params are read, as an
 * object param is converted when the query is sent (spec D15). One per call:
 * the array itself as a value converts differently, so grouping by reference
 * must not merge the two.
 */
class ListParam {
  readonly values: readonly unknown[];

  constructor(values: readonly unknown[]) {
    this.values = values;
  }
}

/**
 * A query built by the `sql` tag: its text, with numbered placeholders, and
 * its params in order of first appearance, an object once. Only `sql` and its
 * helpers build one; a fragment is recognised by `instanceof`, so an object of
 * the same shape stays a value.
 */
export class SQLQuery {
  readonly sql: string;
  // Type-only and private: makes the type nominal, so a plain `{ sql, params }`
  // does not type-check where a query built by sql is expected.
  private declare readonly nominal: never;

  constructor(
    parts: readonly string[],
    slots: readonly number[],
    values: readonly unknown[],
  ) {
    const shape = {
      parts,
      slots,
      // Frozen: `params` hands it out, and a change would alter the query.
      values: Object.freeze(values),
      lists: values.some((v) => v instanceof ListParam),
    };
    shapeOf.set(this, shape);
    this.sql = render(shape);
    // An own, enumerable getter rather than a class accessor, so that a log,
    // `JSON.stringify` or a spread of the query still shows its params.
    Object.defineProperty(this, 'params', {
      enumerable: true,
      get: () => paramsOf(shape),
    });
  }

  /** Its params in order; a `sql.list` array is read and serialised here. */
  declare readonly params: readonly unknown[];
}

const paramsOf = ({ values, lists }: Shape): readonly unknown[] =>
  lists ? Object.freeze(values.map(serialiseList)) : values;

/** A `sql.list` marker as its JSON text; a refusal names the param. */
const serialiseList = (value: unknown, i: number): unknown => {
  if (!(value instanceof ListParam)) return value;
  try {
    return listJson(value.values);
  } catch (e) {
    if (!(e instanceof SQLiteError)) throw e;
    throw new SQLiteError(e.code, `param ${i + 1}: ${e.message}`);
  }
};

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
 * Why a template's text cannot be used (spec D13) — an invalid escape, a
 * placeholder of its own, a value inside a literal or a comment, or an end
 * inside one — or else whether it ends inside a line comment.
 */
const templateError = (
  strings: readonly (string | undefined)[],
): string | boolean => {
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
        case 35: // #
        case 36: // $
          if (
            isIdentChar(text.charCodeAt(i + 1)) &&
            // `$` is also an identifier character: only a token's first counts.
            (c !== 36 || i === 0 || !isIdentChar(text.charCodeAt(i - 1)))
          )
            return `it holds a placeholder of its own (${text.slice(i, i + 2)}…)`;
      }
    }
  }
  // Inlined, a template left open would swallow the text after it.
  if (close === LINE_END) return true;
  if (close !== NONE)
    return 'it ends inside a string, a quoted name or a comment';
  return false;
};

/** One scan per call site: a call site hands the same strings at every evaluation. */
const scanned = new WeakMap<object, string | boolean>();

/** Throws if the template is refused; else whether it ends in a line comment. */
const checkTemplate = (strings: TemplateStringsArray): boolean => {
  let result = scanned.get(strings);
  if (result === undefined) {
    result = templateError(strings);
    scanned.set(strings, result);
  }
  if (typeof result === 'string')
    throw new SQLiteError('INVALID_VALUE', `sql template refused: ${result}`);
  return result;
};

/** `a` then `b`, kept apart where joining them would open a comment (`--`, `/*`). */
const glue = (a: string, b: string): string => {
  const last = a.charCodeAt(a.length - 1);
  const first = b.charCodeAt(0);
  return (last === 45 && first === 45) || (last === 47 && first === 42)
    ? `${a} ${b}`
    : a + b;
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
  const endsInLineComment = checkTemplate(strings);
  const parts: string[] = [strings[0] as string];
  const slots: number[] = [];
  const params: unknown[] = [];
  // Objects already in this query, to their param index: one param per
  // reference. Primitives are never grouped, so the text stays the same
  // whatever the values (spec D14).
  const seen = new Map<object, number>();
  const slotFor = (value: unknown): number => {
    if (typeof value === 'object' && value !== null) {
      const known = seen.get(value);
      if (known !== undefined) return known;
      seen.set(value, params.length);
    }
    params.push(value);
    return params.length - 1;
  };
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const after = strings[i + 1] as string;
    if (value instanceof SQLQuery) {
      const inner = shapeOf.get(value) as Shape;
      const last = parts.length - 1;
      parts[last] = glue(parts[last] as string, inner.parts[0] as string);
      for (let k = 1; k < inner.parts.length; k++) {
        slots.push(slotFor(inner.values[inner.slots[k - 1] as number]));
        parts.push(inner.parts[k] as string);
      }
      const end = parts.length - 1;
      parts[end] = glue(parts[end] as string, after);
    } else if (jsonb && takesJson(value)) {
      parts[parts.length - 1] += 'jsonb(';
      slots.push(slotFor(value));
      parts.push(`)${after}`);
    } else {
      slots.push(slotFor(value));
      parts.push(after);
    }
  }
  // Closed, so that inlined it cannot comment out what follows it.
  if (endsInLineComment) parts[parts.length - 1] += '\n';
  return new SQLQuery(parts, slots, params);
};

const raw = (text: string): SQLQuery => {
  if (typeof text !== 'string')
    throw new SQLiteError(
      'INVALID_VALUE',
      `sql.raw() takes a string, got ${Array.isArray(text) ? 'a template' : typeof text}`,
    );
  return new SQLQuery([text], [], []);
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
  return new SQLQuery([quoted.join('.')], [], []);
};

/** A refused value's kind, for a message: never the value itself, which may be a Symbol. */
const kindOf = (value: unknown): string =>
  typeof value === 'object' && value !== null
    ? (value.constructor?.name ?? 'object')
    : typeof value;

/** Whether a `sql.list` element has a list form: what `listElement` can write. */
const listable = (value: unknown): boolean => {
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'undefined':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'bigint':
      return value <= MAX_INT64 && value >= MIN_INT64;
    default:
      return (
        value === null ||
        (value instanceof Date && !Number.isNaN(value.getTime()))
      );
  }
};

const refused = (value: unknown, index: number) =>
  new SQLiteError(
    'INVALID_VALUE',
    `sql.list() index ${index}: a ${kindOf(value)} has no list form`,
  );

/** One element of a `sql.list`, as JSON text `json_each` reads back as the param it would be. */
const listElement = (value: unknown, index: number): string => {
  if (!listable(value)) throw refused(value, index);
  if (value === null || value === undefined) return 'null';
  // Digits, not a JSON.stringify'd Number: SQLite reads them as an exact
  // 64-bit integer.
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return JSON.stringify(toSQLiteDate(value));
  return JSON.stringify(value);
};

/** A list's JSON text, element by element (`listElement`). */
const listJson = (values: readonly unknown[]): string =>
  // Array.from, not map: map skips a hole, which would leave `[1,,3]`.
  `[${Array.from(values, listElement).join(',')}]`;

const list = (values: readonly unknown[]): SQLQuery => {
  if (!Array.isArray(values))
    throw new SQLiteError(
      'INVALID_VALUE',
      `sql.list() takes an array, got ${typeof values}`,
    );
  // Checked now for an early error, serialised only when the query is sent.
  for (let i = 0; i < values.length; i++)
    if (!listable(values[i])) throw refused(values[i], i);
  return new SQLQuery(
    ['(SELECT value FROM json_each(', '))'],
    [0],
    [new ListParam(values)],
  );
};

/**
 * Builds a query from a template: each value becomes a numbered `?N` param,
 * the same object one param wherever it appears, and a `SQLQuery` is inlined
 * with its params. `sql.jsonb` also wraps objects and arrays in `jsonb(…)`.
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
