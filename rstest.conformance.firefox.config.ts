import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';
import { pluginSilenceWorkerHmrLogs } from './rstest.config';

/**
 * The Firefox half of the conformance suite — the SAME invariants as the
 * Chromium half, deliberately. A VFS can be sound on one engine and broken on
 * the other, which is how HANDLE-1 was found, so nothing here is engine-
 * specific and no per-engine directory exists.
 *
 * Its own file for the same reason the browser suite has one: rstest 0.11.8
 * refuses two browser-enabled projects with different engines in a single run.
 * `pnpm test:conformance` chains both, so one command covers both engines and
 * CI needs no environment variable.
 */
export default defineConfig({
  extends: withRslibConfig(),
  projects: [
    {
      name: 'conformance-firefox',
      browser: {
        enabled: true,
        provider: 'playwright',
        browser: 'firefox',
        headless: true,
      },
      plugins: [pluginSilenceWorkerHmrLogs],
      include: ['tests/conformance/**/*.test.ts'],
      testTimeout: 60000,
    },
  ],
});
