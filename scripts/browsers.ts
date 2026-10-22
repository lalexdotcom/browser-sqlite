/**
 * The browsers every harness of this repository drives: the Vitest projects,
 * `consumer-smoke` and `bench/check`. Chrome a few majors behind the newest
 * and the Firefox release current on that Chrome's stable date (2026-09-08),
 * so the two are of one age (mem:conventions).
 *
 *   node scripts/browsers.ts deps            apt packages both need, on one line (Linux)
 *   node scripts/browsers.ts install [list]  download the browsers in list (chrome,firefox
 *                                            by default; safari only when named, macOS only,
 *                                            nothing to download), open and close a session
 *                                            with each, and turn off Firefox's self-update
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
} from '@puppeteer/browsers';
import { download } from 'geckodriver';
import { stop as stopSafaridriver } from 'safaridriver';
import {
  type CacheItem,
  installItem,
  isInstalled,
  renameWithRetry,
  sweepStaging,
} from './browser-cache.ts';
import {
  ALL_BROWSERS,
  type BrowserName,
  DEFAULT_BROWSERS,
  type DownloadedBrowser,
  isBrowserName,
} from './browser-names.ts';
import {
  INSTALL_BOUND_MS,
  lockPath,
  runOnce,
  WAIT_MARGIN_MS,
} from './install-lock.ts';
import { timeScale } from './processes.ts';

export {
  ALL_BROWSERS,
  type BrowserName,
  DEFAULT_BROWSERS,
  type DownloadedBrowser,
  isBrowserName,
} from './browser-names.ts';

export const PINNED: Readonly<Record<DownloadedBrowser, string>> = {
  chrome: '153.0.8010.52',
  firefox: 'stable_155.0.1',
};

/** Throws when `name` cannot run on `platform`: Safari exists on macOS only. */
export function assertBrowserAvailable(
  name: BrowserName,
  platform: NodeJS.Platform = process.platform,
): void {
  if (name === 'safari' && platform !== 'darwin') {
    throw new Error(`browsers: Safari runs on macOS only, not on ${platform}`);
  }
}

export const SAFARI_AUTOMATION_HINT =
  'Safari refused the WebDriver session. Turn on remote automation, once per machine: in Safari, Settings > Advanced > "Show features for web developers", then Settings > Developer > "Allow remote automation"; or run `sudo safaridriver --enable`.';

/**
 * A refused Safari session, with the way to turn remote automation on. The
 * text safaridriver gives when it is off is not recorded, so every refusal
 * gets the hint but `already paired`: a second session while one is open.
 */
export function withSafariHint(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  // A second session refused by Safari, or by the safaridriver package in
  // this very process (releaseSafaridriver): remote automation is on.
  if (
    message.includes('already paired') ||
    message.includes('already a Safaridriver instance')
  ) {
    return error;
  }
  return new Error(`${message}\n${SAFARI_AUTOMATION_HINT}`, { cause: error });
}

/**
 * Lets the next Safari session of this process start its own safaridriver.
 * WebdriverIO kills safaridriver when a session ends, but the `safaridriver`
 * package keeps it as its running instance and refuses a second start ("There
 * is already a Safaridriver instance running"). The dev dependency is pinned
 * to the version WebdriverIO uses, so this is the module it started.
 */
export const releaseSafaridriver = (): void => stopSafaridriver();

const SAFARI_APP = '/Applications/Safari.app';

/** The Safari the OS ships, the only one there is: it can be neither pinned nor installed. */
export const safariVersion = (): string =>
  execFileSync(
    'plutil',
    [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o',
      '-',
      join(SAFARI_APP, 'Contents', 'Info.plist'),
    ],
    { encoding: 'utf8' },
  ).trim();

/** `chrome,firefox` → the browsers to install, in that order; Chrome and Firefox when omitted. */
export function parseBrowserList(arg: string | undefined): BrowserName[] {
  if (arg === undefined) return [...DEFAULT_BROWSERS];
  const names: BrowserName[] = [];
  for (const entry of arg.split(',').map((s) => s.trim())) {
    if (entry === '') continue;
    if (!isBrowserName(entry)) {
      throw new Error(
        `browsers: unknown browser "${entry}" — expected ${ALL_BROWSERS.join(', ')}`,
      );
    }
    if (!names.includes(entry)) names.push(entry);
  }
  if (names.length === 0) {
    throw new Error(`browsers: "${arg}" names no browser`);
  }
  return names;
}

/** The geckodriver WebdriverIO would otherwise resolve to the latest release; the CI cache key hashes this file. */
export const GECKODRIVER_VERSION = '0.37.1';

/** Where WebdriverIO keeps the browsers and drivers it downloads. */
export const WDIO_CACHE_DIR = fileURLToPath(
  new URL('../node_modules/.cache/wdio', import.meta.url),
);

