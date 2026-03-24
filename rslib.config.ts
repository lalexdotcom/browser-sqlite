import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill';
import { defineConfig, type LibConfig } from '@rslib/core';

// Injects COOP/COEP headers into the rstest browser dev server so that
// SharedArrayBuffer is available (cross-origin isolation requirement).
// These headers are ignored during library builds (no dev server).
const pluginCrossOriginIsolation = () =>
  ({
    name: 'rsbuild:cross-origin-isolation',
    setup(api: {
      modifyRsbuildConfig: Function;
      modifyEnvironmentConfig: Function;
    }) {
      // Add COOP/COEP headers to the dev server (rstest browser mode).
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
      // Fix: rstest replaces `process.env` with globalThis[Symbol.for("rstest.env")]
      // which is undefined at module init time. The `util` polyfill (used by
      // @lalex/console) accesses `process.env.NODE_DEBUG` at load time → crash.
      // Statically define it as undefined so Rspack resolves it before rstest's
      // broader `process.env` define applies.
      api.modifyEnvironmentConfig(
        (
          config: object,
          { mergeEnvironmentConfig }: { mergeEnvironmentConfig: Function },
        ) =>
          mergeEnvironmentConfig(config, {
            source: {
              define: {
                'process.env.NODE_DEBUG': 'undefined',
              },
            },
          }),
      );
    },
  }) as NonNullable<LibConfig['plugins']>[number];

export default defineConfig({
  plugins: [pluginNodePolyfill(), pluginCrossOriginIsolation()],
  tools: {
    rspack: {
      // @lalex/console uses `import.meta` directly (unsupported in CJS/UMD bundles).
      // These are harmless — the code paths are dead in browser contexts.
      ignoreWarnings: [/Critical dependency.*import\.meta/],
    },
  },
  lib: [
    {
      format: 'esm',
      syntax: 'esnext',
      dts: true,
      output: {
        distPath: './dist/esm',
      },
    },
    {
      format: 'cjs',
      syntax: 'es2015',
      dts: true,
      output: {
        distPath: './dist/cjs',
      },
    },
    {
      format: 'umd',
      syntax: 'es2015',
      dts: false,
      umdModuleName: 'wsqlite',
      output: {
        distPath: './dist/umd',
      },
    },
  ],
});
