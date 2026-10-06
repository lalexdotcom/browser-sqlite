import { SQLiteError } from './types/errors';

/**
 * How `bulkWrite()` and `output()` turn a cell into a value wa-sqlite binds
 * faithfully: its `bind` stores any other object as NULL and an Array as bytes.
 */

/** `YYYY-MM-DD HH:MM:SS.SSS` in UTC, what `strftime('%Y-%m-%d %H:%M:%f')` gives. */
export const toSQLiteDate = (date: Date): string =>
  date.toISOString().replace('T', ' ').slice(0, -1);

/**
 * A primitive or a Uint8Array is bound as given; a JSONB column takes JSON
 * text, so its booleans and Dates go through `JSON.stringify` too.
 */
export const toBindable = (value: unknown, jsonb: boolean): unknown => {
  if (typeof value === 'boolean') return jsonb ? JSON.stringify(value) : value;
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date && !jsonb) return toSQLiteDate(value);
  return JSON.stringify(value);
};

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
