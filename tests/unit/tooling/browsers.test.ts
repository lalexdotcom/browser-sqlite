import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start as startSafaridriver } from 'safaridriver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheItem } from '../../../scripts/browser-cache.ts';
import {
  assertBrowserAvailable,
  browserCapabilities,
  browserVersion,
  cacheItems,
  type DownloadedBrowser,
  endSafariSession,
  FIREFOX_POLICIES,
  firefoxPoliciesPath,
  GECKODRIVER_VERSION,
  PINNED,
  parseBrowserList,
  releaseSafaridriver,
  resolveBrowsers,
  SAFARI_AUTOMATION_HINT,
  withSafariHint,
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
  const bins = { browser: '/c/browser', driver: '/c/driver' };

  it('hands WebdriverIO both binaries of each browser', () => {
    // Falsifiable: drop one binary and WebdriverIO downloads it (spec goal 2).
    const c = browserCapabilities('chrome', bins, {}, {});
    expect(c['goog:chromeOptions']?.binary).toBe('/c/browser');
    expect(c['wdio:chromedriverOptions']?.binary).toBe('/c/driver');
    const f = browserCapabilities('firefox', bins, {}, {});
    expect(f['moz:firefoxOptions']?.binary).toBe('/c/browser');
    expect(f['wdio:geckodriverOptions']).toEqual({
      geckoDriverVersion: GECKODRIVER_VERSION,
      binary: '/c/driver',
    });
    expect(GECKODRIVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(c['wdio:geckodriverOptions']).toBeUndefined();
  });

  // Falsifiable: let Safari fall through to Firefox's model and WebdriverIO
  // gets a binary, a version and a headless flag Safari has no use for.
  it('gives Safari its name and nothing else', () => {
    expect(
      browserCapabilities('safari', bins, { args: ['-headless'] }, {}),
    ).toEqual({ browserName: 'safari' });
  });

  it('keeps the binary when the caller brings its own options', () => {
    // Falsifiable: spread the caller's options over the key and the binary is lost (bench/check, consumer-smoke).
    const c = browserCapabilities(
      'chrome',
      bins,
      { args: ['--headless=new'], prefs: { p: 1 } },
      { BSQ_EXPOSE_GC: '1' },
    );
    expect(c['goog:chromeOptions']).toEqual({
      binary: '/c/browser',
      args: ['--js-flags=--expose-gc', '--headless=new'],
      prefs: { p: 1 },
    });
  });

  it('adds --expose-gc to Chrome only under BSQ_EXPOSE_GC=1', () => {
    expect(
      browserCapabilities('chrome', bins, {}, {})['goog:chromeOptions'],
    ).toEqual({ binary: '/c/browser' });
    expect(
      browserCapabilities('chrome', bins, {}, { BSQ_EXPOSE_GC: '1' })[
        'goog:chromeOptions'
      ]?.args,
    ).toEqual(['--js-flags=--expose-gc']);
    expect(
      browserCapabilities('firefox', bins, {}, { BSQ_EXPOSE_GC: '1' })[
        'moz:firefoxOptions'
      ],
    ).toEqual({ binary: '/c/browser' });
  });
});

describe('parseBrowserList', () => {
  // Falsifiable: default to every known browser and `install` with no list
  // tries Safari on Linux (spec goal 1: Safari is opt-in everywhere).
  it('is Chrome and Firefox when no list is given, never Safari', () => {
    expect(parseBrowserList(undefined)).toEqual(['chrome', 'firefox']);
  });

  it('takes one name or a comma-separated list, in the given order', () => {
    expect(parseBrowserList('chrome')).toEqual(['chrome']);
    expect(parseBrowserList('firefox,chrome')).toEqual(['firefox', 'chrome']);
  });

  it('takes safari when named', () => {
    expect(parseBrowserList('safari,chrome')).toEqual(['safari', 'chrome']);
  });

  it('ignores empty entries and repeats', () => {
    expect(parseBrowserList('chrome,,chrome')).toEqual(['chrome']);
  });

  // Falsifiable: filter unknown names out instead of throwing — a typo then
  // installs nothing for it, and the job fails much later at launch.
  it('refuses an unknown name, naming the valid ones', () => {
    expect(() => parseBrowserList('chrome,edge')).toThrow(
      'browsers: unknown browser "edge" — expected chrome, firefox, safari',
    );
  });

  it('refuses a list that names nothing', () => {
    expect(() => parseBrowserList(',')).toThrow(/names no browser/);
  });
});

describe('assertBrowserAvailable', () => {
  // Falsifiable: skip Safari silently off macOS and a run asked for Safari
  // passes having tested nothing on it (spec goal 3).
  it('refuses Safari off macOS, naming the platform', () => {
    expect(() => assertBrowserAvailable('safari', 'linux')).toThrow(
      'browsers: Safari runs on macOS only, not on linux',
    );
    expect(() => assertBrowserAvailable('safari', 'win32')).toThrow(
      'browsers: Safari runs on macOS only, not on win32',
    );
  });

  it('lets Safari through on macOS and every browser elsewhere', () => {
    expect(() => assertBrowserAvailable('safari', 'darwin')).not.toThrow();
    expect(() => assertBrowserAvailable('chrome', 'linux')).not.toThrow();
    expect(() => assertBrowserAvailable('firefox', 'win32')).not.toThrow();
  });
});

