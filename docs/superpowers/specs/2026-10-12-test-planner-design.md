# A browser suite without identical repetitions — design

**Date:** 2026-10-12 · **Status:** approved (user, 2026-10-12) · **Target:** CHANGELOG entries for step 1 only (§ 7); the rest changes no consumer-visible behaviour · **Branches:** one per step (§ 10)

Every browser project of `vitest.config.ts` is one (vfs, build) target on one browser, isolated or not, and every project includes the same files. A test that names its own VFS — `createTestClient({ vfs })`, a VFS constant, a literal passed to `createSQLiteClient` — ignores the target but still runs in every project: 44 identical runs in a matrix of 22 pairs × 2 browsers, twice that counting the isolated column. The isolated column itself held 9 tests, all pinned to `OPFSWriteAheadVFS/sync` or using no VFS at all, so 44 isolated cells repeated one cell. The first matrix run on GitHub (2026-10-11) failed twice in such tests, each time in a cell that had nothing to do with it.

A traced run on 2026-10-11 (every test recording whether it read the target and how many workers it started; Chrome, Firefox and isolated Chrome on `OPFSWriteAheadVFS/sync`; 922 executions, 471 distinct tests, all green) gave the inventory this design rests on:

| What the test does | Tests |
|---|---|
| reads the target | 343 |
| opens a VFS without reading the target (pinned) | ~102 |
| opens no VFS at all | 10 |
| a synchronous guard that names a VFS but opens nothing | 13 |
| skipped everywhere (`abandon-gc` without `--expose-gc`) | 1 |

A static reading of the sources under-counts the pinned ones: VFS constants (`open-retry`, `vfs-create-retry`), describe-scoped helpers, and target reads at module or describe scope (`vfs-folders.test.ts:11`, `delete.test.ts:271`, `second-client.test.ts:141`) all fool it. The conversion (§ 8) re-runs the trace rather than trusting a grep.

---

## 1. Decisions (user, 2026-10-11 and 2026-10-12)

- **D1 — Two series of browser tests.** A *pair test* runs on a (vfs, build) pair the project provides, filtered by what it needs (§ 2). A *standalone test* uses no VFS, or compares VFS only through a constant: it runs once per browser, outside the matrix. A test that would need two pairs takes the target as one side and the first pair satisfying a need as the other; none exists today.
- **D2 — A need describes what the test requires, not a VFS.** `shouldTestRun(context, need) → boolean` decides, a pure function with its own unit tests. Pinning (`vfs:` overriding the target), the `fallback` resolution and `BSQ_TEST_NEEDS` disappear: a test runs on its cell's pair or not at all.
- **D3 — Isolation runs a test only where it changes the test's eligibility.** Measured in the code: isolation only enables the `sync` build's slot channel (`client.ts` allocates the slots in any isolated context, only the `sync` worker reads them). Isolated cells are therefore non-empty only on the four `sync` pairs; an empty cell is never launched. Asked for explicitly (`test:chrome:isolated`), a mode runs in full.
- **D4 — Needs are literal Vitest tags**, read by static collection with no browser (~1 s for the suite). Vitest refuses an undeclared tag, which enforces the closed vocabulary.
- **D5 — Features come from one small probe per environment** (browser × isolated), using the library's own `detectFeatures` plus the worker probe for `sync-access-handle` and `readwrite-unsafe`. Every cell re-checks at collection and fails on any mismatch with the plan.
- **D6 — `pnpm test` catches early; the matrix is the verdict.** `pnpm test` starts from a list of VFS (`RECOMMENDED_VFS`), runs every test those pairs can run, and adds the fewest *complement* cells that give every other test one run per browser. The matrix runs every eligible pair, and runs on every push of `main` (§ 9).
- **D7 — Browsers are never merged.** Capabilities describe what the library detects, not how each engine implements OPFS, access handles, Web Locks or IndexedDB — the subject of the browser suite. Firefox has gated `pnpm test` since 2026-09-03 because a Firefox-only failure once arrived late.
- **D8 — An eligible pair is a pair to run.** Only isolation is known not to change results; two pairs are two coverages. No reduced-coverage mode (once per build, any one pair) until a measured matrix asks for one.
- **D9 — `browser` is a constraint only for an engine behaviour no probe detects**, the rule `mem:conventions` already applies to browser-defect skips. Everything a feature explains is a property.
- **D10 — The common guards of `createSQLiteClient` and `deleteDatabase` run in one order**, option guards before the environment, so twelve guard tests move to `unit` (§ 7). The IndexedDB VFS declare the IndexedDB they require.
- **D11 — `tests/browser/firefox/` and `tests/browser/isolated/` stop meaning anything**: their files join `tests/browser/`. A wider reorganisation of the test files is the next piece of work, not this one.
- **D12 — `test:watch` is gone** (merged 2026-10-12): nothing ran it, and a watch run would bypass the plan.

