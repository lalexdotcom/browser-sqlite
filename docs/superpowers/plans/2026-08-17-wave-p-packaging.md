# Wave P — Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the published `browser-sqlite` tarball installable and runnable, both through a bundler and without one.

**Architecture:** Build `src/worker.ts` as a second, self-contained rslib entry with wa-sqlite bundled into it and its `.wasm` emitted as relative assets, while `src/index.ts` keeps rslib's library defaults so its `new URL('./worker/worker.js', import.meta.url)` survives literally. Flatten `dist/esm/` to `dist/`. Prove it with a four-mode consumer smoke test that only ever touches the packed tarball.

**Tech Stack:** rslib 0.23.2 (rspack 2.1.10, rsbuild 2.1.13), TypeScript 7.0.2, biome 2.5.8, rstest 0.11.8, Playwright 1.62.1, pnpm 10.31.0, Node 24.13.

**Spec:** `docs/superpowers/specs/2026-08-17-wave-p-packaging-design.md` — read it before starting. This plan argues from it and does not repeat its rationale.

## Global Constraints

- **No runtime behaviour change.** B1, B2, B3, B9 stay open. The 105 existing tests must stay green, and **both `it.fails` must keep failing**: B1 in `tests/browser/transaction.test.ts`, B9 in `tests/browser/concurrency.test.ts`. If either starts passing, something was changed that should not have been.
- **Zero bare specifiers in the published bundle.** A specifier is bare unless it starts with `.`, `/`, or a URL scheme.
- **Zero runtime dependencies** when the wave ends: `dependencies` in `package.json` must be `{}` or absent.
- ESM only, `type: module`. There is no CJS output and none is to be added.
- Cross-origin isolation (COOP/COEP) stays a hard requirement on the consuming page. Do **not** attempt to remove the `SharedArrayBuffer` — that is D2, wave 4.
- Do **not** add a `wasmUrl` option or any other public API.
- Serena's symbolic tools are primary for code files (`get_symbols_overview`, `find_symbol`, `replace_symbol_body`, `replace_content`). Built-in Read/Edit are for `.md`, JSON, YAML and config only.
- Run `pnpm check` (biome, autofix) after every modification.
- Chat in French; code, comments, commit messages and docs in English.
- **Build-cache gotcha:** rslib caches aggressively. After any change to `rslib.config.ts`, rebuild with `rm -rf dist node_modules/.cache && pnpm build`, otherwise you will inspect a stale tree and draw the wrong conclusion. This cost one wrong diagnosis during the design probe.
- Work happens on branch `feat/wave-p-packaging`. The phase closes only when CI is green, memories are updated, and git is clean.

---

### Task 1: Static bare-specifier assertion in the smoke test

Adds the cheapest possible detector of the core defect. It proves nothing the browser modes do not, but when a mode breaks it says *why* in one line instead of a Playwright timeout.

**Files:**
- Modify: `scripts/consumer-smoke.mjs` (add a stage after the "build the library" stage)

**Interfaces:**
- Consumes: nothing.
- Produces: `assertNoBareSpecifiers(distDir)` — walks `distDir` recursively, returns `string[]` of `"<relative file>: <specifier>"` for every bare specifier found. Empty array means clean. Task 4 and Task 5 rely on it turning green.

- [ ] **Step 1: Write the assertion and its stage**

Add near the other helpers in `scripts/consumer-smoke.mjs` (it already imports `readdirSync`; add `readFileSync` and `statSync` to the `node:fs` import, and `relative` to the `node:path` import):

```js
/**
 * A published ESM bundle must resolve without an import map. Anything that is
 * not relative, root-absolute or a URL is unresolvable in a bare browser and
 * pushes a dependency into the consumer's lockfile.
 */
function assertNoBareSpecifiers(distDir) {
  const offenders = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        const source = readFileSync(full, 'utf8');
        for (const pattern of patterns) {
          for (const [, specifier] of source.matchAll(pattern)) {
            const isRelative = specifier.startsWith('.');
            const isAbsolute = specifier.startsWith('/');
            const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(specifier);
            if (!isRelative && !isAbsolute && !isUrl) {
              offenders.push(`${relative(distDir, full)}: ${specifier}`);
            }
          }
        }
      }
    }
  };

  walk(distDir);
  return offenders;
}
```

