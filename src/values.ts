import { SQLiteError } from './types/errors';

/**
 * How `bulkWrite()` and `output()` turn a cell into a value wa-sqlite binds
 * faithfully: its `bind` stores any other object as NULL and an Array as bytes.
 */

/** `YYYY-MM-DD HH:MM:SS.SSS` in UTC, what `strftime('%Y-%m-%d %H:%M:%f')` gives. */
export const toSQLiteDate = (date: Date): string =>
  date.toISOString().replace('T', ' ').slice(0, -1);

/** What the worker can bind: anything else is refused before it is sent. */
export type Bindable =
  | null
  | undefined
  | number
  | bigint
  | string
  | boolean
  | Uint8Array;

const MAX_INT64 = 0x7fffffffffffffffn;
const MIN_INT64 = -0x8000000000000000n;

const convert = (value: unknown, jsonb: boolean): unknown => {
  if (typeof value === 'boolean' || typeof value === 'string')
    return jsonb ? JSON.stringify(value) : value;
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date && !jsonb) return toSQLiteDate(value);
  return JSON.stringify(value);
};

/**
 * A primitive or a Uint8Array is bound as given; a JSONB column takes JSON
 * text, so its strings, booleans and Dates go through `JSON.stringify` too.
 * Anything else throws `INVALID_VALUE`, naming `what`.
 */
export const toBindable = (
  value: unknown,
  jsonb: boolean,
  what = 'value',
): Bindable => {
  let v: unknown;
  try {
    v = convert(value, jsonb);
  } catch (cause) {
    throw new SQLiteError(
      'INVALID_VALUE',
      `${what} cannot be converted: ${(cause as Error).message}`,
      { cause },
    );
  }
  if (typeof v === 'bigint') {
    if (v > MAX_INT64 || v < MIN_INT64)
      throw new SQLiteError(
        'INVALID_VALUE',
        `${what} is a bigint outside SQLite's 64-bit integer range: ${v}`,
      );
    return v;
  }
  if (
    v === null ||
    v === undefined ||
    typeof v === 'number' ||
    typeof v === 'string' ||
    typeof v === 'boolean' ||
    v instanceof Uint8Array
  )
    return v;
  throw new SQLiteError(
    'INVALID_VALUE',
    `${what} cannot be bound: a ${typeof v} has no SQLite value`,
  );
};

/** Every parameterised method's params, converted as an ordinary column. */
export const convertParams = (
  params: readonly unknown[] | undefined,
): Bindable[] | undefined =>
  params?.map((v, i) => toBindable(v, false, `param ${i + 1}`));

/** One flag per key, in `keys` order: whether the column takes `jsonb(?)`. */
export const jsonbColumns = (
  keys: readonly string[],
  types: Readonly<Record<string, unknown>> | undefined,
): boolean[] => {
  for (const [key, type] of Object.entries(types ?? {})) {
    if (type === undefined) continue;
    if (!keys.includes(key))
      throw new SQLiteError(
        'INVALID_OPTION',
        `types names "${key}", which is not one of the columns: ${keys.map((k) => `"${k}"`).join(', ')}.`,
      );
    if (type !== 'JSONB')
      throw new SQLiteError(
        'INVALID_OPTION',
        `types gives "${key}" the type ${JSON.stringify(type)}; the only type supported is 'JSONB'.`,
      );
  }
  return keys.map((key) => types?.[key] === 'JSONB');
};
