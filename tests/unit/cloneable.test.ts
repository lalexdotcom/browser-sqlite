import { describe, expect, it } from '@rstest/core';
import { cloneable } from '../../src/worker/cloneable';

describe('cloneable — a cause that cannot cross postMessage', () => {
  // THE decisive test, and the reason this module exists. Every caller is
  // already inside a `catch` building an error reply, so a throw here would
  // send no reply at all and the client would wait for ever.
  //
  // Falsifiable: delete the try/catch and return `value` unconditionally —
  // this throws DataCloneError instead of returning a string.
  it('reduces an unclonable value to its string form instead of throwing', () => {
    const unclonable = () => 'not structured-cloneable';
    expect(cloneable(unclonable)).toBe(String(unclonable));
  });

  // Falsifiable: return `String(value)` unconditionally — this returns a string
  // instead of the object, and a consumer loses the cause's structure for
  // every error, not only the ones that could not survive.
  it('hands a clonable value back untouched, by identity', () => {
    const cause = { code: 'SQLITE_BUSY', detail: { retryable: true } };
    expect(cloneable(cause)).toBe(cause);
  });

  it('carries the value shapes an error cause actually uses', () => {
    const error = new Error('boom');
    expect(cloneable(error)).toBe(error);
    expect(cloneable(new Uint8Array([1, 2, 3]))).toBeInstanceOf(Uint8Array);
    expect(cloneable(null)).toBe(null);
    expect(cloneable(undefined)).toBe(undefined);
    expect(cloneable(42)).toBe(42);
  });

  // A leaked port per error would be a slow drain on a worker that stays alive
  // for the life of the client. Falsifiable only by inspection — no observable
  // exists for a closed MessagePort — so this asserts the volume instead: a
  // thousand probes must not disturb the result.
  it('survives being called a thousand times', () => {
    for (let i = 0; i < 1000; i += 1) {
      expect(cloneable({ i })).toEqual({ i });
    }
    const unclonable = () => 1;
    expect(cloneable(unclonable)).toBe(String(unclonable));
  });
});
