# Wave P — Packaging: make the built package consumable

Date: 2026-08-17
Status: approved, not yet implemented
Covers: B10, B8
Context: `mem:project-state`, `mem:follow-ups`, `mem:resume-plan` §2.1

## 1. Goal

The package as it stands today — defects included — must be consumable, both through a
bundler and without one.

This is not "make the library good". Wave P changes no runtime behaviour. After it, the
library may still hang when a worker crashes (B2), may still lose transaction exclusivity
(B1), may still ignore an already-aborted signal (B9). It must simply install and run.

### Why it does not work today

`dist/esm/index.js:73` ships this, verbatim:

```js
new Worker(new URL('./worker.ts', import.meta.url), { name: workerName })
```

`dist/esm/` contains `index.js` and the `.d.ts` files. There is no worker artifact, and
`files: ["dist"]` publishes no sources. The consumer's bundler recognises the pattern
correctly, treats `./worker.ts` as a worker entry point, and fails to resolve
`node_modules/browser-sqlite/dist/esm/worker.ts` because that file does not exist —
`vite build` errors out, and `vite dev` hangs forever instead, which is B2 demonstrated.

The bundler is doing its job. The reference points at a file that was never published.

### Why we do not simply publish `src/`

Shipping the TypeScript sources and letting the consumer's bundler compile `worker.ts`
would appear to fix the resolution failure. It is wrong on three counts:

- it forces a TypeScript toolchain on every consumer, including plain-JS projects;
- the single most critical artifact would be compiled by *their* tsconfig, not ours;
- it does not address B8 at all. `worker.ts` imports `wa-sqlite/src/…` and
  `wa-sqlite/dist/*.mjs` as bare specifiers, which the consumer would then have to
  resolve — putting `github:rhashimoto/wa-sqlite` into their lockfile. And the
  bundler-free mode stays impossible.

### The two requirements, and why they are one fix

- **With a bundler**: a real worker artifact must exist beside `index.js`, with the
  reference pointing at it.
- **Without a bundler**: the criterion is binary — the published bundle must contain
  **zero bare specifiers**. A browser cannot resolve `wa-sqlite/dist/wa-sqlite.mjs`
  without an import map, and we will not base bundler-free support on a third-party
  CDN's specifier rewriting.

Building `worker.ts` into the tarball with wa-sqlite bundled *into* it satisfies both at
once. wa-sqlite becomes a devDependency and leaves consumer lockfiles entirely.
**B10 and B8 are the same piece of work.**

## 2. Non-goals

Explicitly out of scope, and to be left untouched:

- B1, B2, B3, B9 and every other correctness item.
- Removing the `SharedArrayBuffer` (D2, wave 4). **Cross-origin isolation stays a hard
  requirement on the consuming page.** "Consumable" after wave P means "installs and runs
  in a cross-origin-isolated page", not "drop it in any page".
- A `wasmUrl` escape hatch. Wave P does not widen the public API.
- Any change to the runtime `vfs` option or to how a VFS is selected.

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| P1 | Ship all three WASM variants | The VFS is a runtime option, and the `.wasm` files are emitted as separate assets fetched on demand under **both** P5 outcomes — so a consumer downloads only the variant its VFS selects, and the cost of the other two is tarball weight alone (~2.4 MB raw), never network weight. (P5 governs the *glue*, not the `.wasm`.) Opt-in subpaths would force the VFS choice to build time — an API change, and out of scope. |
| P2 | Relative resolution only for the `.wasm`; no `wasmUrl` | The Emscripten glue already resolves its `.wasm` relative to the chunk containing it, and bundlers rewrite emitted-asset URLs to the configured base, so CDN re-hosting works unchanged. The only genuinely broken case is "no bundler + assets moved by hand". Adding `wasmUrl` later is non-breaking. |
| P3 | Drop `@lalex/promises` | One function used (`defer()`), and `Promise.withResolvers()` is native. Since we stop externalising dependencies for the worker, keeping it would mean inlining third-party code for nothing. Removing it brings the package to **zero runtime dependencies**, the intended end state. |
| P4 | Two explicit build entries, not `parser.javascript.worker: true` | See §4.2. |
| P5 | Monolithic `worker.js` first, chunks attempted afterwards | See §4.3 and §7. |
| P6 | Flat `dist/`, no `esm/` level | The package is `type: module`, ESM-only; there will never be a `dist/cjs/`. The directory carries no information. |
| P7 | Consumer smoke test covers four modes, using **rsbuild** rather than raw rspack | See §6. |

