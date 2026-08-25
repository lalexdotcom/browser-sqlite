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
 */
export default defineConfig({
  extends: withRslibConfig(),
  projects: [
    {
      name: 'conformance',
      browser: {
        enabled: true,
        provider: 'playwright',
        browser: (process.env.CONFORMANCE_BROWSER ?? 'chromium') as
          | 'chromium'
          | 'firefox',
        headless: true,
      },
      plugins: [pluginSilenceWorkerHmrLogs],
      include: ['tests/conformance/**/*.test.ts'],
      testTimeout: 60000,
    },
  ],
});