export { FIREFOX_POLICIES, firefoxPoliciesPath } from './browser-cache.ts';

const ENV_VAR: Record<DownloadedBrowser, string> = {
  chrome: 'BSQ_CHROME_VERSION',
  firefox: 'BSQ_FIREFOX_VERSION',
};

const FIREFOX_CHANNELS = /^(stable|beta|devedition|esr|nightly)_/;

export const browserVersion = (
  name: DownloadedBrowser,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const version = env[ENV_VAR[name]] || PINNED[name];
  // @puppeteer/browsers reads a bare Firefox number, or `latest`, as a Nightly.
  if (name === 'firefox' && !FIREFOX_CHANNELS.test(version)) {
    throw new Error(
      `${ENV_VAR.firefox}="${version}" needs a channel prefix, e.g. stable_${version}`,
    );
  }
  return version;
};

export const browserCapabilities = (
  name: BrowserName,
  binaries: BrowserBinaries,
  extra: BrowserOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): WebdriverIO.Capabilities => {
  // WebdriverIO starts /usr/bin/safaridriver itself; Safari takes no binary,
  // no version and no headless mode.
  if (name === 'safari') return { browserName: 'safari' };
  // Both binaries are named, so WebdriverIO has nothing left to download.
  const args =
    name === 'chrome' && env.BSQ_EXPOSE_GC === '1'
      ? ['--js-flags=--expose-gc', ...(extra.args ?? [])]
      : extra.args;
  const options = {
    binary: binaries.browser,
    ...(args?.length ? { args } : {}),
    ...(extra.prefs ? { prefs: extra.prefs } : {}),
  };
  return {
    browserName: name,
    browserVersion: browserVersion(name, env),
    ...(name === 'chrome'
      ? {
          'goog:chromeOptions': options as ChromeOptions,
          'wdio:chromedriverOptions': { binary: binaries.driver },
        }
      : {
          'moz:firefoxOptions': options as FirefoxOptions,
          'wdio:geckodriverOptions': {
            geckoDriverVersion: GECKODRIVER_VERSION,
            binary: binaries.driver,
          },
        }),
  };
};

type ChromeOptions = NonNullable<
  WebdriverIO.Capabilities['goog:chromeOptions']
>;
type FirefoxOptions = NonNullable<
  WebdriverIO.Capabilities['moz:firefoxOptions']
>;

/** What a harness adds to a browser's own options: launch arguments and profile preferences. */
export interface BrowserOptions {
  args?: string[];
  prefs?: Record<string, unknown>;
}

/** The paths a harness launches: absolute, inside the cache. */
export interface BrowserBinaries {
  browser: string;
  driver: string;
}

/** A @puppeteer/browsers download as a cache item: `dir` is the installation folder, `executable` what is under it. */
function puppeteerItem(
  browser: Browser,
  buildId: string,
  policies: boolean,
): CacheItem {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error('browsers: unsupported platform');
  const [kind, version, ...inside] = relative(
    '.',
    computeExecutablePath({ cacheDir: '.', browser, buildId, platform }),
  ).split(sep);
  const dir = join(kind as string, version as string);
  return {
    dir,
    executable: join(...inside),
    policies,
    fetch: async (target) => {
      // A private cache next to `target`, so the rename stays on one volume and a sweep reads its owner's pid.
      const scratch = mkdtempSync(
        join(dirname(target), `${process.pid}-puppeteer-`),
      );
      try {
        await install({ browser, buildId, cacheDir: scratch });
        rmSync(target, { recursive: true, force: true });
        await renameWithRetry(join(scratch, dir), target);
      } finally {
        try {
          rmSync(scratch, { recursive: true, force: true });
        } catch {}
      }
    },
  };
}

/** The driver and the browser of `name` at the versions in force. */
export function cacheItems(
  name: DownloadedBrowser,
  env: NodeJS.ProcessEnv = process.env,
): { browser: CacheItem; driver: CacheItem } {
  const buildId = browserVersion(name, env);
  if (name === 'chrome') {
    return {
      browser: puppeteerItem(Browser.CHROME, buildId, false),
      driver: puppeteerItem(Browser.CHROMEDRIVER, buildId, false),
    };
  }
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error('browsers: unsupported platform');
  const executable = `geckodriver-${GECKODRIVER_VERSION}${process.platform === 'win32' ? '.exe' : ''}`;
  return {
    browser: puppeteerItem(Browser.FIREFOX, buildId, true),
    driver: {
      dir: join('geckodriver', `${platform}-${GECKODRIVER_VERSION}`),
      executable,
      policies: false,
      fetch: async (target) => {
        const path = await download(GECKODRIVER_VERSION, target);
        if (path !== join(target, executable)) {
          throw new Error(`browsers: geckodriver landed at ${path}`);
        }
      },
    },
  };
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  /** Test seam. */
  items?: typeof cacheItems;
  /** Progress lines, without newline; stderr by default so `deps` keeps stdout for its packages. */
  log?: (line: string) => void;
  /** Test seam. */
  platform?: NodeJS.Platform;
}

