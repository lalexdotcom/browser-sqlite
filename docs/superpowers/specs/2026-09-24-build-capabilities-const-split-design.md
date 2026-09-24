# `BUILD_CAPABILITIES` and the `const/` · `types/` split — design

**Date:** 2026-09-24 · **Status:** approved in chat, spec under review · **Target:** rc.6 (`## Unreleased`) · **Branch:** `refactor/build-capabilities-const-split`

Two rc.6 backlog entries, done as one chantier (user, 2026-09-24): the build tables become one registry from which `SQLiteBuild` is derived, and `src/types.ts` is split by what each declaration is — platform, build and VFS data in `src/const/`, the wire protocol and the errors in `src/types/`. The root of `src/` is too full, and the benefit is the user reading the code (user, 2026-09-16). One file today mixes public API with internal protocol, and only a hand-maintained export list in `src/index.ts` keeps them apart; after the split that boundary is structural.

**Nothing a consumer sees changes.** That is the success criterion, and it is checkable (§ 4).

**Out of scope (user, 2026-09-24):** unexporting `VFS_CAPABILITIES` and `folderOf`. Both stay exported exactly as they are; that entry stays in `mem:follow-ups`.

---

## 1. `BUILD_CAPABILITIES`

```ts
/** What a build needs from the engine, and what it loses without it. */
export type BuildCapability = {
  /** Platform features this build cannot run without, beyond plain WebAssembly. */
  readonly requires: readonly PlatformFeature[];
  /** Platform features without which a running statement cannot be interrupted. */
  readonly interruptibleWithout: readonly PlatformFeature[];
};

export const BUILD_CAPABILITIES = {
  sync: { requires: [], interruptibleWithout: ['cross-origin-isolated'] },
  async: { requires: [], interruptibleWithout: [] },
  jspi: { requires: ['jspi'], interruptibleWithout: [] },
} as const satisfies Record<string, BuildCapability>;

export type SQLiteBuild = keyof typeof BUILD_CAPABILITIES;
```

- **`Record<string, …>`, not `Record<SQLiteBuild, …>`** — the latter makes the derivation circular. `VFS_CAPABILITIES` does the same.
- **The registry is checked in both directions.** `WA_SQLITE_BUILDS` (worker) and `BUILD_NOTE` (VFS.md generator) are already typed `Record<SQLiteBuild, …>`: a build missing from either fails with TS2741, an extra one with TS2561 (measured 2026-09-16). Both stay where they are — the dynamic `wa-sqlite` imports and the documentation data must not ship to every consumer.
- **The objection comment above `BUILD_REQUIREMENTS` is deleted, not moved.** It claims `keyof` would let a forgotten entry pass silently; the measurement above shows the opposite.
- **`interruptibleWithout` names the property; `degradesWithout` is dropped at build level (user, 2026-09-24).** After this change nothing reads a build-level `degradesWithout`. A second degradation axis, if one appears, gets its own named field; an aggregate is added only when something needs it. The rationale in today's `BUILD_DEGRADES_WITHOUT` comment — no `SharedArrayBuffer` outside a cross-origin isolated context, measured 2026-09-04, and no naming of COOP/COEP/Document-Isolation-Policy — moves, shortened, to `interruptibleWithout`.
- **Build preference order does not move here (user, 2026-09-16).** It stays in each VFS's `builds` array.

**Sites.** `BUILD_REQUIREMENTS[b]` → `BUILD_CAPABILITIES[b].requires` in `src/capabilities.ts`, `scripts/render-vfs-matrix.ts` (where `BUILDS` becomes `Object.keys(BUILD_CAPABILITIES)`), `tests/browser/features.test.ts`, `tests/browser/target.ts`, `tests/conformance/helpers.ts` and `tests/unit/test-target.test.ts`.

**`tests/browser/target.ts`** — `holds('interruptible')` reads `BUILD_CAPABILITIES[build].interruptibleWithout`; the "PROVISIONAL SHAPE" comment goes, since its reason goes.

**`tests/unit/capabilities.test.ts`** — "declares which build degrades without which feature" becomes the same assertion on `interruptibleWithout`. "gives every declared feature either a probe or an explicit exemption" iterates `requires` and `interruptibleWithout` of every build; today it misses `BUILD_DEGRADES_WITHOUT`.

## 2. The split

No `index.ts` in either directory and no re-export anywhere. `src/types.ts` is deleted: everything in it has a home, `WasmLocation` included (user, 2026-09-24) — it is the shape of a field of the `open` message, produced by `resolveWasmLocation` and read by the worker.

**The placement rule (user, 2026-09-16): a type derived from a const lives in the same file as the const.**