## 2. The need

```ts
type TestContext = {
  vfs: SQLiteVFS;
  build: SQLiteBuild;
  browser: 'chrome' | 'firefox';
  isolated: boolean;
  features: ReadonlySet<PlatformFeature>;
};

type TestNeed = {
  browser?: readonly Browser[];
  vfs?: readonly SQLiteVFS[];
  build?: readonly SQLiteBuild[];
  isolated?: boolean;          // true: isolated contexts only; false: non-isolated only
  requires?: readonly Property[];
  excludes?: readonly Property[];
};

shouldTestRun(context: TestContext, need?: TestNeed): boolean;
```

**Semantics.** Fields combine with AND; a list is an OR (`vfs: ['A', 'B']` is A or B). `requires` holds when every property holds, `excludes` when none does. No need: the test runs in every non-isolated context. **In an isolated context**, a test whose need does not say `isolated: true` runs only when it is eligible there and not eligible in the same context without isolation (D3).

**Properties.** Each is a predicate over `VFS_CAPABILITIES`, `BUILD_CAPABILITIES` and the context's features, computed in one module; none is a hand-kept table. The pairs below are computed with the probed features, non-isolated (2026-10-12):

| Property | The test needs… | Predicate | Chrome | Firefox |
|---|---|---|---|---|
| `two-workers` | a pool of two workers or more | `maxPoolSize ≠ 1`, `singleConnectionWithout` met | OPFSWriteAhead, OPFSAdaptive, IDBBatchAtomic, OPFSAnyContext | IDBBatchAtomic, OPFSAnyContext |
| `interruptible` | a running statement to be interruptible | the build's `interruptibleWithout` met | every pair except `sync` builds (which have it when isolated) | same |
| `shared-second-client` | a second client to reach the same bytes | not memory, not `exclusiveConnection`, `exclusiveConnectionWithout` met | OPFSWriteAhead, OPFSAdaptive, OPFSCoopSync, IDBBatchAtomic, IDBMirror, OPFSAnyContext | the same without OPFSWriteAhead |
| `exclusive-connection` | a second client to be refused | not memory, and `exclusiveConnection` or `exclusiveConnectionWithout` unmet | AccessHandlePool | AccessHandlePool, OPFSWriteAhead |
| `shared-storage` | a database visible outside the worker that opened it | `sharesStorage` (`src/locks.ts`): storage is not memory | all but Memory, MemoryAsync | same |
| `opfs-file` | the database to be an OPFS file at its own name | `folder` set | OPFSWriteAhead, OPFSAdaptive, OPFSCoopSync, OPFSAnyContext | same |
| `in-place-file` | that file with no write-ahead files beside it | `folder` set, `extraFileSuffixes` empty | OPFSAdaptive, OPFSCoopSync, OPFSAnyContext | same |
| `capped-pool` | a VFS that caps the pool by declaration | `maxPoolSize !== null` | OPFSCoopSync, AccessHandlePool, IDBMirror, Memory, MemoryAsync | same |
| `env-capped-pool` | a pool capped by the environment | `singleConnectionWithout` unmet | — | OPFSWriteAhead, OPFSAdaptive |
| `default-pragmas` | a VFS that declares default pragmas | `defaultPragmas` not empty | OPFSAdaptive, AccessHandlePool, IDBBatchAtomic, OPFSAnyContext | same |
| `exclusive-file-handle` | a VFS that takes its OPFS handle exclusively | `exclusiveFileHandle` | OPFSCoopSync, AccessHandlePool | same |
| `idb-storage` | a database in IndexedDB | `storage === 'indexeddb'` | IDBBatchAtomic, IDBMirror | same |

