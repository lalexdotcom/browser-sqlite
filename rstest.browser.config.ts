import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';

// Injects COOP/COEP headers into the rstest browser dev server so that
// SharedArrayBuffer is available (cross-origin isolation requirement).
// D-04: headers required for WorkerOrchestrator SharedArrayBuffer construction.
const pluginCrossOriginIsolation = {
  name: 'rsbuild:cross-origin-isolation',
  setup(api: { modifyRsbuildConfig: Function }) {
    api.modifyRsbuildConfig(
      (
        config: object,
        { mergeRsbuildConfig }: { mergeRsbuildConfig: Function },
      ) =>
        mergeRsbuildConfig(config, {
          server: {
            headers: {
              'Cross-Origin-Opener-Policy': 'same-origin',
              'Cross-Origin-Embedder-Policy': 'require-corp',
            },
          },
        }),
    );
  },
};

export default defineConfig({
  extends: withRslibConfig(),
  browser: {
    enabled: true,
    provider: 'playwright',
    browser: 'chromium',
    headless: true,
  },
  plugins: [pluginCrossOriginIsolation],
  include: ['tests/browser/**/*.test.ts'],
  exclude: ['**/worktrees/**'],
  testTimeout: 30000,
});