| File | Holds | Imports |
|---|---|---|
| `src/const/platform.ts` | `PlatformFeature` | — |
| `src/const/builds.ts` | `BuildCapability`, `BUILD_CAPABILITIES`, `SQLiteBuild` | platform |
| `src/const/vfs.ts` | `VFSStorage`, `VFSMemoryModel`, `VFSCapability`, `VFS_CAPABILITIES`, `SQLiteVFS`, `folderOf`, `defaultBuildFor` | platform, builds |
| `src/const/sqlite.ts` | today's `src/sqlite-codes.ts`, moved whole | — |
| `src/types/errors.ts` | today's `src/errors.ts`, moved whole — `SQLiteErrorCode` and both classes | const/sqlite |
| `src/types/protocol.ts` | `SQLiteWorkerMessageData`, `SQLWorkerResultData`, `SharedArrayTypes`, `SavepointOp`, `SQLOptions`, `WasmLocation`, `ClientMessageData`, `WorkerMessageData` | platform, builds, vfs, sqlite, errors |

DAG: platform ← builds ← vfs ← protocol and sqlite ← errors ← protocol. No cycle. **Inside `const/`, imports are `import type` only**: `pnpm docs:vfs` and `pnpm test:matrix` load these files under plain Node type stripping, which erases type imports but cannot resolve an extensionless value import — as `types.ts` already is today. `types/` emits JS (`SharedArrayTypes`, the error classes): the directory groups declarations, it is not an erasable-only contract.

- **`git mv`** for `errors.ts` and `sqlite-codes.ts`, so their history follows.
- **Imports** — every importer of `src/types`, `src/errors` or `src/sqlite-codes` across `src/`, `src/worker/`, `tests/` and `scripts/` imports from the file that declares what it uses. The churn is not a cost (user, 2026-09-16).
- **`src/index.ts`** — the same exported names: `export *` from `./types/errors`, the named exports from `./const/sqlite`, `./const/vfs`, `./const/builds` and `./const/platform`. The comment about wire-protocol types is rewritten: nothing exports from `types/protocol.ts`, and that is what keeps them internal.
- **Outside the code** — the generated marker in `VFS.md` becomes "edit VFS_CAPABILITIES in src/const/vfs.ts": changed in `scripts/render-vfs-matrix.ts`, then `pnpm docs:vfs`. `scripts/test-matrix.mjs` imports `src/const/vfs.ts`. Code comments naming `src/types.ts`, `errors.ts` or `sqlite-codes.ts` are corrected. The Serena memories are updated at closure.

## 3. Commits

On `refactor/build-capabilities-const-split`, in the order the user set on 2026-09-16 — the other order writes `const/builds.ts` twice:

1. `BUILD_CAPABILITIES`, still inside `src/types.ts`, with every reader and test moved to it.
2. The split — moves, imports, `index.ts`, generator and regenerated `VFS.md`, `test-matrix.mjs`.

Each passes the `pre-commit` hook (`tsc`, lint-staged, unit).

## 4. Verification

**The public surface.** TypeScript 7 ships no JavaScript compiler API, so the check is two throwaway tools, in the scratchpad and not committed, both tried on 2026-09-24:

- a text dump of `dist/**/*.d.ts` — the names reachable from `index.d.ts`, then every top-level declaration keyed by name, comments and import lines stripped. Taken before the first code change and after the last; **the public name list must be identical**, and the declarations may differ only by `BUILD_REQUIREMENTS` and `BUILD_DEGRADES_WITHOUT` removed, `BuildCapability` and `BUILD_CAPABILITIES` added, and `SQLiteBuild`'s right-hand side;
- a type-level equality check, `tsc --ignoreConfig` over a file importing the saved `dist` and the new one: `SQLiteBuild` equals `'sync' | 'async' | 'jspi'` in both. It fails when falsified (checked against `'sync' | 'async'`).

The per-file `.d.ts` paths under `dist/` change, and are not public: `package.json` `exports` publishes only `./dist/index.d.ts` and the worker.

**The 2026-09-24 baseline** (`mem:state`), read in one pass at the end:

| command | expected |
|---|---|
| `pnpm exec tsc --noEmit`, `pnpm build`, `pnpm exec biome ci .` | clean |
| `pnpm exec rstest --project unit run` | 519 — one test reworded, none added |
| `pnpm test` | 1255 / 738 / 14, skips 8 / 2 / 0 |
| `pnpm test:conformance` | Chromium 83 / 14 skipped, Firefox 79 / 18 |
| `pnpm test:consumer` | 24/24 |
| `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.mjs chromium --all` | `OK` |
| `pnpm lint` | 13 warnings, 1 info — the file count moves with the tree |
| `pnpm docs:vfs` | `VFS.md` differs by the marker line only |

**No `pnpm test:matrix`.** The one runtime-visible change is `holds('interruptible')`, and `interruptibleWithout` holds exactly today's `BUILD_DEGRADES_WITHOUT` values, so test selection is identical on all 22 pairs; `pnpm test` covers both recommended pairs and the isolated projects.

**No `CHANGELOG.md` entry** — nothing a consumer sees changes.
