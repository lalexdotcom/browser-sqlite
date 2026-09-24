# The default build is the first one the engine supports — design

**Date:** 2026-09-24 · **Status:** approved in chat, spec under review · **Target:** rc.6 (`## Unreleased`) · **Branch:** `feat/default-build`

Backlog entry "Default to the first build the environment supports — `jspi` before `async`, for rc.6" (user, 2026-09-14). When the caller names no `build`, the library loads the first build the VFS declares **whose requirements the engine meets**. Today it loads the first declared build whatever the engine, so listing `jspi` first would make every engine without JSPI — Safari 26 included — refuse the default.

**Why:** Asyncify slows down on Safari and stays slow (IDB-SIGNAL, `mem:measurements`); `jspi` escapes it on Safari 27. On Chromium and Firefox `jspi` is equal or faster across the bench corpus, and on Safari 27 no median favours `async` (§ 6).

**Decisions (user, 2026-09-24):**

- `jspi` goes before `async` in **every** VFS, not only the five that start with `async`. `builds` is documented as "most preferred first"; one order for all VFS is `sync` > `jspi` > `async`. On the `sync`-first VFS no default moves — `sync` requires nothing, so it always wins.
- A `wasmUrl` callback that ignores its argument breaks on engines with JSPI when no `build` is passed. Accepted as breaking, documented in `CHANGELOG.md`.
- `defaultBuildFor` stays exported in this chantier and takes a second, required parameter. Unexporting it belongs to the public-surface chantier (`mem:follow-ups`), which must then remove this signature change from `CHANGELOG.md` as well.
- `pnpm test` runs each recommended VFS on the default of the engine under test (§ 4.2).

**Out of scope:** unexporting `defaultBuildFor` and `VFS_CAPABILITIES`; the two Chromium `IDBBatchAtomicVFS` rows where `jspi` is slower (single write ×1.18, 500 UPDATEs ×1.13), known when the order was decided.

---

## 1. Declared order

In `src/const/vfs.ts`, `builds` becomes `['sync', 'jspi', 'async']` on the four VFS that list `sync` today and `['jspi', 'async']` on the five others (`OPFSAdaptiveVFS`, `IDBBatchAtomicVFS`, `IDBMirrorVFS`, `OPFSAnyContextVFS`, `MemoryAsyncVFS`). No build is added or removed from any VFS.

Everything else that reads the order follows it, and none depends on it for correctness: the `Builds` line of each VFS in `VFS.md`, the "also runs on" list in `describeMissing`'s message, the pair order of `scripts/test-matrix.mjs`.

## 2. Resolution

```ts
/**
 * The build used when the caller does not name one: the first the VFS declares
 * whose requirements `available` meets.
 */
export const defaultBuildFor = (
  vfs: SQLiteVFS,
  available: ReadonlySet<PlatformFeature>,
): SQLiteBuild => { … };
```

- **It moves from `src/const/vfs.ts` to `src/capabilities.ts`**, beside `missingFeature`. It now reads `BUILD_CAPABILITIES` as a value, and `const/` files import each other as types only (`mem:architecture`) — `pnpm docs:vfs` and `pnpm test:matrix` load them under plain Node type stripping. `src/index.ts` re-exports it from its new home. Checked 2026-09-24: an rstest config loads `src/capabilities.ts` without trouble, so `tests/target-projects.ts` can import it (§ 4.2).
- **Pure, `available` required** — for the reason `missingFeature` already gives: the branch worth testing is the negative one, and JSPI cannot be taken away from Chromium. A default of `detectFeatures()` would also be wrong on the Node side, where the test configs call it: recent Node exposes `WebAssembly.Suspending`, and the targets would silently follow the Node version.
- **Only the build's requirements are considered.** A VFS requirement the engine lacks (OPFS) is still reported by `missingFeature`, with the message that names the VFS.
- **It always finds one.** Every VFS declares at least one build that requires nothing (`sync` or `async`); a unit test holds that invariant (§ 4.1). The body may still end on `?? builds[0]` to satisfy the type — unreachable while the invariant holds, and if it ever broke, `missingFeature` would then refuse the pair by name.

## 3. Call sites

- **`createSQLiteClient`** (`src/client.ts`) — `detectFeatures()` is called twice in that function today (`abortSlots`, the `missingFeature` check). It is called once, before `build` is resolved, and the result serves the three uses.
- **`deleteDatabase`** (`src/delete.ts`) — resolves with `detectFeatures()`. The build does not affect where the database lives, so resolving it by engine changes nothing about what is deleted.
- **The worker** stops resolving. `build` becomes required on the `open` and `delete` messages of `ClientMessageData` (`src/types/protocol.ts`), and both `?? defaultBuildFor(vfs)` in `src/worker/worker.ts` go: the client and `deleteDatabase` always send the resolved build (`src/pool.ts`, `src/delete.ts`), so these fallbacks are unreachable today.

## 4. Tests

### 4.1 Unit — `tests/unit/capabilities.test.ts`

