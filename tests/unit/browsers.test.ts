import { describe, expect, it } from 'vitest';
import {
  browserCapabilities,
  browserVersion,
  PINNED,
} from '../../scripts/browsers.ts';

describe('browserVersion', () => {
  it('returns the pins when nothing overrides them', () => {
    expect(browserVersion('chrome', {})).toBe(PINNED.chrome);
    expect(browserVersion('firefox', {})).toBe(PINNED.firefox);
  });

  it('takes BSQ_CHROME_VERSION and BSQ_FIREFOX_VERSION', () => {
    expect(
      browserVersion('chrome', { BSQ_CHROME_VERSION: '155.0.8059.39' }),
    ).toBe('155.0.8059.39');
    expect(
      browserVersion('firefox', { BSQ_FIREFOX_VERSION: 'stable_157.0.1' }),
    ).toBe('stable_157.0.1');
  });

  // A bare number or `latest` makes @puppeteer/browsers resolve a Nightly.
  it('refuses a Firefox version without a channel prefix', () => {
    for (const bad of ['156.0', 'latest', '157.0.1']) {
      expect(() =>
        browserVersion('firefox', { BSQ_FIREFOX_VERSION: bad }),
      ).toThrow(/channel prefix/);
    }
  });
});

describe('browserCapabilities', () => {
  it('adds --expose-gc to Chrome only under BSQ_EXPOSE_GC=1', () => {
    expect(
      browserCapabilities('chrome', {})['goog:chromeOptions'],
    ).toBeUndefined();
    expect(
      browserCapabilities('chrome', { BSQ_EXPOSE_GC: '1' })[
        'goog:chromeOptions'
      ]?.args,
    ).toEqual(['--js-flags=--expose-gc']);
    expect(
      browserCapabilities('firefox', { BSQ_EXPOSE_GC: '1' })[
        'goog:chromeOptions'
      ],
    ).toBeUndefined();
  });
});
