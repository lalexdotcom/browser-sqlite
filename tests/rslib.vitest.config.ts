import { defineConfig, type LibConfig } from '@rslib/core';
import base from '../rslib.config.ts';

// The published build, unchanged, emitted into tests/build/ instead of dist/,
// plus one test-only entry (tests/harness/testing.ts) beside index.js so that its
// `new URL('./worker/worker.js', import.meta.url)` reaches the worker built
// here. The testing entry is its own `lib` item: inside the index item, rspack
// could factor shared code into a chunk and change index.js.
const OUT = './tests/build';

const relocate = (lib: LibConfig): LibConfig => {
  const distPath = lib.output?.distPath;
  const root =
    (typeof distPath === 'string' ? distPath : distPath?.root) ?? './dist';
  const moved = root.replace(/^\.\/dist/, OUT);
  return {
    ...lib,
    output: {
      ...lib.output,
      distPath:
        typeof distPath === 'object' ? { ...distPath, root: moved } : moved,
    },
  };
};

const [index, ...others] = base.lib.map(relocate);
if (!index) throw new Error('rslib.config.ts declares no lib');
const { copy: _notCopied, ...indexOutput } = index.output ?? {};

export default defineConfig({
  ...base,
  performance: {
    ...base.performance,
    buildCache: {
      // Its own cache: rslib forces the persistent cache on, and two configs
      // sharing one directory have served a stale output before.
      cacheDirectory: './node_modules/.cache/rspack-test',
      buildDependencies: [import.meta.filename, './rslib.config.ts'],
    },
  },
  lib: [
    index,
    ...others,
    {
      ...index,
      dts: false,
      source: {
        ...index.source,
        entry: { testing: './tests/harness/testing.ts' },
      },
      output: indexOutput,
    },
  ],
});
