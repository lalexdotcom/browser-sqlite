import { defineConfig, rspack } from '@rslib/core';

// Bundled into dist/worker/worker.js and shipped beside it as .wasm. wa-sqlite
// is MIT, which requires its notice to travel with every copy — and a built
// artifact is routinely separated from its package (copied to a CDN, vendored
// into another app's bundle), so the banner has to live in the file itself.
// Full texts are in NOTICE, which is copied into dist/ below.
const WORKER_BANNER = `/*!
 * browser-sqlite worker bundle — MIT
 *
 * Bundles wa-sqlite (https://github.com/rhashimoto/wa-sqlite)
 *   Copyright (c) 2023 Roy T. Hashimoto — MIT License
 * Loads WebAssembly builds of SQLite (https://sqlite.org) — public domain
 *
 * Full third-party notices: see NOTICE, distributed alongside this file.
 */`;

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
        copy: [{ from: 'NOTICE', context: import.meta.dirname }],
      },
    },
    // The worker. Opposite goal: absorb wa-sqlite entirely so the published
    // artifact has zero bare specifiers and runs without a bundler.
    //   autoExternal: false  — bundle wa-sqlite instead of externalising it
    //   importDynamic: true  — pull the 5 VFS and 3 Emscripten glues in
    //   asyncChunks: false   — one self-contained file, no chunk graph for a
    //                          consumer's bundler to re-resolve
    //
    // `url: false` is the load-bearing one, and it is deliberately NOT `true`.
    // With `true`, rspack emits the .wasm itself but rewrites the Emscripten
    // glue's reference to `__webpack_require__.p + "..."` and anchors it with
    // `__webpack_require__.b = new URL("./", import.meta.url)`. Neither rollup
    // nor a consumer's own rspack can follow that: Vite then copies the worker
    // without its .wasm, and consumer rspack fails outright trying to resolve
    // `"./"`. With `false` the glue keeps a literal
    // `new URL("wa-sqlite.wasm", import.meta.url)` — portable, statically
    // analysable, and resolvable by a bare browser — so we copy the three .wasm
    // beside worker.js ourselves. Measured 2026-08-17: this drops
    // `__webpack_require__.b` from 4 occurrences to 0 and makes both rsbuild
    // consumer modes pass with no consumer configuration at all.
    {
      format: 'esm',
      syntax: 'esnext',
      dts: false,
      autoExternal: false,
      source: {
        entry: { worker: './src/worker/worker.ts' },
      },
      output: {
        distPath: { root: './dist/worker' },
        // Keep the banner IN the file. The default ('linked') extracts it to a
        // sibling .LICENSE.txt and leaves a pointer — but the whole reason the
        // banner exists is to survive the artifact being separated from its
        // neighbours, so a pointer to a file that may not travel is no use.
        legalComments: 'inline',
        // Flat, beside worker.js: the glue's literal is the bare filename
        // `wa-sqlite.wasm`, resolved against worker.js's own URL.
        copy: [
          {
            from: 'node_modules/wa-sqlite/dist/*.wasm',
            to: '[name][ext]',
            context: import.meta.dirname,
          },
        ],
      },
      tools: {
        rspack: {
          module: {
            parser: {
              javascript: {
                importDynamic: true,
                url: false,
              },
            },
          },
          output: {
            asyncChunks: false,
          },
          plugins: [
            new rspack.BannerPlugin({
              banner: WORKER_BANNER,
              raw: true,
              entryOnly: true,
            }),
          ],
        },
      },
    },
  ],
});
