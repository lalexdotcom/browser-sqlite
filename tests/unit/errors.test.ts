import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import { SQLITE_CODES, SQLITE_EXTENDED_CODES } from '../../src/sqlite-codes';

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

  // Falsifiable: drop the sqliteExtendedCode assignment in the constructor.
  it('carries sqliteExtendedCode when given one, and nothing otherwise', () => {
    const error = new SQLiteError(
      'STATEMENT_FAILED',
      'UNIQUE constraint failed: u.a',
      { sqliteCode: 19, sqliteExtendedCode: 2067 },
    );
    expect(error.name).toBe('STATEMENT_FAILED');
    expect(error.sqliteCode).toBe(19);
    expect(error.sqliteExtendedCode).toBe(2067);
    expect(
      new SQLiteError('CLIENT_CLOSED', 'closed').sqliteExtendedCode,
    ).toBeUndefined();
  });

  // Spec D10. sqliteCode is typed as a primary code, so comparing it with an
  // extended code does not compile; sqliteExtendedCode stays open (D9).
  // Falsifiable: widen `sqliteCode` back to `number` in src/errors.ts —
  // `pnpm exec tsc --noEmit` then fails with TS2578 (unused @ts-expect-error).
  it('types sqliteCode as a primary result code, sqliteExtendedCode open', () => {
    const error = new SQLiteError(
      'STATEMENT_FAILED',
      'UNIQUE constraint failed: u.a',
      {
        sqliteCode: SQLITE_CODES.CONSTRAINT,
        sqliteExtendedCode: SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE,
      },
    );
    // @ts-expect-error TS2367: a primary code never equals an extended one.
    expect(error.sqliteCode === SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE).toBe(
      false,
    );
    const wrongRead = new SQLiteError('STATEMENT_FAILED', 'm', {
      sqliteCode: SQLITE_CODES.ERROR,
      sqliteExtendedCode: 0,
    });
    expect(wrongRead.sqliteExtendedCode).toBe(0);
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

describe('SQLiteError — timeout', () => {
  it('carries the timeout that was exceeded', () => {
    const err = new SQLiteError(
      'OPERATION_TIMEOUT',
      'read() exceeded its timeout of 200 ms.',
      {
        timeout: 200,
      },
    );
    expect(err.code).toBe('OPERATION_TIMEOUT');
    expect(err.name).toBe('OPERATION_TIMEOUT');
    expect(err.timeout).toBe(200);
  });

  it('leaves timeout undefined when none was given', () => {
    expect(new SQLiteError('BUSY', 'busy').timeout).toBeUndefined();
  });
});

describe('GENERATOR_ABANDONED', () => {
  it('is a public error code', () => {
    const error = new SQLiteError('GENERATOR_ABANDONED', 'test');
    expect(error.code).toBe('GENERATOR_ABANDONED');
    expect(error.name).toBe('GENERATOR_ABANDONED');
  });
});