## 4. Build configuration

### 4.1 What rslib's `esm` preset does, and why it matters

rslib's `esm` format preset disables four parser behaviours unconditionally
(`node_modules/@rslib/core/dist/index.js:2880-2895`):

```js
esm:    { importMeta: false, importDynamic: false, commonjs: { exports: 'skipInEsm' } },
others: { worker: false }
```

and, through `modifyRsbuildDefaultPlugin({ disableUrlParse: true })` (`:2909`, body at
`:3110`), adds `parser({ url: false })` on the JS rule.

This is deliberate, and it is rslib's contract for a library: emit an artifact that the
consumer's bundler will *finish* processing, leaving `import.meta`, `import()`,
`new Worker(new URL())` and `new URL()` intact so they can be resolved in the consumer's
own context.

Wave P rejects that contract for the worker — the artifact must be self-contained — and
**keeps it for `index.js`**.

### 4.2 Two entries, not one re-enabled parser flag

rspack exposes `module.parser.javascript.worker` (*"Configure Worker parsing and URL
generation"*, `@rspack/core/dist/config/types.d.ts:1005`). Setting it to `true` would
make rspack compile `./worker.ts` and rewrite the reference — the obvious one-line fix.
It is rejected for two reasons:

1. **It only solves half of B10.** The worker would be compiled inside the same `esm`
   environment, so `importDynamic: false` and `url: false` still apply to it: the
   `wa-sqlite/…` specifiers stay bare inside the emitted worker. It would still fail
   without a bundler and still require wa-sqlite in the consumer's lockfile.
2. **It changes the nature of the URL.** When rspack owns the worker emission it does not
   leave a literal `new URL('./worker/worker.js', import.meta.url)`; it generates a
   publicPath-based reference resolved by the webpack runtime. In a library, `auto`
   publicPath resolution is a classic source of consumer-side breakage, and it means
   nothing at all in the bundler-free mode.

Two explicit entries keep a literal relative URL in `index.js` that the consumer's
bundler and a bare browser both understand, with no runtime in between. This is the same
reasoning that drives P5: minimise the resolution surface.

### 4.3 The configuration

Two `lib` entries in `rslib.config.ts`, opposite settings:

| | entry `index` | entry `worker` |
|---|---|---|
| source entry | `src/index.ts` | `src/worker.ts` |
| `output.distPath` | `./dist` | `./dist/worker` |
| `parser.javascript.worker` | `false` (rslib default — wanted) | `false` |
| `parser.javascript.url` | `false` (rslib default — wanted) | **`true`** |
| `parser.javascript.importDynamic` | `false` (rslib default) | **`true`** |
| `output.asyncChunks` | — | **`false`** |
| asset sub-directory | — | **`wa-sqlite`** (see verification point 3) |
| `dts` | `true` | `false` |

The asset sub-directory is set through rsbuild's `output.distPath` key that governs URL
assets, so the `.wasm` land in `dist/worker/wa-sqlite/` rather than at the worker root.
Which key that is — `assets` rather than `wasm` — is verification point 3.

rslib's defaults are *correct* for `index.js`: we want
`new URL('./worker/worker.js', import.meta.url)` to survive literally, with no publicPath
and no runtime indirection.

The overrides apply only to the worker entry, where the goal is the opposite — absorb
wa-sqlite:

- `importDynamic: true` pulls the five VFS modules and the three Emscripten glues into
  the bundle instead of leaving bare `import()` specifiers;
- `url: true` makes rspack emit the `.wasm` files as assets and rewrite the glue's
  `new URL("wa-sqlite.wasm", import.meta.url)` to a relative reference;
- `asyncChunks: false` inlines the dynamic imports into a single file.

`dts` stays on the `index` entry only; a `worker.d.ts` has no consumer.

### 4.4 Output layout

```
dist/
  index.js                 no external imports; new URL('./worker/worker.js', …) literal
  index.d.ts  client.d.ts  debug.d.ts  orchestrator.d.ts  types.d.ts  utils.d.ts
  worker/
    worker.js              monolithic: 3 glues + 5 VFS inlined
    wa-sqlite/*.wasm       3 assets, referenced relatively from worker.js
```

Nesting `worker/` *under* `dist/` rather than beside a format directory keeps every
relative URL pointing forward. A `..` traversal inside a `new URL` located under
`node_modules` is exactly the shape that dev-server guards reject (Vite's `fs.allow`).

Sizes, measured on wa-sqlite v1.1.2 (gzip): each glue 27-28 KB; `wa-sqlite.wasm` 286 KB,
`wa-sqlite-async.wasm` 451 KB, `wa-sqlite-jspi.wasm` 287 KB.

## 5. Source and manifest changes

- **`src/client.ts:332`** — `'./worker.ts'` → `'./worker/worker.js'`, and add
  **`{ type: 'module' }`** to the `WorkerOptions`. `worker.js` is an ESM module; without
  the flag the worker is classic and cannot execute it. The flag is absent today and the
  gap was never visible, because the browser suite runs rsbuild over `src/` and never
  touches `dist/`.
- **`src/client.ts:1`** — replace `defer()` from `@lalex/promises` with native
  `Promise.withResolvers()`.
- **`package.json`** —
  - `wa-sqlite` moves to `devDependencies`; `@lalex/promises` is removed. `dependencies`
    becomes empty.
  - `exports` gains `"./worker": "./dist/worker/worker.js"` and `"./dist/*": "./dist/*"`
    (the latter for tooling that goes through the exports map rather than the file path).
  - The four `dist/esm/…` paths (`exports.types`, `exports.import`, `exports.default`,
    and the top-level `types`) become `dist/…`.
- **`rslib.config.ts`** — restructured per §4.3. The existing comment about
  `tsconfig.build.json` stays accurate and must be preserved.
- **`NOTICE`** at the repo root, added to `files`. Vendoring wa-sqlite means
  redistributing its code (MIT; SQLite itself is public domain); the notices travel with
  it.

### On the npm `wa-sqlite` package

`npm view wa-sqlite` returns `1.0.0`, published by `gabrieldevunstatic
<tailinh@unstatic.co>`, with no `repository` field. **This is not the upstream package.**
B8 cannot be closed by pointing at the registry; vendoring is the only route.

## 6. Definition of done

`scripts/consumer-smoke.mjs` grows from two modes to four, all green:

| Mode | What it proves | Status |
|---|---|---|
| Vite dev server | worker resolution by a dev server | exists |
| Vite build + preview | worker and asset resolution in a production bundle | exists |
| rsbuild build + static serve | the second bundler family | to write |
| No bundler | static Node server with COOP/COEP, plain `<script type="module">` | to write |

Plus a static assertion over `dist/**/*.js`: no residual bare specifier. It proves
nothing the four modes do not, but it localises the failure when one of them breaks.

Then flip the `consumer-smoke` CI job from `continue-on-error: true` to blocking.

### Why rsbuild and not raw rspack

rsbuild is rspack *plus a default configuration layer*, and that layer is exactly where
the behaviours we care about live — asset handling, `assetPrefix`/publicPath, `distPath`,
whether `node_modules` is transpiled. Testing raw rspack would validate the engine;
testing rsbuild validates the engine **and** the defaults the project's only identified
consumer will actually have. It is also cheaper to write. If a webpack consumer ever
appears, the mode can be added then.

### The isolation rule, restated

Every mode must exercise **the published tarball only, never the repo's sources**. This
is already the design of `scripts/consumer-smoke.mjs` (see its header, lines 8-16): the
fixture is copied to a temp dir **outside** the repo so the bare `browser-sqlite`
specifier cannot resolve back to local sources, and installation uses `npm`, not `pnpm`,
to rule out workspace linking.

The two new fixtures inherit it unchanged, with two mode-specific cautions:

- the rsbuild fixture must declare no `resolve.alias` and no `source.include` pointing at
  the repo;
- the bundler-free mode must serve `node_modules/browser-sqlite/dist/` **from the
  temporary app**, never the repo's `dist/`.

The bundler-free mode is the strongest of the four for a reason beyond its own target:
served statically from the installed tarball, it has no tool capable of papering over a
bare specifier. If it passes, there are none left.

Both new fixtures need COOP/COEP headers on their server, as the inline rsbuild plugin in
`rstest.config.ts` already does for the browser suite.

## 7. Phase 2 — the chunk attempt

Once all four modes are green with `asyncChunks: false`, set it to `true` and re-run all
four. Keep the chunked output **only** if every mode stays green; otherwise revert to
monolithic and record why.

What is at stake: a monolithic worker inlines all three glues, ~83 KB gzip instead of
~28 KB — about +19 % on a first load that already fetches 286 KB of WASM. Real, but
small next to the risk of publishing a chunk graph that four different consumption modes
must each re-resolve.

## 8. Verification points

Points 1-3 were settled by a throwaway build probe on 2026-08-17, before the
implementation plan was written. Their answers are recorded here and embedded, with
comments, in the plan's build configuration.

1. **Does a per-entry `tools.rspack` actually override rslib's `esm` preset?**
   **Yes.** The overrides reach the resolved rspack config and take effect; the worker
   entry produced a single 696 KB self-contained file with **zero residual bare
   specifiers**. The standalone-rsbuild fallback is not needed.
2. **Is `url: true` enough to emit the `.wasm` while `importMeta` stays `false`?**
   **Yes.** All three variants are emitted and the glue's reference is rewritten to
   `__webpack_require__.p + "wa-sqlite/<hash>.module.wasm"`, with
   `__webpack_require__.b = new URL("./", import.meta.url)` — resolution relative to
   `worker.js`'s own URL, which is what makes the bundler-free mode possible. The
   `Module.locateFile` fallback is not needed.
3. **Which `distPath` key governs those files?**
   **`wasm`, not `assets`** — the opposite of what §4.3 first assumed. They are emitted
   by the rule `test: /\.wasm$/, dependency: 'url', type: 'asset/resource'`, whose
   generator filename is built from `distPath.wasm`. `output.assets` and
   `output.webassemblyModuleFilename` both have no effect on them. The content hash in
   `[contenthash:10].module.wasm` is fixed by that rule and survives rslib's
   `filenameHash: false`; the names are internal to `worker.js`, so this is left alone.
4. **Does the literal `new URL('./worker/worker.js', import.meta.url)` survive Vite's
   dependency pre-bundling (`optimizeDeps`/esbuild)?** **Still open** — only a real
   consumption run answers it. Smoke mode 1 decides.

**Measured on the probe** (wa-sqlite v1.1.2): `worker.js` 696 KB raw / 115 KB gzip;
`index.js` 20 KB raw / 4 KB gzip; the three `.wasm` 2.4 MB raw combined.

**Process note:** rslib caches builds aggressively. After any change to
`rslib.config.ts`, rebuild with `rm -rf dist node_modules/.cache && pnpm build` — a stale
tree produced one wrong conclusion during this probe before the cache was cleared.

## 9. Sequencing

1. Settle verification points 1-3 with a throwaway build; adjust §4.3 if a fallback is
   needed.
2. Restructure `rslib.config.ts`; flatten `dist/`; update the `package.json` paths.
3. `client.ts`: worker URL, `{ type: 'module' }`, `Promise.withResolvers()`; drop both
   runtime dependencies; add `NOTICE`.
4. Extend `scripts/consumer-smoke.mjs` with the rsbuild and bundler-free modes and the
   static bare-specifier assertion; add the two fixtures.
5. Green on all four modes → flip the CI job to blocking.
6. Phase 2: attempt `asyncChunks: true`, keep only if all four stay green.

The existing suite (105 tests) must stay green throughout, and both `it.fails` (B1 in
`tests/browser/transaction.test.ts`, B9 in `tests/browser/concurrency.test.ts`) must
still fail. Wave P changes no runtime behaviour; if either starts passing, something was
changed that should not have been.
