import { defineConfig } from 'vite';

export default defineConfig({
  // Vite 6 and 7 pre-bundle dependencies with esbuild in dev, which rewrites
  // `import.meta.url` to the pre-bundled copy under node_modules/.vite/deps/.
  // browser-sqlite locates its worker relative to its own module URL, so the
  // rewrite sends it to a path Vite never populates. Excluding the package
  // from pre-bundling keeps the URL pointing at the real file.
  //
  // Measured 2026-08-27: without this, the dev server fails on 6.4.3 and
  // 7.3.6 and passes on 8.2.2 — Vite 8 fixed it. Kept unconditionally because
  // it is harmless on 8 and this fixture must match what the README tells a
  // consumer to write.
  optimizeDeps: { exclude: ['browser-sqlite'] },
});