A second client is exactly one of three things on a pair in a context — shared (`shared-second-client`), refused (`exclusive-connection`) or given a database of its own (`excludes: shared-storage`) — the partition `secondClientOutcome` (`tests/browser/helpers/vfs-contract.ts`) already names. `IDBMirrorVFS` is shared: its `multiConnection: false` marks writer unsafety (MIRROR-1), not isolation.

**Rules of the vocabulary.** Negation is `excludes`; no property names an opposite. A `vfs` list is admitted only for a subject that belongs to one VFS — `OPFSCoopSyncVFS`'s hand-over protocol, `OPFSWriteAheadVFS`'s barrier pragma. The slot channel is `build: ['sync']` + `requires: ['interruptible']`; the degraded path is `build: ['sync']` + `excludes: ['interruptible']`. The list grows only by decision, when a test needs it. No property shares a name with a `PlatformFeature` (`indexeddb` is a feature, `idb-storage` a property); a unit test checks it.

**Tags.** A need is written as literal tags on the `it` or its `describe` (inherited): `requires:<property>`, `excludes:<property>`, `vfs:<VFS>`, `build:<build>`, `browser:<browser>`, `isolated`, `not-isolated`, and `standalone` for D1's second series. `needFromTags(tags)` rebuilds the `TestNeed`. Static collection reads a tag only when it is a literal array in the call: a constant, a computed value, a wrapper function or a `${}` loop is invisible to it (measured 2026-10-12), so generated-by-loop tests go — a test follows its pair instead of looping over builds. The tag list declared in the config is generated from the vocabulary, `VFS_CAPABILITIES` and `BUILD_CAPABILITIES`, so a new VFS brings its tags.

## 3. Standalone tests and the isolated precondition

Standalone tests (`standalone` tag) run once per browser, non-isolated, outside the matrix, in `pnpm test` and in `verify`. Today: `realm` (4), `vfs is required` (2), `delete › rejects with INVALID_OPTION when vfs is missing`, `features › never reports what no page can probe`, `inspect-realm › is stable across calls`, and the init-lock BUSY test of `delete` once IndexedDB is required (§ 7). A standalone test that needs a VFS for a representative takes the first pair satisfying its need through the same resolver as the plan, never a hard-coded name.

`isolated/environment.test.ts` is not a test of the library: a project that declares itself isolated checks, at startup, that `crossOriginIsolated` is true and that a `SharedArrayBuffer` reaches a worker, and fails the run by name otherwise — the same footing as `TARGET_NOT_RUNNABLE` today.

## 4. The planner

A Node module, used by every script of § 5:

