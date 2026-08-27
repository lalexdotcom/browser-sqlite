import { defineConfig } from 'vite';

export default defineConfig({
  // The whole point of this fixture. `tests/consumer` resolves to the newest
  // Vite, where this line is a no-op, so it proved nothing about the one piece
  // of configuration the README asks a consumer to write. Vite 6.1 to 7
  // pre-bundle dependencies with esbuild in dev, which rewrites the worker's
  // `import.meta.url` to a path under node_modules/.vite/deps/ that Vite never
  // populates. Measured 2026-08-27: remove this line and the dev server fails
  // here while `vite build` keeps passing.
  optimizeDeps: { exclude: ['browser-sqlite'] },
});
