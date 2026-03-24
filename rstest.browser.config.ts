import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';

export default defineConfig({
  extends: withRslibConfig(),
  browser: {
    enabled: true,
    provider: 'playwright',
    browser: 'chromium',
    headless: true,
  },
  // COOP/COEP requis pour SharedArrayBuffer (WorkerOrchestrator)
  // D-04 : headers injectés via Rsbuild server.headers
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  include: ['tests/browser/**/*.test.ts'],
  testTimeout: 30000,
});
