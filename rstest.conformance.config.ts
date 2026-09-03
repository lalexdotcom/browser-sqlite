import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';
import { pluginSilenceWorkerHmrLogs } from './rstest.config';

/**
 * Separate from rstest.config.ts on purpose. Eight VFS through the invariants
 * start workers and open real storage, which is too slow for the suite a
 * developer runs on every change. This one runs on demand and in CI.
 *
 * It holds invariants only. Measurements belong to the benchmark page, on the
 * machine of whoever opens it — CI runs tests, not benchmarks.
 *
 * The Chromium half. Firefox is in rstest.conformance.firefox.config.ts and
 * `pnpm test:conformance` chains the two, because rstest 0.11.8 refuses two
 * browser-enabled projects with different engines in one run. There is no
 * per-engine directory here and there should not be: the whole value of this
 * suite is the SAME invariants on both engines — a VFS sound on one and broken
 * on the other is how HANDLE-1 was found.
 */
export default defineConfig({
  extends: withRslibConfig(),
  projects: [
    {
      name: 'conformance',
      browser: {
        enabled: true,
        provider: 'playwright',
        browser: 'chromium',
        headless: true,
      },
      plugins: [pluginSilenceWorkerHmrLogs],
      include: ['tests/conformance/**/*.test.ts'],
      testTimeout: 60000,
    },
  ],
});
