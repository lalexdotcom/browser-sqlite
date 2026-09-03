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
    // ONE browser project here, and a second engine in rstest.firefox.config.ts
    // rather than beside this one. Not a preference: rstest 0.11.8 refuses two
    // browser-enabled projects with different engines in a single run —
    // "All browser-enabled projects in one run must share
    // provider/browser/headless/providerOptions" — so a `projects` array
    // holding both makes `pnpm test` fail before it runs anything. Two configs
    // chained by the `test` script is what delivers the same coverage.
    //
    // What this replaced was TEST_BROWSER, one project whose engine came from
    // the environment. That meant a local `pnpm test` covered Chromium while CI
    // covered both — the exact path by which a Firefox-only failure reaches
    // anyone late. `pnpm test` now runs both engines and CI needs no variable.
    //
    // Only Firefox joins Chromium: Playwright installs WebKit too, but the
    // Linux build ships without OPFS, so every VFS this library uses is
    // unavailable there and the suite would report a platform gap as a failure.
    //
    // The shared glob is NON-recursive on purpose. `tests/browser/**` would
    // make this project pick up `tests/browser/firefox/`, which is the whole
    // thing this layout exists to prevent.
    {
      name: 'chromium',
      browser: {
        enabled: true,
        provider: 'playwright',
        browser: 'chromium',
        headless: true,
      },
      plugins: [pluginSilenceWorkerHmrLogs],
      include: ['tests/browser/*.test.ts', 'tests/browser/chromium/**/*.test.ts'],
      exclude: ['**/worktrees/**'],
      testTimeout: 30000,
    },
  ],
});
