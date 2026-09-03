import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';
import { pluginSilenceWorkerHmrLogs } from './rstest.config';

/**
 * The Firefox half of the browser suite.
 *
 * It lives in its own file because rstest 0.11.8 refuses two browser-enabled
 * projects with different engines in one run — "All browser-enabled projects in
 * one run must share provider/browser/headless/providerOptions". The `test`
 * script chains the two configs, so `pnpm test` still covers both engines in
 * one command and CI needs no environment variable.
 *
 * `tests/browser/*.test.ts` is the shared suite, run by both engines; anything
 * under `tests/browser/firefox/` asserts behaviour that is Firefox's alone —
 * today, handle starvation, which cannot happen where `readwrite-unsafe` gives
 * each connection its own OPFS access handle.
 */
export default defineConfig({
  extends: withRslibConfig(),
  projects: [
    {
      name: 'firefox',
      browser: {
        enabled: true,
        provider: 'playwright',
        browser: 'firefox',
        headless: true,
      },
      plugins: [pluginSilenceWorkerHmrLogs],
      include: ['tests/browser/*.test.ts', 'tests/browser/firefox/**/*.test.ts'],
      exclude: ['**/worktrees/**'],
      testTimeout: 30000,
    },
  ],
});
