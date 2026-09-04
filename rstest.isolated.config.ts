import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';
import { pluginSilenceWorkerHmrLogs } from './rstest.config';

// Cross-origin isolation cannot be expressed through rstest's `defineConfig`
// directly: a `server: { headers: ... }` key at the top level is silently
// ignored and never forwarded to the rsbuild dev server. The same pattern that
// `pluginSilenceWorkerHmrLogs` already uses — a `modifyRsbuildConfig` hook
// inside a plugin — is the supported path. This plugin lives here rather than
// in `rstest.config.ts` because it is specific to this one project: the
// ordinary projects deliberately stay un-isolated (that is what most consumers
// deploy, and the degraded path must be asserted somewhere), so this concern
// should not leak into the shared config.
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

/**
 * The ONE project whose pages are cross-origin isolated, which is what makes
 * `SharedArrayBuffer` exist at all. It carries the sync build's abort channel
 * and nothing else: the ordinary projects deliberately stay un-isolated,
 * because that is the configuration most consumers deploy and the degraded row
 * of the design has to be asserted somewhere.
 */
export default defineConfig({
  extends: withRslibConfig(),
  name: 'isolated',
  browser: {
    enabled: true,
    provider: 'playwright',
    browser: 'chromium',
    headless: true,
  },
  plugins: [pluginCrossOriginIsolation, pluginSilenceWorkerHmrLogs],
  include: ['tests/browser/isolated/**/*.test.ts'],
  testTimeout: 30000,
});
