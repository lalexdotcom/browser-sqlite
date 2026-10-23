import { describe, expect, it } from 'vitest';
import { safariVersionOf, terminateRunsWasm } from '../../harness/webkit.ts';

const SAFARI = (v: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v} Safari/605.1.15`;
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const FIREFOX =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0';

describe('safariVersionOf', () => {
  it("reads Safari's version, a missing patch as 0", () => {
    expect(safariVersionOf(SAFARI('26.6.2'))).toEqual([26, 6, 2]);
    expect(safariVersionOf(SAFARI('27.1'))).toEqual([27, 1, 0]);
  });

  // Falsifiable: match `Safari/` alone and Chrome, whose agent ends with it,
  // takes Safari's skips.
  it('is undefined for Chrome and Firefox', () => {
    expect(safariVersionOf(CHROME)).toBeUndefined();
    expect(safariVersionOf(FIREFOX)).toBeUndefined();
  });
});

describe('terminateRunsWasm', () => {
  // Falsifiable: an open-ended bound and the skip outlives the WebKit fix.
  it('holds for every Safari measured, up to 27.0.1, and for no later one', () => {
    expect(terminateRunsWasm(SAFARI('26.6.2'))).toBe(true);
    expect(terminateRunsWasm(SAFARI('27.0.1'))).toBe(true);
    expect(terminateRunsWasm(SAFARI('27.0.2'))).toBe(false);
    expect(terminateRunsWasm(SAFARI('27.1'))).toBe(false);
  });

  it('never holds off Safari', () => {
    expect(terminateRunsWasm(CHROME)).toBe(false);
    expect(terminateRunsWasm(FIREFOX)).toBe(false);
  });
});