1. **Needs**: static collection of the browser files (`createVitest(…).collect()`, static by default), each test's tags turned into a `TestNeed`.
2. **Features**: one probe per environment the run selects — a tiny browser project per (browser, isolated) that records `AVAILABLE_FEATURES` in a test's `meta`, read back through `vitest.collect(undefined, { staticParse: false })`. Measured: 4 environments in 5.5 s. Node itself is an environment for `unit`, with `detectFeatures()` there (`web-locks` only today).
3. **Contexts**: for each selected browser and isolation mode, the pairs. The matrix takes every entry of `AVAILABLE_VFS` with its builds in declared order; `pnpm test` takes `RECOMMENDED_VFS`, each on `defaultBuildFor(vfs, features)` — a list of VFS, never a hard-coded pair, so a browser without JSPI gets `OPFSAdaptiveVFS/async` as a user would. A build the browser cannot run is not a pair there. `BSQ_TEST_TARGETS` keeps its role; an explicit pair is never substituted: not runnable on a browser, it is shown "not applicable" there, and not runnable on any selected browser, it is an error before anything starts.
4. **The plan**: `shouldTestRun` for every (test, context). In *all-pairs* mode (the matrix) every eligible context runs the test. In *complement* mode (`pnpm test`, hooks, `verify`) the start contexts run every test they can, and each remaining test runs once per browser on the **first eligible pair in canonical order** — `VFS_CAPABILITIES` keys, then each VFS's builds in declared order, filtered by the browser. The rule depends only on the test's need and the features, so adding a test never moves another one. Estimated from the inventory: four complement cells on Chrome, three on Firefox.
5. **Cells**: only non-empty cells start. Each receives its exact list of tests; how Vitest is told the list (specifications with test lines, `testNamePattern`, `tagsFilter`) is the first thing step 4 measures. The plan prints first: each cell, its pair, why it exists, how many tests.
6. **Guard in each cell**: at collection, a setup file recomputes `shouldTestRun` from the tags read at run time and the features detected in place; a test that would run against the plan, or a target that differs from the planned one, or features that differ from the probe's, fail the run by name.

**Reporting.** *Not applicable on a browser* — the situation the test needs does not exist there (`env-capped-pool` on Chrome) — is listed with the missing need and counted apart, never a failure; the list is compared before and after a browser pin changes, as `dist/` is compared across a wa-sqlite repin. *Dead* — eligible on no pair of any selected browser — fails the matrix and CI, and warns in a local run, where a browser may simply be absent. In complement mode a test eligible somewhere and run nowhere cannot exist; the cell guard checks it.

**Direct Vitest runs bypass the plan.** The scripts accept files and plan for them (`pnpm test -- tests/browser/delete.test.ts`). A browser project started outside the plan prints that only the tests eligible on its own target run.

## 5. Scripts

| Script | What the plan selects |
|---|---|
| `test` | `unit` and both browsers, both modes, deduplicated (D3), complement mode |
| `test:chrome`, `test:firefox` | that browser, both modes, deduplicated |
| `test:chrome:not-isolated`, `test:firefox:not-isolated` | that browser, non-isolated, in full |
| `test:chrome:isolated`, `test:firefox:isolated` | that browser, isolated, in full |
| `test:isolated` | both browsers, isolated, in full |
| `test:matrix` | all pairs, both browsers, both modes, deduplicated |
| `test:unit`, `test:conformance*`, `test:consumer` | unchanged |

`BSQ_TEST_NEEDS` goes. `BSQ_TEST_TARGETS` stays (§ 4.3). Every script keeps its `scripts/bounded.ts` deadline.

## 6. What disappears

Pinning through `createTestClient({ vfs })` (the option leaves its type, so a pin no longer compiles), `pairFor`'s fallback and `ON_UNMET_NEED`, `onUnmetFromEnv`, the static `CHROMIUM_FEATURES` / `FIREFOX_FEATURES` tables, the per-target `include` globs and `ENGINE_DIR` (whose `chromium/` directory does not exist), the `firefox/` and `isolated/` directories, the loops over builds inside tests.

## 7. Library changes (step 1)

**One order for the common guards** of `createSQLiteClient` (`src/client.ts`) and `deleteDatabase` (`src/delete.ts`): vfs required → vfs/build combination → names (`resolveDatabase`) → their own guards (pool and pragmas; the memory early return) → `missingFeature` → the `.wasm` URL. `deleteDatabase` already follows it except for the URL, which it resolves before its locks; it moves to the moment the delete worker starts. `createSQLiteClient` moves its pragma validation before `missingFeature` and its `resolveWasmLocation(…, location.href)` after it. Measured in a throwaway worktree: `unit` 766/766 and the seven affected browser files 220/220 on both browsers. Two consumer-visible effects, both `Changed`: an invalid pragma on a browser without OPFS is reported as `INVALID_PRAGMA` rather than the missing OPFS; a `wasmUrl` callback is no longer called when a guard throws.

