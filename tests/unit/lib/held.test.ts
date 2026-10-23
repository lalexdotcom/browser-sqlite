import { describe, expect, it } from 'vitest';
import { isHeldElsewhere } from '../../../src/worker/held';

describe('isHeldElsewhere — a file another context still holds', () => {
  it("reads Chrome's and Firefox's name", () => {
    expect(
      isHeldElsewhere(new DOMException('held', 'NoModificationAllowedError')),
    ).toBe(true);
  });

  // Falsifiable: match the one name and on Safari a worker meeting its dead
  // predecessor's file fails at once — 7 tests per macOS, SAFARI-LIB-SUITE.
  it("reads WebKit's name for the same refusal", () => {
    expect(
      isHeldElsewhere(
        new DOMException(
          'The object is in an invalid state.',
          'InvalidStateError',
        ),
      ),
    ).toBe(true);
  });

  it('refuses any other error, and nothing at all', () => {
    expect(isHeldElsewhere(new DOMException('gone', 'NotFoundError'))).toBe(
      false,
    );
    expect(isHeldElsewhere(new Error('NoModificationAllowedError'))).toBe(
      false,
    );
    expect(isHeldElsewhere(undefined)).toBe(false);
  });
});
