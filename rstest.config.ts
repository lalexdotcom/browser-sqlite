import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';

// Suppresses "window is not defined" noise from rsbuild's HMR client running
// inside Web Worker bundles. The HMR client calls window.location.reload()
// without a typeof-window guard. Test failures are still reported through
// rstest's own reporting mechanism.
const pluginSilenceWorkerHmrLogs = {
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
      exclude: ['tests/browser/**'],
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
        browser: 'chromium',
        headless: true,
      },
      plugins: [pluginSilenceWorkerHmrLogs],
      include: ['tests/browser/**/*.test.ts'],
      exclude: ['**/worktrees/**'],
      testTimeout: 30000,
    },
  ],
});