**The IndexedDB VFS declare IndexedDB.** `IDBBatchAtomicVFS` and `IDBMirrorVFS` require only `web-locks`, so `missingFeature` lets them through where IndexedDB is absent and the failure surfaces in a worker. A `PlatformFeature` `indexeddb` with a page probe joins their `requires` (`Fixed`). This moves the init-lock BUSY test out of Node: no persistent VFS runs there any more, and `deleteDatabase` checks features before its locks. It becomes a standalone browser test (§ 3).

Entries go through the `changelog-maintenance` skill on the step's branch.

## 8. The conversion (steps 2 and 5)

**Twelve guards move to `unit`** (step 2), rewritten over `VFS_CAPABILITIES` instead of a named VFS: every VFS with a `maxPoolSize` refuses a larger pool with its `poolLimitReason` in the message (this reaches `IDBMirrorVFS`, never tested so far); the vfs/build combination, for `createSQLiteClient` and `deleteDatabase`; the refused pragma; the memory `deleteDatabase` that starts no worker; the too-long and empty names. Measured: with § 7's order they pass in Node with no stub.

**Every browser test gets its tags** (step 5). A pinned test is read for what it tests: a VFS standing for a capability becomes a property (`OPFSAdaptiveVFS` for "shared mode", `MemoryVFS` for "nothing shared" → `excludes: shared-storage`, which also reaches `MemoryAsyncVFS`); a VFS that is the subject keeps a `vfs` tag. `firefox/handle-starvation` is `env-capped-pool`, not Firefox; `firefox/stream-retention` keeps `browser: firefox`. A test that branches on its target's capability (`inspect-client › describes a lone client`) is split into one test per branch, so the need shows in the tags. The trace of the introduction is re-run before and after: no test may lose its last run, and every test that read no target must be either `standalone` or tagged with what it uses.

**New coverage will fail.** Tests reaching pairs they never ran on (`IDBMirrorVFS`, `MemoryAsyncVFS`, `sync` pairs under isolation for every `interruptible` test) will turn up failures. Each is triaged on its own — a defect or a test assumption — and none widens the conversion.

## 9. CI

`ci.yaml`'s `verify` runs the complement plan; the matrix workflow (`matrix.yaml`) runs the all-pairs plan, called by the release as today, startable by hand, and triggered on every push of `main`. Its cells follow the plan's non-empty cells. The browser installation and AppArmor steps stay as they are.

## 10. Steps, verification, risks

| Step | Content | Rests on |
|---|---|---|
| 1 | § 7: guard order, IndexedDB requirement, CHANGELOG | — |
| 2 | the twelve guards in `unit` | 1 |
| 3 | `TestNeed`, properties, `shouldTestRun`, `needFromTags`, generated tag declarations, with unit tests | — |
| 4 | the planner, probes, cells, cell guard, reporting, scripts | 3 |
| 5 | the conversion, the isolated precondition, the directories flattened, pinning and fallback removed | 3, 4 |
| 6 | CI | 4, 5 |

Each step on its own branch, closed as `AGENTS.md` says (format, lint, typecheck, tests, memories, `--no-ff` merge). Steps 4 to 6 also run the matrix, locally and on GitHub (`gh workflow run matrix.yaml --ref <branch>`).

**Risks.** The Vitest Node API (`createVitest`, `collect`, `staticParse`, tags) is the planner's foundation: it is pinned with Vitest, and a Vitest bump re-runs the probes of this design. The selection of exact tests per cell is not measured yet (§ 4.5). The static parser's limits (§ 2) make an unread tag look like "no need"; the cell guard is what catches it. New coverage failures (§ 8) may take longer than the conversion itself.

## 11. Out of scope

Reorganising the test files beyond flattening `firefox/` and `isolated/` (the next piece of work); Safari, Windows and macOS runners; a reduced-coverage mode; any change to the conformance suite or the consumer smoke.
