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
  // `src` only. 
  source: {
    tsconfigPath: './tsconfig.build.json',
  },
  // rslib forces the build cache on, and its digest misses key-structure edits.
  performance: {
    buildCache: { buildDependencies: [import.meta.filename] },
  },
  lib: [
    // The client. rslib's esm preset disables `importMeta`, `importDynamic`,
    // `worker` and `url` parsing
    // - preserves `new URL('./worker/worker.js', import.meta.url)`
    {
      format: 'esm',
      syntax: 'esnext',
      dts: true,
      source: {
        entry: { index: './src/index.ts' },
      },
      output: {
        distPath: { root: './dist' },
        minify: true,
        sourceMap: { js: 'source-map' },
        // LICENSE and NOTICE travel with dist/
        copy: [
          { from: 'NOTICE', context: import.meta.dirname },
          { from: 'LICENSE', context: import.meta.dirname },
        ],
      },
    },
    // The worker. Opposite goal: absorb wa-sqlite entirely so the published
    // artifact has zero bare specifiers and runs without a bundler.
    //   autoExternal: false  — bundle wa-sqlite instead of externalising it
    //   importDynamic: true  — pull the 5 VFS and 3 Emscripten glues in
    //   asyncChunks: false   — one self-contained file, no chunk graph for a
    //                          consumer's bundler to re-resolve
    //   url: false           — keep the glue's `new URL('wa-sqlite.wasm', …)`
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
        minify: true,
        sourceMap: { js: 'source-map' },
        // Keep the banner IN the file.
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
              // Keeps the banner on top after minification, before the map is written.
              stage: rspack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE + 1,
            }),
          ],
        },
      },
    },
  ],
});
