import { cp } from 'node:fs/promises';
import { defineConfig } from 'vite';

export default defineConfig({
  // Vite pre-bundles dependencies with esbuild in dev, which rewrites
  // `import.meta.url` to the pre-bundled copy under node_modules/.vite/deps/.
  // browser-sqlite locates its worker relative to its own module URL, so the
  // rewrite sends it to a path Vite never populates. Excluding the package
  // from pre-bundling keeps the URL pointing at the real file.
  optimizeDeps: { exclude: ['browser-sqlite'] },

  plugins: [
    {
      // In a production build Vite copies the worker into the output but does
      // not follow the `new URL('wa-sqlite.wasm', import.meta.url)` references
      // inside it — files under node_modules are not re-transformed. The .wasm
      // must therefore be placed beside the emitted worker by hand.
      name: 'copy-browser-sqlite-wasm',
      apply: 'build',
      async closeBundle() {
        await cp('node_modules/browser-sqlite/dist/worker', 'dist/assets', {
          recursive: true,
        });
      },
    },
  ],
});
