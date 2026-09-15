import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from 'wa-sqlite/src/sqlite-api.js';
import { sqliteCodeOf } from '../../src/worker/sqlite-code';

describe('sqliteCodeOf — a sqliteCode carried only from SQLite itself', () => {
  it("reads the code off wa-sqlite's own SQLiteError", () => {
    const error = new SQLiteError('UNIQUE constraint failed: u.a', 19);
    expect(sqliteCodeOf(error)).toBe(19);
  });

  // A DOMException's legacy `code` is numeric and looks just like SQLite's —
  // asserted first so the exclusion below visibly means something.
  it('is not fooled by a DOMException carrying the same shape', () => {
    const denied = new DOMException('denied', 'SecurityError');
    expect(denied.code).toBe(18);
    expect(sqliteCodeOf(denied)).toBeUndefined();
  });

  it('ignores a plain object with a numeric code', () => {
    expect(sqliteCodeOf({ code: 5 })).toBeUndefined();
  });

  // Falsifiable: revert sqliteCodeOf to a `typeof code === 'number'` check —
  // the DOMException case above returns 18 instead of undefined.
  it('ignores a plain Error', () => {
    expect(sqliteCodeOf(new Error('boom'))).toBeUndefined();
  });
});
