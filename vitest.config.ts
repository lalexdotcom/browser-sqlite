import { fileURLToPath } from 'node:url';
import { webdriverio } from '@vitest/browser-webdriverio';
import {
  configDefaults,
  defineConfig,
  type TestProjectInlineConfiguration,
} from 'vitest/config';
import {
  type BrowserName,
  browserCapabilities,
  WDIO_CACHE_DIR,
} from './scripts/browsers.ts';
import type { TestTarget } from './tests/browser/target.ts';
import {
  CHROMIUM_FEATURES,
  FIREFOX_FEATURES,
  onUnmetFromEnv,
  targetLabel,
  targetsFromEnv,
} from './tests/target-projects.ts';

const ENGINES: readonly BrowserName[] = ['chrome', 'firefox'];
const FEATURES = { chrome: CHROMIUM_FEATURES, firefox: FIREFOX_FEATURES };
/** The engine-only directory each project adds to the shared, non-recursive glob. */
const ENGINE_DIR = { chrome: 'chromium', firefox: 'firefox' };
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const onUnmet = onUnmetFromEnv(process.env.BSQ_TEST_NEEDS);
const built = (file: string) =>
  fileURLToPath(new URL(`./tests/build/${file}`, import.meta.url));

/**
 * One browser project. Each builds its own `instances` array: Vitest renames
 * an instance in place, and two projects sharing one fail at startup.
 */
const browserProject = (
  name: string,
  browser: BrowserName,
  include: string[],
  options: { target?: TestTarget; isolated?: boolean; testTimeout: number },
): TestProjectInlineConfiguration => ({
  extends: true,
  ...(options.isolated ? { server: { headers: ISOLATION } } : {}),
  test: {
    name,
    include,
    globalSetup: ['tests/build-setup.ts'],
    testTimeout: options.testTimeout,
    // A teardown closes a client that may still be draining an abandoned
    // statement, and close() waits up to drainTimeout (60 s by default).
    hookTimeout: 60_000,
    ...(options.target
      ? { provide: { bsqTarget: options.target, bsqNeeds: onUnmet } }
      : {}),
    browser: {
      enabled: true,
      headless: true,
      provider: webdriverio({
        cacheDir: WDIO_CACHE_DIR,
        capabilities: browserCapabilities(browser),
      }),
      instances: [{ browser, name }],
    },
  },
});

export default defineConfig({
  resolve: {
    alias: [
      { find: /^browser-sqlite$/, replacement: built('index.js') },
      { find: /^browser-sqlite\/testing$/, replacement: built('testing.js') },
    ],
  },
  test: {
    // Root-only option: Vitest rejects it inside a project.
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
          // configDefaults.exclude keeps node_modules out: the consumer
          // fixtures under tests/ install their own.
          exclude: [
            ...configDefaults.exclude,
            'tests/browser/**',
            'tests/conformance/**',
            'tests/consumer*/**',
          ],
          // Pure Node tests with no I/O: anything near this bound is a deadlock.
          testTimeout: 10_000,
        },
      },
      ...ENGINES.flatMap((browser) =>
        targetsFromEnv(process.env.BSQ_TEST_TARGETS, FEATURES[browser]).flatMap(
          (target) => [
            browserProject(
              `${browser} · ${targetLabel(target)}`,
              browser,
              [
                'tests/browser/*.test.ts',
                `tests/browser/${ENGINE_DIR[browser]}/**/*.test.ts`,
              ],
              { target, testTimeout: 30_000 },
            ),
            browserProject(
              `isolated ${browser} · ${targetLabel(target)}`,
              browser,
              ['tests/browser/isolated/**/*.test.ts'],
              { target, isolated: true, testTimeout: 30_000 },
            ),
          ],
        ),
      ),
      ...ENGINES.map((browser) =>
        browserProject(
          `conformance ${browser}`,
          browser,
          ['tests/conformance/**/*.test.ts'],
          { testTimeout: 60_000 },
        ),
      ),
    ],
  },
});
