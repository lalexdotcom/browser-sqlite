import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import { startupError, statementError } from '../../src/pool';

/**
 * docs/superpowers/specs/2026-09-14-statement-errors-design.md §5.3: what the
 * client makes of a worker's `error` and `open-error` messages.
 */
describe('statementError — a query the worker reports failed', () => {
  // Falsifiable: drop the STATEMENT_FAILED branch — this becomes a plain Error
  // with neither code.
  it('turns any SQLite code but 5 and 6 into STATEMENT_FAILED, both codes and the cause kept', () => {
    const cause = new Error('inner');
    const error = statementError({
      message: 'UNIQUE constraint failed: u.a',
      cause,
      sqliteCode: 19,
      sqliteExtendedCode: 2067,
    });
    expect(error).toBeInstanceOf(SQLiteError);
    expect(error).toMatchObject({
      code: 'STATEMENT_FAILED',
      name: 'STATEMENT_FAILED',
      message: 'UNIQUE constraint failed: u.a',
      sqliteCode: 19,
      sqliteExtendedCode: 2067,
    });
    expect(error.cause).toBe(cause);
  });

  // Falsifiable: drop `sqliteExtendedCode` from the BUSY built in busyFromCode.
  it('keeps BUSY for 5 and 6, carrying the extended code too', () => {
    for (const [sqliteCode, sqliteExtendedCode] of [
      [5, 517],
      [6, 262],
    ] as const) {
      expect(
        statementError({
          message: 'database is locked',
          sqliteCode,
          sqliteExtendedCode,
        }),
      ).toMatchObject({ code: 'BUSY', sqliteCode, sqliteExtendedCode });
    }
  });

  // Spec D9. Falsifiable: make subtypeOf return data.sqliteExtendedCode
  // unconditionally — both of these then carry it.
  it('drops the extended code when SQLite reported no subtype', () => {
    const full = statementError({
      message: 'database or disk is full',
      sqliteCode: 13,
      sqliteExtendedCode: 13,
    }) as SQLiteError;
    expect(full).toMatchObject({ code: 'STATEMENT_FAILED', sqliteCode: 13 });
    expect(full.sqliteExtendedCode).toBeUndefined();
    const busy = statementError({
      message: 'database is locked',
      sqliteCode: 5,
      sqliteExtendedCode: 5,
    }) as SQLiteError;
    expect(busy).toMatchObject({ code: 'BUSY', sqliteCode: 5 });
    expect(busy.sqliteExtendedCode).toBeUndefined();
  });

  // Spec D9: only equality with sqliteCode is dropped. A 0 is what a read
  // after a successful call returns — a wrong read, which must stay visible.
  // Falsifiable: filter on `>= 256` instead of on equality.
  it('keeps an extended code that differs from sqliteCode, even 0', () => {
    expect(
      statementError({ message: 'm', sqliteCode: 1, sqliteExtendedCode: 0 }),
    ).toMatchObject({ code: 'STATEMENT_FAILED', sqliteExtendedCode: 0 });
  });

  it('prefers a code the worker minted over the SQLite code', () => {
    expect(
      statementError({
        message: 'm',
        errorCode: 'OPERATION_TIMEOUT',
        sqliteCode: 19,
      }),
    ).toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  // Falsifiable: build STATEMENT_FAILED whenever sqliteCode is absent too.
  it('leaves a failure without a SQLite code a plain Error', () => {
    const cause = new TypeError('not SQLite');
    const error = statementError({ message: 'Unknown error', cause });
    expect(error).not.toBeInstanceOf(SQLiteError);
    expect(error.message).toBe('Unknown error');
    expect(error.cause).toBe(cause);
  });
});

describe('startupError — an open or a delete the worker reports failed', () => {
  // D7 as a property of the client: startupError passes busyFromCode only
  // message/cause/sqliteCode, so an sqliteExtendedCode on the input (a
  // variable, so TypeScript's excess-property check does not reject it — a
  // literal here would) cannot come through. Falsifiable: pass `data`
  // straight to busyFromCode instead of a rebuilt object — 517 comes through.
  it('keeps BUSY for a lock conflict, and drops any extended code (D7)', () => {
    const data: {
      message: string;
      sqliteCode: number;
      sqliteExtendedCode: number;
    } = {
      message: 'database is locked',
      sqliteCode: 5,
      sqliteExtendedCode: 517,
    };
    const error = startupError(data);
    expect(error).toMatchObject({ code: 'BUSY', sqliteCode: 5 });
    expect(error.sqliteExtendedCode).toBeUndefined();
  });

  // Falsifiable: drop `sqliteCode` from the WORKER_CRASHED built in
  // startupError — the code is lost again, as it was before spec 2026-09-14.
  it('keeps WORKER_CRASHED and carries the SQLite code, primary only', () => {
    const error = startupError({
      message: 'file is not a database',
      sqliteCode: 26,
    });
    expect(error).toMatchObject({ code: 'WORKER_CRASHED', sqliteCode: 26 });
    expect(error.sqliteExtendedCode).toBeUndefined();
  });

  it('builds WORKER_CRASHED without a code when SQLite gave none', () => {
    const error = startupError({ message: 'Failed to open x' });
    expect(error.code).toBe('WORKER_CRASHED');
    expect(error.sqliteCode).toBeUndefined();
  });
});
