import { defineConfig } from '@rslib/core';

export default defineConfig({
  // Declarations are generated from tsconfig.build.json, which is scoped to
  // `src` only. The root tsconfig also includes `tests` and the config files at
  // the repo root, which would push the common source root up to the repo root:
  // declarations would land in dist/esm/src/ (while package.json points at
  // dist/esm/index.d.ts) and dist/esm/tests/ would ship inside the package.
  source: {
    tsconfigPath: './tsconfig.build.json',
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
  ],
});
