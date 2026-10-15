import { fileURLToPath } from 'node:url';
import { webdriverio } from '@vitest/browser-webdriverio';
import {
  defineConfig,
  type TestProjectInlineConfiguration,
} from 'vitest/config';
import {
  type BrowserName,
  browserCapabilities,
  WDIO_CACHE_DIR,
} from '../scripts/browsers.ts';
import { timeScale } from '../scripts/processes.ts';
import { declaredTags } from './harness/planner/need.ts';
import type { TestTarget } from './harness/target.ts';
import { allTargets, targetLabel } from './harness/target-projects.ts';

const ENGINES: readonly BrowserName[] = ['chrome', 'firefox'];
const TIME_SCALE = timeScale();
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const built = (file: string) =>
  fileURLToPath(new URL(`./build/${file}`, import.meta.url));

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
    globalSetup: ['tests/harness/build-setup.ts'],
    // The files of a run share one profile: after each file its OPFS and
    // IndexedDB leftovers are erased and the erasure verified; what cannot be
    // erased fails that file, by name.
    // The guard reads the project's target, so only target projects take it.
    setupFiles: [
      'tests/browser/setup/storage-wipe.ts',
      // Before the guard: a project that is not isolated fails its files by
      // name, before any test reads the environment.
      ...(options.isolated ? ['tests/browser/setup/isolation-check.ts'] : []),
      ...(options.target ? ['tests/browser/setup/need-guard.ts'] : []),
      // Last, so the guard's own reads of the pair are discarded.
      ...(options.target && process.env.BSQ_TEST_TRACE === '1'
        ? ['tests/browser/setup/trace.ts']
        : []),
    ],
    // BSQ_TIME_SCALE: a platform N times slower than Linux gets N times the
    // bounds (scripts/processes.ts).
    testTimeout: options.testTimeout * TIME_SCALE,
    // A teardown closes a client that may still be draining an abandoned
    // statement, and close() waits up to drainTimeout (60 s by default).
    hookTimeout: 60_000 * TIME_SCALE,
    provide: {
      bsqTimeScale: TIME_SCALE,
      ...(options.target
        ? {
            bsqTarget: options.target,
            bsqEnvironment: { browser, isolated: options.isolated === true },
          }
        : {}),
    },
    browser: {
      enabled: true,
      headless: true,
      // The WebdriverIO provider cannot take it on BiDi (`switchFrame` was
      // removed in v10): every failure would print a stack trace for it.
      screenshotFailures: false,
      provider: webdriverio({
        cacheDir: WDIO_CACHE_DIR,
        capabilities: browserCapabilities(browser),
      }),
      instances: [{ browser, name }],
    },
  },
});

export default defineConfig({
  // Every path below is from the repository root, not from this folder.
  root: fileURLToPath(new URL('..', import.meta.url)),
  // One Vite cache per parallel job (scripts/parallel.ts, jobEnv): processes
  // sharing a dep-optimizer cache race when they commit it.
  ...(process.env.BSQ_VITE_CACHE_DIR
    ? { cacheDir: process.env.BSQ_VITE_CACHE_DIR }
    : {}),
  resolve: {
    alias: [
      { find: /^browser-sqlite$/, replacement: built('index.js') },
      { find: /^browser-sqlite\/testing$/, replacement: built('testing.js') },
    ],
  },
  test: {
    // Root-only option: Vitest rejects it inside a project.
    passWithNoTests: true,
    // The need vocabulary (tests/harness/planner/need.ts). Vitest refuses a tag
    // it was not told about, which is what keeps the vocabulary closed.
    tags: declaredTags().map((name) => ({ name })),
    // A test's console shows only when it fails: the library's own warnings
    // (a pool capped on Firefox) are expected in passing tests.
    silent: 'passed-only',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          // Anything near this bound is a deadlock — except git, which the
          // hook-gate tests run for real and Windows runs several times slower.
          testTimeout: 10_000 * TIME_SCALE,
        },
      },
      ...ENGINES.flatMap((browser) =>
        allTargets().flatMap((target) => [
          browserProject(
            `${browser} · ${targetLabel(target)}`,
            browser,
            ['tests/browser/pairs/*.test.ts'],
            { target, testTimeout: 30_000 },
          ),
          browserProject(
            `isolated ${browser} · ${targetLabel(target)}`,
            browser,
            ['tests/browser/pairs/*.test.ts'],
            { target, isolated: true, testTimeout: 30_000 },
          ),
        ]),
      ),
      ...ENGINES.map((browser) =>
        browserProject(
          `conformance ${browser}`,
          browser,
          ['tests/browser/conformance/*.test.ts'],
          { testTimeout: 60_000 },
        ),
      ),
      // One probe per environment the planner can select (spec § 4.2).
      ...ENGINES.flatMap((browser) =>
        [false, true].map((isolated) =>
          browserProject(
            `probe ${isolated ? 'isolated ' : ''}${browser}`,
            browser,
            ['tests/browser/probe/features.test.ts'],
            { isolated, testTimeout: 30_000 },
          ),
        ),
      ),
    ],
  },
});
