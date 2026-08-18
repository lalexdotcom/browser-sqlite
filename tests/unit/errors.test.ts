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
});
