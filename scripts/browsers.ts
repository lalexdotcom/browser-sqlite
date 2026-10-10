/**
 * The browsers every harness of this repository drives: the Vitest projects,
 * `consumer-smoke` and `bench/check`. Chrome a few majors behind the newest
 * and the Firefox release current on that Chrome's stable date (2026-09-08),
 * so the two are of one age (mem:conventions).
 *
 *   node scripts/browsers.ts deps      apt packages both need, on one line
 *   node scripts/browsers.ts install   download both, open and close a session
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
} from '@puppeteer/browsers';

export type BrowserName = 'chrome' | 'firefox';

export const PINNED: Readonly<Record<BrowserName, string>> = {
  chrome: '153.0.8010.52',
  firefox: 'stable_155.0.1',
};

/** The geckodriver WebdriverIO would otherwise resolve to the latest release; the CI cache key hashes this file. */
export const GECKODRIVER_VERSION = '0.37.1';

/** Where WebdriverIO keeps the browsers and drivers it downloads. */
export const WDIO_CACHE_DIR = fileURLToPath(
  new URL('../node_modules/.cache/wdio', import.meta.url),
);

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
  env: NodeJS.ProcessEnv = process.env,
): WebdriverIO.Capabilities => ({
  browserName: name,
  browserVersion: browserVersion(name, env),
  ...(name === 'firefox'
    ? {
        'wdio:geckodriverOptions': { geckoDriverVersion: GECKODRIVER_VERSION },
      }
    : {}),
  ...(name === 'chrome' && env.BSQ_EXPOSE_GC === '1'
    ? { 'goog:chromeOptions': { args: ['--js-flags=--expose-gc'] } }
    : {}),
});

/** `libfoo (>= 1)` / `liba | libb` → `libfoo`, `liba`: the first alternative, no version. */
const firstAlternative = (line: string) =>
  line
    .split('|')[0]
    ?.replace(/\(.*\)/, '')
    .trim() ?? '';

/** Chrome for Testing ships its Debian dependencies as `deb.deps`; Firefox's are Debian's `firefox-esr`'s. */
async function deps(): Promise<string[]> {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error('browsers: unsupported platform');
  const buildId = browserVersion('chrome');
  await install({ browser: Browser.CHROME, buildId, cacheDir: WDIO_CACHE_DIR });
  const chromeDir = join(
    computeExecutablePath({
      browser: Browser.CHROME,
      buildId,
      cacheDir: WDIO_CACHE_DIR,
      platform,
    }),
    '..',
  );
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

async function installAll() {
  const { remote } = await import('webdriverio');
  for (const name of ['chrome', 'firefox'] as const) {
    const browser = await remote({
      logLevel: 'warn',
      cacheDir: WDIO_CACHE_DIR,
      capabilities: {
        ...browserCapabilities(name),
        ...(name === 'chrome'
          ? { 'goog:chromeOptions': { args: ['--headless=new'] } }
          : { 'moz:firefoxOptions': { args: ['-headless'] } }),
      },
    });
    const version = (browser.capabilities as { browserVersion?: string })
      .browserVersion;
    await browser.deleteSession();
    console.log(`${name} ${version}: ok`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  if (command === 'deps') console.log((await deps()).join(' '));
  else if (command === 'install') await installAll();
  else {
    console.error('usage: node scripts/browsers.ts deps|install');
    process.exit(2);
  }
}