describe('releaseSafaridriver', () => {
  // Node itself, which exits at once on safaridriver's `--port`: a real
  // process with a pid. A path that cannot start has none on macOS, where
  // posix_spawn fails before any fork, and the package's kill() then
  // signalled this job's whole process group (exit 143, 2026-10-22).
  const node = { path: process.execPath };
  const startQuietly = () => startSafaridriver(node).on('error', () => {});

  // Falsifiable: drop the release and the planner's second Safari probe throws
  // "There is already a Safaridriver instance running" (macOS 26/27, 2026-10-22).
  it('lets a second safaridriver start in the same process', () => {
    startQuietly();
    expect(startQuietly).toThrow('already a Safaridriver instance');
    releaseSafaridriver();
    expect(startQuietly).not.toThrow();
    releaseSafaridriver();
  });

  // Falsifiable: release only after a clean close and a Safari that crashed
  // during a probe leaves the next probe refused, its own error masked.
  it('releases safaridriver even when the session will not close', async () => {
    startQuietly();
    await expect(
      endSafariSession(async () => {
        throw new Error('invalid session id');
      }),
    ).resolves.toBeUndefined();
    expect(startQuietly).not.toThrow();
    releaseSafaridriver();
  });

  // Falsifiable: let the two copies diverge (a WebdriverIO upgrade) and the
  // release resets a module WebdriverIO does not use.
  it('is the safaridriver module WebdriverIO starts', () => {
    const resolveFrom = (from: string, name: string) =>
      createRequire(from).resolve(name);
    const ours = realpathSync(
      resolveFrom(import.meta.filename, 'safaridriver'),
    );
    const webdriverio = resolveFrom(import.meta.filename, 'webdriverio');
    // @wdio/utils exports no `require` entry: find its folder the way Node
    // would, from webdriverio's own lookup paths.
    const utils = (
      createRequire(webdriverio).resolve.paths('@wdio/utils') ?? []
    )
      .map((dir) => join(dir, '@wdio', 'utils', 'package.json'))
      .find(existsSync);
    expect(utils).toBeDefined();
    const theirs = realpathSync(resolveFrom(utils as string, 'safaridriver'));
    expect(ours).toBe(theirs);
  });
});

describe('withSafariHint', () => {
  // Falsifiable: replace the error instead of extending it and the real
  // cause of a refused session is lost.
  it('appends the remote-automation hint and keeps the original message', () => {
    const original = new Error('Could not create a session: boom');
    const hinted = withSafariHint(original);
    expect(hinted).toBeInstanceOf(Error);
    const { message, cause } = hinted as Error;
    expect(message.startsWith('Could not create a session: boom')).toBe(true);
    expect(message).toContain(SAFARI_AUTOMATION_HINT);
    expect(cause).toBe(original);
  });

  // Falsifiable: hint on every error and a second session, refused because
  // one is already open, sends the reader to a setting that is already on.
  it('leaves already paired untouched', () => {
    const paired = new Error('Session not created: already paired');
    expect(withSafariHint(paired)).toBe(paired);
  });

  // Falsifiable: hint on it and a second session in one process, refused by
  // the safaridriver package itself, sends the reader to Safari's settings.
  it('leaves a driver already running in this process untouched', () => {
    const running = new Error(
      'There is already a Safaridriver instance running on port 49201!',
    );
    expect(withSafariHint(running)).toBe(running);
  });

  it('wraps a non-Error', () => {
    const hinted = withSafariHint('x');
    expect(hinted).toBeInstanceOf(Error);
    expect((hinted as Error).message).toContain(SAFARI_AUTOMATION_HINT);
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
  const fakeItems = (name: DownloadedBrowser) => ({
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

  // Falsifiable: give Safari a cache item and the install tries to download it.
  it('installs nothing for Safari, on macOS', async () => {
    const r = await resolveBrowsers(['safari'], {
      cacheDir,
      items: () => {
        throw new Error('must not install');
      },
      log: () => {},
      platform: 'darwin',
    });
    expect(r).toEqual({
      safari: {
        browser: '/Applications/Safari.app',
        driver: '/usr/bin/safaridriver',
      },
    });
  });

  it('refuses Safari off macOS before installing anything', async () => {
    let asked = false;
    await expect(
      resolveBrowsers(['chrome', 'safari'], {
        cacheDir,
        items: (name) => {
          asked = true;
          return fakeItems(name);
        },
        log: () => {},
        platform: 'linux',
      }),
    ).rejects.toThrow('browsers: Safari runs on macOS only, not on linux');
    expect(asked).toBe(false);
    expect(fetchCount).toBe(0);
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