- `'resolves the default build to the first declared one'` is replaced by:
  - with `jspi` available, every VFS resolves to its first declared build;
  - without `jspi`, every VFS resolves to its first declared build that requires nothing — `async` for the five `jspi`-first VFS, `sync` for the four others. This is the no-JSPI fallback the backlog entry asks for.
  - every VFS declares at least one build with no requirement (the § 2 invariant).
- Falsifiers: returning `builds[0]` unconditionally fails the second case; dropping `async` from a `jspi`-first VFS fails the third.
- `tests/unit/exports.test.ts` is unchanged — `defaultBuildFor` is still exported.

### 4.2 Targets — `tests/target-projects.ts`

`targetsFromEnv(env, engine)` takes the features of the engine its config drives. Each of the three configs passes its own: `rstest.config.ts` and `rstest.isolated.config.ts` Chromium's, `rstest.firefox.config.ts` Firefox's. Only build requirements matter to the resolution, so each set declares `jspi`: Playwright's Chromium and its Firefox 153 both expose `WebAssembly.Suspending` — the bench exports of both, run in this container, report `jspi: true`. With no `BSQ_TEST_TARGETS`, `pnpm test` runs `OPFSWriteAheadVFS/sync` and `OPFSAdaptiveVFS/jspi`; `OPFSAdaptiveVFS/async` is covered by the matrix. A set that claimed a feature its engine lacks would not pass silently: the client refuses the pair at construction, by name.

### 4.3 In-page helpers

`tests/conformance/helpers.ts` (`missingHere`, `conformanceClient`, `createReopened`) and `tests/browser/helpers.ts` (`createTestClient`) pass `AVAILABLE_FEATURES`, which they already compute in the page.

## 5. Documentation

- **`CHANGELOG.md`, `## Unreleased`:**
  - *Changed* — omitted, `build` is the first build the VFS declares **that the browser supports**, and `jspi` is now declared before `async` everywhere. On engines with JSPI (Chrome 137+, Firefox 153+, Safari 27+), `OPFSAdaptiveVFS`, `IDBBatchAtomicVFS`, `IDBMirrorVFS`, `OPFSAnyContextVFS` and `MemoryAsyncVFS` now load `jspi` instead of `async`; elsewhere nothing changes. Pass `build: 'async'` to keep the previous behaviour.
  - *Breaking* — a `wasmUrl` callback that ignores the build it receives, with no `build` passed, now hands a JSPI engine the wrong `.wasm` for those five VFS: use the argument, or pass `build`.
  - *Breaking* — `defaultBuildFor(vfs)` becomes `defaultBuildFor(vfs, available)`; pass `detectFeatures()`.
- **`API.md`** — the two `build` rows (`createSQLiteClient`, `deleteDatabase`): "first build the VFS declares" becomes "first build the VFS declares that the browser supports".
- **`VFS.md`**, through `scripts/render-vfs-matrix.ts` and `pnpm docs:vfs` — the `Builds reference` prose says the same; `BUILD_NOTE.jspi` loses "Opt-in, and no default uses it" and says it is the default where the engine has it; `BUILD_NOTE.async` says Safari 27+ gets `jspi` by default, so the slowdown remains only where JSPI is absent (Safari 26) or where `async` is asked for.
- **`src/client.ts` JSDoc** — the "Browser requirements" paragraph ("only `build: 'jspi'` does, and JSPI is Chromium-only") is rewritten: the default needs no opt-in, because it falls back to a build the engine runs. The `wasmUrl` example becomes a callback that uses its argument.
- **`src/api.ts:439`** — "resolved by `defaultBuildFor` when not passed" stays true.

## 6. Evidence

**Chromium and Firefox** (bench corpus, `mem:follow-ups` entry of 2026-09-14): `jspi` equal or faster — full scan ×0.41-0.66, list page ×0.40-0.86, bulk insert ×0.72-1.04 — except the two `IDBBatchAtomicVFS` rows out of scope above.

**Safari 27, `OPFSAdaptiveVFS`** — the measurement the backlog entry asked for before changing the default. It was already banked: 38 bench exports (`.bench/*safari-27*`, rc.3 and rc.4, 21 iPadOS and 17 macOS) carry both columns. Median of `jspi / async` per run; below 1 favours `jspi`, except `read-burst-concurrency` where higher is better:

| metric | macOS | iPadOS |
|---|---|---|
| full scan | 0.67 | 0.50 |
| list page p50 | 0.66 | 0.50 |
| point read p50 | 0.66 | 0.66 |
| bulk insert 10k | 0.78 | 0.91 |
| transaction throughput | 0.83 | 0.59 |
| write latency p50 | 1.00 | 1.00 |
| read-burst concurrency | 0.97 | 1.00 |

No median favours `async`. Single runs spread wider (bulk insert on iPadOS up to 1.73), and Asyncify's Safari slowdown can weigh on the `async` columns depending on where they fall in a run — a cost a consumer pays too, not an artefact.

## 7. Verification

`VFS_CAPABILITIES` changes, so by `mem:conventions` the full matrix runs before the merge, beside `pnpm test`, `pnpm exec tsc --noEmit`, `biome ci .` and `pnpm docs:vfs && git diff --exit-code VFS.md`.
