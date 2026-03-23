import { defineConfig } from '@rslib/core';

export default defineConfig({
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
