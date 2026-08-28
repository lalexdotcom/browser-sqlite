import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';

// Suppresses "window is not defined" noise from rsbuild's HMR client running
// inside Web Worker bundles. The HMR client calls window.location.reload()
// without a typeof-window guard. Test failures are still reported through
// rstest's own reporting mechanism.
export const pluginSilenceWorkerHmrLogs = {
  name: 'rsbuild:silence-worker-hmr-logs',
  setup(api: {
    modifyRsbuildConfig: (
      fn: (
        config: Record<string, unknown>,
        utils: {
          mergeRsbuildConfig: (
            ...configs: Record<string, unknown>[]
          ) => Record<string, unknown>;
        },
      ) => Record<string, unknown>,
    ) => void;
  }) {
    api.modifyRsbuildConfig(
      (
        config: Record<string, unknown>,
        {
          mergeRsbuildConfig,
        }: {
          mergeRsbuildConfig: (
            ...configs: Record<string, unknown>[]
          ) => Record<string, unknown>;
        },
      ) =>
        mergeRsbuildConfig(config, {
          dev: {
            // Disable browser error forwarding to suppress "window is not
            // defined" noise from rsbuild's HMR client running inside Web
            // Worker bundles. The HMR client calls window.location.reload()
            // without a typeof-window guard. Test failures are still reported
            // through rstest's own reporting mechanism.
            browserLogs: false,
          },
        }),
    );
  },
};

export default defineConfig({
  extends: withRslibConfig(),
  projects: [
    {
      name: 'unit',
      include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
      exclude: ['tests/browser/**', 'tests/conformance/**'],
      passWithNoTests: true,
      // Explicit rather than inherited: these are pure Node tests with no I/O,
      // so anything approaching this bound is a deadlock, not slowness.
      testTimeout: 10000,
    },
    {
      name: 'browser',
      browser: {
        enabled: true,
        provider: 'playwright',
        // Same shape as the conformance project's CONFORMANCE_BROWSER. Firefox
        // and WebKit are both installed by Playwright here, but only Firefox is
        // offered: the Linux WebKit build ships without OPFS, so every VFS this
        // library actually uses is unavailable there and the suite would report
        // a platform gap as a failure.
        //
        // Chromium stays the default for a local `pnpm test:browser`; Firefox
        // is a CI gate as of 2026-08-28 and runs as its own step (ci.yaml).
        // The two engines agree now: `lifecycle` was a calibration error and
        // `long-query` timed the file rather than the pool — both fixed, both
        // understood. Set TEST_BROWSER=firefox to reproduce a CI failure here.
        //
        // NOT named `BROWSER`: VS Code and devcontainers export that variable
        // already (here, a helper script that opens URLs), so the project read
        // it as a browser name and Playwright failed with
        // "Cannot read properties of undefined (reading 'launch')".
        browser: (process.env.TEST_BROWSER ?? 'chromium') as
          | 'chromium'
          | 'firefox',
        headless: true,
      },
      plugins: [pluginSilenceWorkerHmrLogs],
      include: ['tests/browser/**/*.test.ts'],
      exclude: ['**/worktrees/**'],
      testTimeout: 30000,
    },
  ],
});
