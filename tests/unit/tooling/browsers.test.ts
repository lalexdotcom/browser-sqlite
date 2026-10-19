import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheItem } from '../../../scripts/browser-cache.ts';
import {
  type BrowserName,
  browserCapabilities,
  browserVersion,
  cacheItems,
  FIREFOX_POLICIES,
  firefoxPoliciesPath,
  GECKODRIVER_VERSION,
  PINNED,
  parseBrowserList,
  resolveBrowsers,
} from '../../../scripts/browsers.ts';

describe('firefoxPoliciesPath', () => {
  // Built with join(): the function uses the platform's separator, and the
  // suite runs on Windows too.
  it('is distribution/policies.json beside the binary on Linux and Windows', () => {
    const dir = join('cache', 'firefox', 'linux_arm-stable_155.0.1', 'firefox');
    expect(firefoxPoliciesPath(join(dir, 'firefox'))).toBe(
      join(dir, 'distribution', 'policies.json'),
    );
  });

  it('is under Contents/Resources in a macOS bundle', () => {
    const contents = join(
      'cache',
      'firefox',
      'mac_arm-stable_155.0.1',
      'Firefox.app',
      'Contents',
    );
    expect(firefoxPoliciesPath(join(contents, 'MacOS', 'firefox'))).toBe(
      join(contents, 'Resources', 'distribution', 'policies.json'),
    );
  });

  it('disables updates', () => {
    expect(FIREFOX_POLICIES).toEqual({ policies: { DisableAppUpdate: true } });
  });
});

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

describe('resolveBrowsers', () => {
  let cacheDir: string;
  let fetchCount: number;

  const fakeItem = (dir: string): CacheItem => ({
    dir,
    executable: join('bin', 'tool'),
    policies: false,
    fetch: async (target) => {
      fetchCount += 1;
      mkdirSync(join(target, 'bin'), { recursive: true });
      writeFileSync(join(target, 'bin', 'tool'), 'x');
    },
  });
  const fakeItems = (name: BrowserName) => ({
    browser: fakeItem(`${name}/browser-1`),
    driver: fakeItem(`${name}/driver-1`),
  });

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'bsq-resolve-'));
    fetchCount = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('resolves the requested browsers to absolute paths in the cache', async () => {
    const r = await resolveBrowsers(['firefox'], {
      cacheDir,
      items: fakeItems,
      log: () => {},
    });
    expect(Object.keys(r)).toEqual(['firefox']);
    expect(r.firefox.browser).toBe(
      join(cacheDir, 'firefox', 'browser-1', 'bin', 'tool'),
    );
    expect(r.firefox.driver).toBe(
      join(cacheDir, 'firefox', 'driver-1', 'bin', 'tool'),
    );
  });

  it('fetches nothing on a second call', async () => {
    // Falsifiable: skip the done() fast path and the fetch counters read 2.
    const options = { cacheDir, items: fakeItems, log: () => {} };
    await resolveBrowsers(['chrome'], options);
    await resolveBrowsers(['chrome'], options);
    expect(fetchCount).toBe(2); // browser + driver, once each
  });

  it('installs only the items still missing', async () => {
    // Falsifiable: reinstall every requested item when one is missing and the count reads 5.
    const options = { cacheDir, items: fakeItems, log: () => {} };
    await resolveBrowsers(['chrome'], options);
    await resolveBrowsers(['chrome', 'firefox'], options);
    expect(fetchCount).toBe(4);
  });

  it('deps prints nothing but packages on stdout', async () => {
    // Falsifiable: log progress with console.log and stdout carries it.
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    await resolveBrowsers(['chrome'], { cacheDir, items: fakeItems });
    expect(stdout).not.toHaveBeenCalled();
    expect(
      stderr.mock.calls.some(([l]) =>
        String(l).includes('browsers: installing'),
      ),
    ).toBe(true);
  });

  it('prefixes the lock protocol lines like its own', async () => {
    // Falsifiable: forward the lock's lines bare and they read `installing (lock …)`.
    const lines: string[] = [];
    await resolveBrowsers(['chrome'], {
      cacheDir,
      items: fakeItems,
      log: (l) => lines.push(l),
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^browsers: /);
  });
});

describe('cacheItems', () => {
  it('names the pinned versions', () => {
    const c = cacheItems('chrome', {});
    const f = cacheItems('firefox', {});
    expect(c.browser.dir).toContain(PINNED.chrome);
    expect(c.driver.dir).toContain(PINNED.chrome);
    expect(f.browser.dir).toContain(PINNED.firefox);
    expect(f.browser.policies).toBe(true);
    expect(f.driver.dir).toContain(GECKODRIVER_VERSION);
    expect(c.browser.policies).toBe(false);
  });

  it('puts the executable inside the installation folder', () => {
    const f = cacheItems('firefox', {});
    expect(f.browser.dir.split(/[\\/]/)).toHaveLength(2);
    expect(f.browser.executable).toMatch(/firefox/);
    expect(f.driver.executable).toBe(
      `geckodriver-${GECKODRIVER_VERSION}${process.platform === 'win32' ? '.exe' : ''}`,
    );
  });

  it('follows the version overrides', () => {
    expect(
      cacheItems('chrome', { BSQ_CHROME_VERSION: '155.0.8059.39' }).browser.dir,
    ).toContain('155.0.8059.39');
  });
});
