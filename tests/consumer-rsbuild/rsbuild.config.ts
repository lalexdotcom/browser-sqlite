import { defineConfig } from '@rsbuild/core';

// browser-sqlite needs SharedArrayBuffer, which requires cross-origin
// isolation. A consuming app must serve these headers; the fixture does the
// same so the smoke test fails on packaging problems, not on a missing header.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: crossOriginIsolation },
  source: { entry: { index: './src/index.ts' } },
  html: { title: 'browser-sqlite consumer smoke test — rsbuild' },
});