- [ ] **Step 2: Wire it as a stage**

Insert immediately after the `stage('build the library')` block, before `pack the tarball`:

```js
  {
    const s = stage('no bare specifiers in dist/');
    const offenders = assertNoBareSpecifiers(join(ROOT, 'dist'));
    if (offenders.length === 0) {
      s.pass('every specifier is relative, absolute or a URL');
    } else {
      s.fail(offenders.join('\n    '));
    }
  }
```

Note it does **not** `throw`: a bare specifier is diagnostic, and the browser modes should still run so their failure is recorded too.

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm test:consumer`
Expected: the new stage reports `FAIL  no bare specifiers in dist/` listing at least `index.js: @lalex/promises`. The two Vite modes still fail as they do today. This is the red state the wave exists to clear.

- [ ] **Step 4: Commit**

```bash
git add scripts/consumer-smoke.mjs
git commit -m "test(consumer): assert dist/ contains no bare specifiers"
```

---

### Task 2: Bundler-free consumer mode

The strongest of the four modes: served statically from the installed tarball, nothing can paper over a bare specifier.

**Files:**
- Create: `tests/consumer-nobundler/index.html`
- Create: `scripts/static-server.mjs`
- Modify: `scripts/consumer-smoke.mjs`

**Interfaces:**
- Consumes: `stage()`, `driveBrowser(url)`, `waitForServer(url)` from `scripts/consumer-smoke.mjs`; the `window.__SMOKE__` contract `{ ok: boolean, detail: string }`.
- Produces: `scripts/static-server.mjs`, a CLI taking `<rootDir> <port>` and serving it with COOP/COEP headers. Task 3 does not use it; it exists for this mode only.

- [ ] **Step 1: Write the static server**

Create `scripts/static-server.mjs`:

```js
#!/usr/bin/env node
/**
 * Minimal static file server with cross-origin isolation headers, for the
 * bundler-free consumer mode. No dependency, no transform, no resolution:
 * whatever the tarball shipped is what the browser gets.
 *
 * Usage: node scripts/static-server.mjs <rootDir> <port>
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const [, , rootDir, portArg] = process.argv;
if (!rootDir || !portArg) {
  process.stderr.write('usage: static-server.mjs <rootDir> <port>\n');
  process.exit(2);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

createServer((req, res) => {
  // Cross-origin isolation, exactly as a real consuming app must serve it.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  const filePath = join(rootDir, relative);

  try {
    if (!statSync(filePath).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(filePath)] ?? 'application/octet-stream',
  });
  createReadStream(filePath).pipe(res);
}).listen(Number(portArg), '127.0.0.1');
```

- [ ] **Step 2: Write the fixture**

Create `tests/consumer-nobundler/index.html`. The logic duplicates `tests/consumer/src/main.ts` on purpose: each fixture must be readable and runnable on its own, and this one must contain **no TypeScript and no build step**. Do not factor the two together.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>browser-sqlite consumer smoke test — no bundler</title>
  </head>
  <body>
    <pre id="out">running…</pre>
    <script type="module">
      // No bundler, no import map: a path, resolved by the browser alone.
      import { createSQLiteClient } from '/node_modules/browser-sqlite/dist/index.js';

      async function run() {
        if (!crossOriginIsolated) {
          throw new Error(
            'crossOriginIsolated is false — COOP/COEP headers are missing, SharedArrayBuffer is unavailable',
          );
        }

        const db = createSQLiteClient(`consumer-smoke-${crypto.randomUUID()}`);

        await db.write('CREATE TABLE smoke (id INTEGER PRIMARY KEY, label TEXT)');
        await db.write(
          "INSERT INTO smoke (id, label) VALUES (1, 'alpha'), (2, 'beta')",
        );

        const rows = await db.read(
          'SELECT id, label FROM smoke ORDER BY id',
        );

        db.close();

        if (rows.length !== 2 || rows[1].label !== 'beta') {
          throw new Error(`unexpected rows: ${JSON.stringify(rows)}`);
        }

        return `read back ${rows.length} rows`;
      }

      const out = document.getElementById('out');

      run().then(
        (detail) => {
          window.__SMOKE__ = { ok: true, detail };
          out.textContent = `OK — ${detail}`;
        },
        (error) => {
          const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
          window.__SMOKE__ = { ok: false, detail };
          out.textContent = `FAILED — ${detail}`;
        },
      );
    </script>
  </body>
</html>
```

- [ ] **Step 3: Wire the mode into the smoke script**

In `scripts/consumer-smoke.mjs`, add a port constant beside the existing two:

```js
const NOBUNDLER_PORT = 5197;
```

In the `scaffold and install the consumer app` stage, after the existing `cpSync`, also copy the new fixture into the same temp app so it shares the installed `node_modules`:

```js
      cpSync(join(ROOT, 'tests', 'consumer-nobundler'), join(appDir, 'nobundler'), {
        recursive: true,
      });
```

Then, after the Vite preview mode, add:

```js
  await checkMode(
    'No bundler (static server)',
    [
      'node',
      join(ROOT, 'scripts', 'static-server.mjs'),
      appDir,
      String(NOBUNDLER_PORT),
    ],
    `http://${HOST}:${NOBUNDLER_PORT}/nobundler/index.html`,
    appDir,
  );
```

`startServer` spawns through `npx`; change its first line so a plain command is honoured:

```js
function startServer(args, cwd) {
  const [cmd, ...rest] = args[0] === 'node' ? args : ['npx', ...args];
  const child = spawn(cmd, rest, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `pnpm test:consumer`
Expected: `FAIL  No bundler (static server)`, with a `requestfailed` or 404 on `/node_modules/browser-sqlite/dist/esm/worker.ts`, plus the console error from the unresolvable `@lalex/promises` import. Both prove the mode is wired and genuinely exercising the tarball.

- [ ] **Step 5: Commit**

```bash
git add scripts/static-server.mjs scripts/consumer-smoke.mjs tests/consumer-nobundler
git commit -m "test(consumer): add a bundler-free consumption mode"
```

---

### Task 3: rsbuild consumer mode

**Files:**
- Create: `tests/consumer-rsbuild/package.json`
- Create: `tests/consumer-rsbuild/rsbuild.config.ts`
- Create: `tests/consumer-rsbuild/src/index.ts`
- Modify: `scripts/consumer-smoke.mjs`

**Interfaces:**
- Consumes: `stage()`, `checkMode()`, `run()` from `scripts/consumer-smoke.mjs`.
- Produces: a second temp app directory, `rsbuildAppDir`, installed independently of the Vite one.

- [ ] **Step 1: Write the fixture**

`tests/consumer-rsbuild/package.json`:

```json
{
  "name": "browser-sqlite-consumer-smoke-rsbuild",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "rsbuild build",
    "preview": "rsbuild preview"
  },
  "devDependencies": {
    "@rsbuild/core": "^2.1.13"
  }
}
```

`tests/consumer-rsbuild/rsbuild.config.ts` — no `resolve.alias`, no `source.include`: nothing may resolve back to the repo.

```ts
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
```

`tests/consumer-rsbuild/src/index.ts` — same body as the Vite fixture, deliberately duplicated so each fixture stands alone:

```ts
// Deliberately imports by bare specifier: this exercises the published
// package's `exports` map, not the repo sources.
import { createSQLiteClient } from 'browser-sqlite';

declare global {
  interface Window {
    __SMOKE__?: { ok: boolean; detail: string };
  }
}

async function run(): Promise<string> {
  if (!crossOriginIsolated) {
    throw new Error(
      'crossOriginIsolated is false — COOP/COEP headers are missing, SharedArrayBuffer is unavailable',
    );
  }

  const db = createSQLiteClient(`consumer-smoke-${crypto.randomUUID()}`);

  await db.write('CREATE TABLE smoke (id INTEGER PRIMARY KEY, label TEXT)');
  await db.write(
    "INSERT INTO smoke (id, label) VALUES (1, 'alpha'), (2, 'beta')",
  );

  const rows = await db.read<{ id: number; label: string }>(
    'SELECT id, label FROM smoke ORDER BY id',
  );

  db.close();

  if (rows.length !== 2 || rows[1].label !== 'beta') {
    throw new Error(`unexpected rows: ${JSON.stringify(rows)}`);
  }

  return `read back ${rows.length} rows`;
}

run().then(
  (detail) => {
    window.__SMOKE__ = { ok: true, detail };
  },
  (error: unknown) => {
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    window.__SMOKE__ = { ok: false, detail };
  },
);
```

- [ ] **Step 2: Wire the mode into the smoke script**

Add the port constant:

```js
const RSBUILD_PORT = 5196;
```

Add `const rsbuildAppDir = join(tmp, 'app-rsbuild');` beside the existing `appDir`, then a scaffold stage after the Vite one:

```js
  {
    const s = stage('scaffold and install the rsbuild consumer app');
    try {
      cpSync(join(ROOT, 'tests', 'consumer-rsbuild'), rsbuildAppDir, {
        recursive: true,
      });
      run('npm', ['install', '--no-audit', '--no-fund'], rsbuildAppDir);
      run('npm', ['install', '--no-audit', '--no-fund', tarball], rsbuildAppDir);
      s.pass(rsbuildAppDir);
    } catch (error) {
      s.fail(errText(error));
      throw error;
    }
  }
```

And after it, the build + preview pair:

```js
  let rsbuildBuilt = false;
  {
    const s = stage('rsbuild build');
    try {
      run('npx', ['rsbuild', 'build'], rsbuildAppDir);
      rsbuildBuilt = true;
      s.pass('production bundle emitted');
    } catch (error) {
      s.fail(errText(error));
    }
  }

  if (rsbuildBuilt) {
    await checkMode(
      'rsbuild preview (production bundle)',
      ['rsbuild', 'preview', '--port', String(RSBUILD_PORT)],
      `http://${HOST}:${RSBUILD_PORT}/`,
      rsbuildAppDir,
    );
  } else {
    results.push({
      name: 'rsbuild preview (production bundle)',
      ok: false,
      detail: 'skipped — rsbuild build failed',
    });
  }
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm test:consumer`
Expected: `FAIL  rsbuild build` — rspack cannot resolve `dist/esm/worker.ts`, the same defect Vite reports. Six stages now report, four of them failing.

- [ ] **Step 4: Commit**

```bash
git add scripts/consumer-smoke.mjs tests/consumer-rsbuild
git commit -m "test(consumer): add an rsbuild consumption mode"
```

---

### Task 4: Two build entries, flat `dist/`

The build change. Config verified by a throwaway probe on 2026-08-17 — the values below are known to produce the tree asserted in Step 3, not guessed.

**Files:**
- Modify: `rslib.config.ts` (whole file)
- Modify: `package.json` (`exports`, `types`)

**Interfaces:**
- Consumes: nothing.
- Produces: `dist/index.js`, `dist/index.d.ts` (+ sibling declarations), `dist/worker/worker.js`, `dist/worker/wa-sqlite/*.module.wasm`. Task 5 relies on `dist/worker/worker.js` being that exact path, and on `exports["./worker"]`.

- [ ] **Step 1: Rewrite `rslib.config.ts`**

```ts
import { defineConfig } from '@rslib/core';

export default defineConfig({
  // Declarations are generated from tsconfig.build.json, which is scoped to
  // `src` only. The root tsconfig also includes `tests` and the config files at
  // the repo root, which would push the common source root up to the repo root:
  // declarations would land in dist/src/ (while package.json points at
  // dist/index.d.ts) and dist/tests/ would ship inside the package.
  source: {
    tsconfigPath: './tsconfig.build.json',
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
      },
    },
    // The worker. Opposite goal: absorb wa-sqlite entirely so the published
    // artifact has zero bare specifiers and runs without a bundler.
    //   autoExternal: false  — bundle wa-sqlite instead of externalising it
    //   importDynamic: true  — pull the 5 VFS and 3 Emscripten glues in
    //   url: true            — emit the .wasm and rewrite the glue's
    //                          `new URL("wa-sqlite.wasm", import.meta.url)`
    //   asyncChunks: false   — one self-contained file, no chunk graph for a
    //                          consumer's bundler to re-resolve
    {
      format: 'esm',
      syntax: 'esnext',
      dts: false,
      autoExternal: false,
      source: {
        entry: { worker: './src/worker.ts' },
      },
      output: {
        // `wasm` is the key that governs these files: they are emitted by the
        // rule `test: /\.wasm$/, dependency: 'url', type: 'asset/resource'`.
        // Neither `assets` nor `webassemblyModuleFilename` has any effect.
        distPath: { root: './dist/worker', wasm: 'wa-sqlite' },
      },
      tools: {
        rspack: {
          module: {
            parser: {
              javascript: {
                importDynamic: true,
                url: true,
              },
            },
          },
          output: {
            asyncChunks: false,
          },
        },
      },
    },
  ],
});
```

- [ ] **Step 2: Update the published paths in `package.json`**

Replace the `exports` and `types` blocks:

```json
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js",
			"default": "./dist/index.js"
		},
		"./worker": "./dist/worker/worker.js",
		"./dist/*": "./dist/*"
	},
	"types": "./dist/index.d.ts",
```

`files` stays `["dist"]`.

- [ ] **Step 3: Build clean and assert the tree**

Run:

```bash
rm -rf dist node_modules/.cache && pnpm build && find dist -type f | sort
```

Expected, exactly (the three hashes will differ, the shape must not):

```
dist/client.d.ts
dist/debug.d.ts
dist/index.d.ts
dist/index.js
dist/orchestrator.d.ts
dist/types.d.ts
dist/utils.d.ts
dist/worker.d.ts
dist/worker/wa-sqlite/<hash>.module.wasm
dist/worker/wa-sqlite/<hash>.module.wasm
dist/worker/wa-sqlite/<hash>.module.wasm
dist/worker/worker.js
```

Then confirm the worker absorbed wa-sqlite and resolves its assets relatively:

```bash
grep -c "wa-sqlite/" dist/worker/worker.js          # expect 3 or more
grep -o "__webpack_require__\.b = [^;]*" dist/worker/worker.js
```

Expected from the second: `__webpack_require__.b = new URL("./", import.meta.url)`.

- [ ] **Step 4: Confirm the assertion moved but did not clear**

Run: `pnpm test:consumer`
Expected: `no bare specifiers in dist/` still FAILS, now listing only `index.js: @lalex/promises` — the `wa-sqlite/…` specifiers are gone. All four browser modes still fail: `index.js` still points at `./worker.ts`. That is Task 5's job.

- [ ] **Step 5: Verify nothing else regressed and commit**

```bash
pnpm check && pnpm exec tsc --noEmit && pnpm test
```

Expected: biome clean, tsc clean, 105/105.

```bash
git add rslib.config.ts package.json
git commit -m "build: emit a self-contained worker entry, flatten dist/"
```

---

### Task 5: Point the client at the built worker, drop both runtime dependencies

The task that turns every mode green.

**Files:**
- Modify: `src/client.ts` (worker construction, `defer` import and its uses)
- Modify: `package.json` (`dependencies`, `devDependencies`, `files`)
- Create: `NOTICE`

**Interfaces:**
- Consumes: `dist/worker/worker.js` from Task 4.
- Produces: nothing later tasks depend on beyond a green smoke run.

- [ ] **Step 1: Repoint the worker URL and make it a module worker**

With Serena (`find_symbol` on `createSQLiteClient/createWorker`, then `replace_content`), change the `new Worker(...)` call at `src/client.ts:332`:

```ts
        new Worker(
          /* webpackChunkName: "browser-sqlite" */ new URL(
            './worker/worker.js',
            import.meta.url,
          ),
          {
            name: workerName,
            type: 'module',
          },
        ) as PoolWorker,
