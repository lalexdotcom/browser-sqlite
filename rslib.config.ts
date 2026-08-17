import { defineConfig } from '@rslib/core';

export default defineConfig({
  // Declarations are generated from tsconfig.build.json, which is scoped to
  // `src` only. The root tsconfig also includes `tests` and the config files at
  // the repo root, which would push the common source root up to the repo root:
  // declarations would land in dist/src/ (while package.json points at
  // dist/index.d.ts) and dist/tests/ would ship inside the package.
  source: {
    tsconfigPath: './tsconfig.build.json',
  },
  // rslib forces rsbuild's persistent build cache on. Its digest tracks the
  // config's resolved values but not its key structure, so swapping which key
  // holds a value (distPath.assets -> distPath.wasm) silently reuses the old
  // output. Hashing this file catches every kind of edit; verified 2026-08-17.
  performance: {
    buildCache: { buildDependencies: [import.meta.filename] },
  },
  lib: [
    // The client. rslib's esm preset disables `importMeta`, `importDynamic`,
    // `worker` and `url` parsing — which is exactly right here: we WANT
    // `new URL('./worker/worker.js', import.meta.url)` to survive literally, so
    // the consumer's bundler and a bare browser both resolve it themselves,
    // with no publicPath runtime in between.
    {
      format: 'esm',
      syntax: 'esnext',
      dts: true,
      source: {
        entry: { index: './src/index.ts' },
      },
      output: {
        distPath: { root: './dist' },
      },
    },
    // The worker. Opposite goal: absorb wa-sqlite entirely so the published
    // artifact has zero bare specifiers and runs without a bundler.
    //   autoExternal: false  — bundle wa-sqlite instead of externalising it
    //   importDynamic: true  — pull the 5 VFS and 3 Emscripten glues in
    //   url: true            — emit the .wasm and rewrite the glue's
    //                          `new URL("wa-sqlite.wasm", import.meta.url)`
    //   asyncChunks: false   — one self-contained file, no chunk graph for a
    //                          consumer's bundler to re-resolve
    {
      format: 'esm',
      syntax: 'esnext',
      dts: false,
      autoExternal: false,
      source: {
        entry: { worker: './src/worker.ts' },
      },
      output: {
        // `wasm` is the key that governs these files: they are emitted by the
        // rule `test: /\.wasm$/, dependency: 'url', type: 'asset/resource'`.
        // Neither `assets` nor `webassemblyModuleFilename` has any effect.
        distPath: { root: './dist/worker', wasm: 'wa-sqlite' },
      },
      tools: {
        rspack: {
          module: {
            parser: {
              javascript: {
                importDynamic: true,
                url: true,
              },
            },
          },
          output: {
            asyncChunks: false,
          },
        },
      },
    },
  ],
});