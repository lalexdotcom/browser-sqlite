import { describe, expect, it } from 'vitest';
import {
  browserCapabilities,
  browserVersion,
  GECKODRIVER_VERSION,
  PINNED,
  parseBrowserList,
} from '../../../scripts/browsers.ts';

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

  it('falls back to the pin when the variable is set but empty', () => {
    expect(browserVersion('chrome', { BSQ_CHROME_VERSION: '' })).toBe(
      PINNED.chrome,
    );
    expect(browserVersion('firefox', { BSQ_FIREFOX_VERSION: '' })).toBe(
      PINNED.firefox,
    );
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
  it('pins geckodriver for Firefox only', () => {
    expect(
      browserCapabilities('firefox', {})['wdio:geckodriverOptions'],
    ).toEqual({ geckoDriverVersion: GECKODRIVER_VERSION });
    expect(GECKODRIVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      browserCapabilities('chrome', {})['wdio:geckodriverOptions'],
    ).toBeUndefined();
  });

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

describe('parseBrowserList', () => {
  it('is both browsers when no list is given', () => {
    expect(parseBrowserList(undefined)).toEqual(['chrome', 'firefox']);
  });

  it('takes one name or a comma-separated list, in the given order', () => {
    expect(parseBrowserList('chrome')).toEqual(['chrome']);
    expect(parseBrowserList('firefox,chrome')).toEqual(['firefox', 'chrome']);
  });

  it('ignores empty entries and repeats', () => {
    expect(parseBrowserList('chrome,,chrome')).toEqual(['chrome']);
  });

  // Falsifiable: filter unknown names out instead of throwing — a typo then
  // installs nothing for it, and the job fails much later at launch.
  it('refuses an unknown name, naming the valid ones', () => {
    expect(() => parseBrowserList('chrome,safari')).toThrow(
      'browsers: unknown browser "safari" — expected chrome, firefox',
    );
  });

  it('refuses a list that names nothing', () => {
    expect(() => parseBrowserList(',')).toThrow(/names no browser/);
  });
});
