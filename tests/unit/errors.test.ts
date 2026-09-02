import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';

describe('SQLiteError', () => {
  // Falsifiable: delete `this.name = code` in errors.ts and this fails.
  it('mirrors the code into name so err.name reads like AbortError', () => {
    const error = new SQLiteError('CLIENT_CLOSED', 'closed');
    expect(error.name).toBe('CLIENT_CLOSED');
    expect(error.code).toBe('CLIENT_CLOSED');
  });

  // Falsifiable: drop the `options` argument from the super() call and this fails.
  it('keeps the original error as cause', () => {
    const cause = new Error('boom');
    const error = new SQLiteError('WORKER_CRASHED', 'worker died', { cause });
    expect(error.cause).toBe(cause);
  });

  it('is an Error', () => {
    expect(new SQLiteError('TIMEOUT', 'late')).toBeInstanceOf(Error);
  });

  it('carries DATABASE_IN_USE on both code and name', () => {
    const error = new SQLiteError('DATABASE_IN_USE', 'held elsewhere');
    expect(error.code).toBe('DATABASE_IN_USE');
    expect(error.name).toBe('DATABASE_IN_USE');
    expect(error.sqliteCode).toBeUndefined();
  });

  it('carries DATABASE_NOT_FOUND on both code and name', () => {
    const error = new SQLiteError('DATABASE_NOT_FOUND', 'nothing to delete');
    expect(error.code).toBe('DATABASE_NOT_FOUND');
    expect(error.name).toBe('DATABASE_NOT_FOUND');
    expect(error.sqliteCode).toBeUndefined();
  });
});

describe('SQLiteError — SQLite result codes', () => {
  it('carries the numeric code alongside the discriminant', () => {
    const error = new SQLiteError('BUSY', 'database is locked', {
      sqliteCode: 5,
    });
    expect(error.code).toBe('BUSY');
    expect(error.name).toBe('BUSY');
    expect(error.sqliteCode).toBe(5);
  });

  it('leaves sqliteCode undefined for errors this library raises itself', () => {
    expect(
      new SQLiteError('CLIENT_CLOSED', 'closed').sqliteCode,
    ).toBeUndefined();
  });
});