```

`type: 'module'` is not optional: `worker/worker.js` is an ESM module, and a classic worker cannot execute one. Its absence was invisible until now because the browser suite runs rsbuild over `src/` and never touches `dist/`.

- [ ] **Step 2: Replace `defer()` with the native equivalent**

Delete the import at `src/client.ts:1` (`import { defer } from '@lalex/promises';`). Find every call site with `find_referencing_symbols` or a project grep for `defer<`, and replace each `defer<T>()` with `Promise.withResolvers<T>()`.

The shapes are compatible in name — both yield `{ promise, resolve, reject }` — so call sites need no further change. Verify with `tsc`, not by eye.

- [ ] **Step 3: Update the manifest**

In `package.json`: delete the `dependencies` block entirely, and add `wa-sqlite` to `devDependencies` keeping the exact same specifier:

```json
		"wa-sqlite": "github:rhashimoto/wa-sqlite#v1.1.2",
```

Add `NOTICE` to `files`:

```json
	"files": [
		"dist",
		"NOTICE"
	],
```

Then run `pnpm install` so the lockfile records the move.

- [ ] **Step 4: Write `NOTICE`**

Create `NOTICE` at the repo root:

```
browser-sqlite bundles third-party code into its published worker artifact.

wa-sqlite (https://github.com/rhashimoto/wa-sqlite)
  Copyright (c) 2024 Roy T. Hashimoto
  Licensed under the MIT License. The full text ships with the wa-sqlite
  source and is reproduced at https://github.com/rhashimoto/wa-sqlite/blob/master/LICENSE

SQLite (https://sqlite.org)
  Public domain. The authors disclaim copyright to the source code.

The compiled WebAssembly artifacts under dist/worker/wa-sqlite/ are builds of
SQLite produced by wa-sqlite and are covered by the notices above.
```

- [ ] **Step 5: Run the full verification**

```bash
pnpm check && pnpm exec tsc --noEmit && rm -rf dist node_modules/.cache && pnpm build && pnpm test
```

Expected: biome clean, tsc clean, build emits the Task 4 tree, **105/105 tests** with both `it.fails` still failing.

- [ ] **Step 6: Run the smoke test and confirm every mode is green**

Run: `pnpm test:consumer`
Expected: all stages PASS, including `no bare specifiers in dist/` reporting an empty list, and all four browser modes reading back 2 rows.

If a mode fails here, that is the wave's real finding — the likeliest candidate is verification point 4 of the spec, Vite's dependency pre-bundling mangling the literal worker URL. Diagnose before working around: the fix belongs in what we publish, not in the fixture.

- [ ] **Step 7: Commit**

```bash
git add src/client.ts package.json pnpm-lock.yaml NOTICE
git commit -m "fix(packaging): load the built worker as a module, drop both runtime deps"
```

---

### Task 6: Make the consumer smoke test a blocking CI gate

**Files:**
- Modify: `.github/workflows/ci.yaml`

**Interfaces:**
- Consumes: a green `pnpm test:consumer` from Task 5.
- Produces: nothing.

- [ ] **Step 1: Remove the escape hatch**

In `.github/workflows/ci.yaml`, delete the `continue-on-error: true` line from the `consumer-smoke` job. Leave everything else — the Chromium cache keyed on `pnpm-lock.yaml`, the `concurrency` block — untouched.

- [ ] **Step 2: Confirm the job still describes reality**

Read the job's steps and check it installs Playwright's Chromium and runs `pnpm test:consumer`. The job now also builds two consumer apps with `npm install`, which is slower; if it declares a `timeout-minutes` below 20, raise it to 20.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci: make the consumer smoke test blocking"
```

---

### Task 7: Attempt the chunked worker

Phase 2 of the spec. Purely an optimisation attempt with a hard revert rule.

**Files:**
- Modify: `rslib.config.ts` (one line, possibly reverted)

**Interfaces:**
- Consumes: everything above, green.
- Produces: either a chunked worker or an unchanged monolithic one plus a recorded reason.

- [ ] **Step 1: Measure the monolithic baseline**

```bash
rm -rf dist node_modules/.cache && pnpm build
gzip -c dist/worker/worker.js | wc -c
```

Record the number. The design probe measured 696 KB raw / 115 KB gzip.

- [ ] **Step 2: Switch to chunks**

In `rslib.config.ts`, change the worker entry's `asyncChunks: false` to `asyncChunks: true`, then:

```bash
rm -rf dist node_modules/.cache && pnpm build && find dist -type f | sort
gzip -c dist/worker/worker.js | wc -c
```

- [ ] **Step 3: Re-run all four modes**

Run: `pnpm test:consumer`

- [ ] **Step 4: Decide by the rule, not by preference**

If **all** stages pass, keep `asyncChunks: true` and commit:

```bash
git add rslib.config.ts
git commit -m "perf(packaging): split the worker's Emscripten glue into async chunks"
```

If **any** stage fails, revert to `asyncChunks: false`, rebuild, confirm green again, and record which mode broke and how in `mem:follow-ups` under a new `W-chunks` entry. Do not attempt to make the chunked build work — that is a separate decision, not this wave's.

---

### Task 8: Close the phase

The phase is not done until this task is.

**Files:**
- Modify: `.serena/memories/project-state.md`
- Modify: `.serena/memories/resume-plan.md`
- Modify: `.serena/memories/follow-ups.md`

- [ ] **Step 1: Update `mem:follow-ups`**

Set B10 and B8 to `done`, each with a one-line statement of what closed it and the evidence (four smoke modes green, `dependencies` empty). Remove the "Worker resolution is an unverified bundler assumption" cleanup line if still present, and the `defer()` cleanup line — both are now closed. If Task 7 reverted, add the `W-chunks` entry.

- [ ] **Step 2: Update `mem:project-state`**

Correct the layout section: build output is `dist/`, not `dist/esm`; two rslib entries, not one; runtime dependencies are none. Record the rslib parser facts (the four disabled behaviours and the `distPath.wasm` key) — they are not re-derivable without reading rslib's compiled source. Update the CI section: `consumer-smoke` is blocking, and the suite has four consumer modes.

- [ ] **Step 3: Update `mem:resume-plan`**

Mark wave P done in §2's table with the date. Add a §4 changelog entry covering what shipped, what Task 7 decided, and any surprise. Point §0 at wave 1 as the next thing.

- [ ] **Step 4: Verify the closure conditions**

```bash
pnpm check && pnpm exec tsc --noEmit && pnpm build && pnpm test && pnpm test:consumer && git status --short
```

All must pass; `git status --short` must print nothing after the commit below.

- [ ] **Step 5: Commit**

```bash
git add .serena/memories
git commit -m "docs(memory): close wave P — B10 and B8 done"
```

---

## Self-Review

**Spec coverage.** §1 goal → Tasks 4-5. §2 non-goals → Global Constraints. P1/P2 (three variants, relative resolution) → Task 4, no `wasmUrl` anywhere. P3 (drop `@lalex/promises`) → Task 5 Step 2. P4 (two entries) → Task 4 Step 1. P5 (monolithic then chunks) → Task 4 (`asyncChunks: false`) and Task 7. P6 (flat `dist/`) → Task 4. P7 (four modes, rsbuild not rspack) → Tasks 1-3. §5 `NOTICE` → Task 5 Step 4. §5 npm-squat note → Global Constraints keeps the `github:` specifier explicitly. §6 isolation rule → Tasks 2-3 reuse the temp-dir + `npm install` scaffold. §6 CI blocking → Task 6. §8 verification points 1-3 → settled by the probe, embedded in Task 4's config with comments. §8 point 4 (Vite pre-bundling) → Task 5 Step 6, with instruction to fix the artifact rather than the fixture.

**Placeholders.** None: every code step carries the code, every run step carries the command and the expected output.

**Type consistency.** `assertNoBareSpecifiers(distDir) → string[]` is defined in Task 1 and referenced by name in Tasks 4-5. `window.__SMOKE__` is `{ ok: boolean, detail: string }` in all three fixtures and in the existing `driveBrowser`. Port constants `DEV_PORT` 5199, `PREVIEW_PORT` 5198, `NOBUNDLER_PORT` 5197, `RSBUILD_PORT` 5196 do not collide. `dist/worker/worker.js` is spelled identically in Task 4's output, Task 5's `new URL`, and `package.json`'s `exports["./worker"]`.
