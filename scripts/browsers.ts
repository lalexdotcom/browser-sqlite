/**
 * The browsers every harness of this repository drives: the Vitest projects,
 * `consumer-smoke` and `bench/check`. Chrome a few majors behind the newest
 * and the Firefox release current on that Chrome's stable date (2026-09-08),
 * so the two are of one age (mem:conventions).
 *
 *   node scripts/browsers.ts deps            apt packages both need, on one line (Linux)
 *   node scripts/browsers.ts install [list]  download the browsers in list (chrome,firefox
 *                                            by default), open and close a session with each,
 *                                            and turn off Firefox's self-update
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
import {
  type CacheItem,
  installItem,
  isInstalled,
  renameWithRetry,
  sweepStaging,
} from './browser-cache.ts';
import {
  INSTALL_BOUND_MS,
  lockPath,
  runOnce,
  WAIT_MARGIN_MS,
} from './install-lock.ts';
import { timeScale } from './processes.ts';

export type BrowserName = 'chrome' | 'firefox';

export const PINNED: Readonly<Record<BrowserName, string>> = {
  chrome: '153.0.8010.52',
  firefox: 'stable_155.0.1',
};

const NAMES = Object.keys(PINNED) as BrowserName[];

/** `chrome,firefox` → the browsers to install, in that order; both when omitted. */
export function parseBrowserList(arg: string | undefined): BrowserName[] {
  if (arg === undefined) return [...NAMES];
  const names: BrowserName[] = [];
  for (const entry of arg.split(',').map((s) => s.trim())) {
    if (entry === '') continue;
    if (!NAMES.includes(entry as BrowserName)) {
      throw new Error(
        `browsers: unknown browser "${entry}" — expected ${NAMES.join(', ')}`,
      );
    }
    if (!names.includes(entry as BrowserName)) names.push(entry as BrowserName);
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

const ENV_VAR: Record<BrowserName, string> = {
  chrome: 'BSQ_CHROME_VERSION',
  firefox: 'BSQ_FIREFOX_VERSION',
};

const FIREFOX_CHANNELS = /^(stable|beta|devedition|esr|nightly)_/;

export const browserVersion = (
  name: BrowserName,
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

/** The paths a harness launches: absolute, inside the cache. */
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
  name: BrowserName,
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
  } = options;
  const cacheDir = resolve(options.cacheDir ?? WDIO_CACHE_DIR);
  const wanted = names.map((name) => [name, items(name, env)] as const);
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
  return Object.fromEntries(
    wanted.map(([name, item]) => [
      name,
      { browser: binary(item.browser), driver: binary(item.driver) },
    ]),
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
    await installAll(parseBrowserList(process.argv[3]));
  } else {
    console.error(
      'usage: node scripts/browsers.ts deps | install [chrome,firefox]',
    );
    process.exit(2);
  }
}
