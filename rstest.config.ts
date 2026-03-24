import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';

// Injects COOP/COEP headers into the rstest browser dev server so that
// SharedArrayBuffer is available (cross-origin isolation requirement).
// D-04: headers required for WorkerOrchestrator SharedArrayBuffer construction.
const pluginCrossOriginIsolation = {
  name: 'rsbuild:cross-origin-isolation',
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
  projects: [
    {
      name: 'unit',
      include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
      exclude: ['tests/browser/**'],
      passWithNoTests: true,
    },
    {
      name: 'browser',
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
    },
  ],
});