/**
 * Installs what `names` need and is missing, once across all processes asking
 * (one leads, the others wait), and returns the paths of what is installed.
 */
export async function resolveBrowsers(
  names: readonly BrowserName[],
  options: ResolveOptions = {},
): Promise<Record<BrowserName, BrowserBinaries>> {
  const {
    env = process.env,
    items = cacheItems,
    log = (line) => {
      process.stderr.write(`${line}\n`);
    },
    platform = process.platform,
  } = options;
  for (const name of names) assertBrowserAvailable(name, platform);
  const cacheDir = resolve(options.cacheDir ?? WDIO_CACHE_DIR);
  const downloaded = names.filter(
    (name): name is DownloadedBrowser => name !== 'safari',
  );
  const wanted = downloaded.map((name) => [name, items(name, env)] as const);
  const all = wanted.flatMap(([, item]) => [item.browser, item.driver]);
  const installBound = INSTALL_BOUND_MS * timeScale();
  await runOnce({
    path: lockPath(cacheDir),
    done: async () => all.every((item) => isInstalled(cacheDir, item)),
    install: async () => {
      sweepStaging(cacheDir);
      for (const item of all) {
        if (isInstalled(cacheDir, item)) continue;
        log(`browsers: installing ${item.dir}`);
        await installItem(cacheDir, item);
      }
    },
    installBound,
    waitBound: installBound + WAIT_MARGIN_MS * timeScale(),
    log: (line) => log(`browsers: ${line}`),
  });
  const binary = (item: CacheItem) => join(cacheDir, item.dir, item.executable);
  const itemOf = new Map(wanted);
  return Object.fromEntries(
    names.map((name) => {
      if (name === 'safari') {
        return [name, { browser: SAFARI_APP, driver: '/usr/bin/safaridriver' }];
      }
      const item = itemOf.get(name) as ReturnType<typeof cacheItems>;
      return [
        name,
        { browser: binary(item.browser), driver: binary(item.driver) },
      ];
    }),
  ) as Record<BrowserName, BrowserBinaries>;
}

/** `libfoo (>= 1)` / `liba | libb` → `libfoo`, `liba`: the first alternative, no version. */
const firstAlternative = (line: string) =>
  line
    .split('|')[0]
    ?.replace(/\(.*\)/, '')
    .trim() ?? '';

/** Chrome for Testing ships its Debian dependencies as `deb.deps`; Firefox's are Debian's `firefox-esr`'s. */
async function deps(): Promise<string[]> {
  const chromeDir = dirname((await resolveBrowsers(['chrome'])).chrome.browser);
  const chrome = readFileSync(join(chromeDir, 'deb.deps'), 'utf8')
    .split('\n')
    .map(firstAlternative)
    .filter(Boolean);
  const firefox = execFileSync(
    'apt-cache',
    [
      'depends',
      '--no-recommends',
      '--no-suggests',
      '--no-conflicts',
      '--no-breaks',
      '--no-replaces',
      '--no-enhances',
      'firefox-esr',
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((l) => /^\s*Depends: lib/.test(l))
    .map((l) =>
      l
        .replace(/^\s*Depends:\s*/, '')
        .replace(/[<>]/g, '')
        .trim(),
    );
  return [...new Set([...chrome, ...firefox])].sort();
}

async function installAll(names: readonly BrowserName[]) {
  const { remote } = await import('webdriverio');
  const all = await resolveBrowsers(names);
  for (const name of names) {
    const browser = await remote({
      // geckodriver relays a fresh Firefox profile's own startup noise as WARN.
      logLevel: 'error',
      cacheDir: WDIO_CACHE_DIR,
      capabilities: browserCapabilities(name, all[name], {
        args: [name === 'chrome' ? '--headless=new' : '-headless'],
      }),
    }).catch((error: unknown) => {
      throw name === 'safari' ? withSafariHint(error) : error;
    });
    const version = (browser.capabilities as { browserVersion?: string })
      .browserVersion;
    await browser.deleteSession();
    console.log(`${name} ${version}: ok`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  if (command === 'deps') {
    if (process.platform !== 'linux') {
      console.error('browsers deps: Linux only (apt packages)');
      process.exit(2);
    }
    console.log((await deps()).join(' '));
  } else if (command === 'install') {
    const names = parseBrowserList(process.argv[3]);
    try {
      for (const name of names) assertBrowserAvailable(name);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(2);
    }
    await installAll(names);
  } else {
    console.error(
      'usage: node scripts/browsers.ts deps | install [chrome,firefox,safari]',
    );
    process.exit(2);
  }
}
