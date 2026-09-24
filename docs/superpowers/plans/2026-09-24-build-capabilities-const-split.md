# `BUILD_CAPABILITIES` and the `const/` · `types/` split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `BUILD_REQUIREMENTS` / `BUILD_DEGRADES_WITHOUT` with one `BUILD_CAPABILITIES` registry that `SQLiteBuild` derives from, then split `src/types.ts`, `src/errors.ts` and `src/sqlite-codes.ts` into `src/const/` and `src/types/`, with the public surface unchanged.

**Architecture:** Two commits on `refactor/build-capabilities-const-split`. Task 1 changes the build table in place inside `src/types.ts` and moves every reader to it. Task 2 moves declarations verbatim into six files, deletes `src/types.ts` and rewrites every import. Task 3 proves the public surface did not move and re-reads the 2026-09-24 baseline.

**Tech Stack:** TypeScript 7.0.2 (native — no JS compiler API), rslib (per-file `.d.ts`), rstest, biome, pnpm. Node type stripping runs `scripts/render-vfs-matrix.ts` and `scripts/test-matrix.mjs` directly on `src/`.

**Spec:** `docs/superpowers/specs/2026-09-24-build-capabilities-const-split-design.md`

## Global Constraints

- **Serena tools are primary for code** (AGENTS.md). Explore with `get_symbols_overview`, read with `find_symbol` (`include_body`), edit with `replace_symbol_body` / `insert_*_symbol` / `replace_content`. Built-in Read/Edit on code files only when Serena fails. Read/Edit are fine on `.md`, JSON, config.
- **Public surface unchanged.** `src/index.ts` exports exactly the 44 names it exports today. `VFS_CAPABILITIES` and `folderOf` stay exported (user, 2026-09-24).
- **No `index.ts` in `src/const/` or `src/types/`, and no re-export of a moved name anywhere** — except `src/index.ts`'s existing public exports, with new paths.
- **Inside `src/const/`, cross-file imports are `import type` only.** Node's type stripping loads these files for `pnpm docs:vfs` and `pnpm test:matrix`; it erases type imports but cannot resolve an extensionless value import.
- **Declarations move verbatim**, JSDoc included. The only renamed or reshaped declarations are the ones Task 1 names.
- **After every modification:** `pnpm exec biome check --write <touched files>` (it also orders imports).
- **Comments state the fact, one or two lines**; the reasoning goes to the commit message.
- **Markdown prose is not hard-wrapped.** Commit messages are wrapped at 72 and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **The `pre-commit` hook runs `tsc`, lint-staged and the unit project.** Never `--no-verify`.
- **Scratch tools live in** `/tmp/claude-1000/-workspaces-wsqlite/c78afeb5-91f2-42b6-b87d-b75787357881/scratchpad` (below: `$S`). `$S/surface.mjs` exists already and was tried on 2026-09-24; nothing under `$S` is committed.

## Review Focus

- **`SQLiteBuild` silently widening to `string`.** Writing `BUILD_CAPABILITIES: Record<string, BuildCapability> = …` (annotation) instead of `… as const satisfies Record<string, BuildCapability>` makes `keyof typeof` return `string`, and every build-keyed table stops being checked. Pinned by Task 3 Step 4's type equality, and by Task 1 Step 6's `tsc` rejecting a bogus build in `WA_SQLITE_BUILDS`.
- **A public name dropped, or an internal one leaked.** An `export *` of `./types/protocol` or `./const/builds` would publish `WorkerMessageData` or `BUILD_CAPABILITIES`; a forgotten named export would drop one. Pinned by Task 3 Step 3's public-name diff.
- **A `const/` file that Node cannot load.** A value import between `const/` files passes `tsc` and every rstest run, then breaks `pnpm docs:vfs` and `pnpm test:matrix`. Pinned by Task 2 Step 9.
- **`VFS.md` drifting from its generator.** The marker names the file to edit; CI's *VFS table is current* fails on a hand edit. Pinned by Task 2 Step 10.
- **`holds('interruptible')` answering differently.** Test selection on 22 pairs rests on it. Pinned by Task 1 Step 1's value assertion — the values are exactly today's `BUILD_DEGRADES_WITHOUT` — and by Task 3's `pnpm test` counts.

---

### Task 1: `BUILD_CAPABILITIES`

**Files:**
- Modify: `src/types.ts` (the `SQLiteBuild` alias, `BUILD_REQUIREMENTS`, `BUILD_DEGRADES_WITHOUT`)
- Modify: `src/capabilities.ts` (`missingFeature`, `describeMissing`, imports)
- Modify: `scripts/render-vfs-matrix.ts` (imports, the jspi floor, `BUILDS`, `buildTable`)
- Modify: `tests/browser/target.ts`, `tests/browser/features.test.ts`, `tests/conformance/helpers.ts`, `tests/unit/test-target.test.ts`
- Test: `tests/unit/capabilities.test.ts`

**Interfaces:**
- Consumes: `PlatformFeature` (unchanged, `src/types.ts`).
- Produces, in `src/types.ts`: `export type BuildCapability = { readonly requires: readonly PlatformFeature[]; readonly interruptibleWithout: readonly PlatformFeature[] }`, `export const BUILD_CAPABILITIES` (keys `sync`, `async`, `jspi`), `export type SQLiteBuild = keyof typeof BUILD_CAPABILITIES`. `BUILD_REQUIREMENTS` and `BUILD_DEGRADES_WITHOUT` no longer exist.

- [ ] **Step 0: Save the surface before any code change**

```bash
cd /workspaces/wsqlite
S=/tmp/claude-1000/-workspaces-wsqlite/c78afeb5-91f2-42b6-b87d-b75787357881/scratchpad
pnpm build
rm -rf "$S/dist-before" && cp -r dist "$S/dist-before"
node "$S/surface.mjs" dist > "$S/surface-before.txt"
head -1 "$S/surface-before.txt"
```

Expected: `# public exports (44)`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/capabilities.test.ts`, replace the import of `BUILD_DEGRADES_WITHOUT, BUILD_REQUIREMENTS, type PlatformFeature` from `'../../src/types'` with:

```ts
import { BUILD_CAPABILITIES, type PlatformFeature } from '../../src/types';
```

In `'gives every declared feature either a probe or an explicit exemption'`, replace the `BUILD_REQUIREMENTS` loop with:

```ts
    for (const cap of Object.values(BUILD_CAPABILITIES)) {
      for (const f of cap.requires) declared.add(f);
      for (const f of cap.interruptibleWithout) declared.add(f);
    }
```

Replace the test `'declares which build degrades without which feature'` whole with:

```ts
  it('declares which build cannot be interrupted without which feature', () => {
    expect(BUILD_CAPABILITIES.sync.interruptibleWithout).toEqual([
      'cross-origin-isolated',
    ]);
    expect(BUILD_CAPABILITIES.async.interruptibleWithout).toEqual([]);
    expect(BUILD_CAPABILITIES.jspi.interruptibleWithout).toEqual([]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec rstest --project unit run tests/unit/capabilities.test.ts`
Expected: FAIL — `BUILD_CAPABILITIES` is undefined (`Cannot read properties of undefined` / `Cannot convert undefined or null to object`).

- [ ] **Step 3: Replace the build tables in `src/types.ts`**

Delete, as one block: the `/** Which wa-sqlite WebAssembly build a worker loads. */` alias `SQLiteBuild`, the JSDoc and body of `BUILD_REQUIREMENTS` (the objection comment goes with it — it is measurably false, spec § 1), and the JSDoc and body of `BUILD_DEGRADES_WITHOUT`. Insert in their place:

```ts
/** What a build needs from the engine, and what it loses without it. */
export type BuildCapability = {
  /** Platform features this build cannot run without, beyond plain WebAssembly. */
  readonly requires: readonly PlatformFeature[];
  /**
   * Platform features without which a running statement cannot be interrupted.
   * The `sync` build carries an abort into `step()` through a SharedArrayBuffer,
   * which is absent outside a cross-origin isolated context (measured
   * 2026-09-04). COOP/COEP and Document-Isolation-Policy all satisfy the probe.
   */
  readonly interruptibleWithout: readonly PlatformFeature[];
};

/**
 * The build registry. Every other build-keyed table is typed against its keys,
 * so a build missing from one, or extra in one, fails to compile. Preference
 * order is per VFS, in `VFS_CAPABILITIES[vfs].builds`.
 */
export const BUILD_CAPABILITIES = {
  sync: { requires: [], interruptibleWithout: ['cross-origin-isolated'] },
  async: { requires: [], interruptibleWithout: [] },
  jspi: { requires: ['jspi'], interruptibleWithout: [] },
} as const satisfies Record<string, BuildCapability>;

/** Which wa-sqlite WebAssembly build a worker loads. */
export type SQLiteBuild = keyof typeof BUILD_CAPABILITIES;
```

`Record<string, …>`, never `Record<SQLiteBuild, …>` (circular) and never a type annotation (widens `SQLiteBuild` to `string`).

- [ ] **Step 4: Move every reader**

`src/capabilities.ts` — import `BUILD_CAPABILITIES` instead of `BUILD_REQUIREMENTS`; in `missingFeature`, `...BUILD_REQUIREMENTS[build],` → `...BUILD_CAPABILITIES[build].requires,`; in `describeMissing`:

```ts
    (BUILD_CAPABILITIES[build].requires as readonly PlatformFeature[]).includes(
      feature,
    )
```

`scripts/render-vfs-matrix.ts` — import `BUILD_CAPABILITIES` instead of `BUILD_REQUIREMENTS`, then:
- `floorOf([...cap.requires, ...BUILD_REQUIREMENTS.jspi], browser)` → `floorOf([...cap.requires, ...BUILD_CAPABILITIES.jspi.requires], browser)`
- `const BUILDS = Object.keys(BUILD_REQUIREMENTS) as SQLiteBuild[];` → `const BUILDS = Object.keys(BUILD_CAPABILITIES) as SQLiteBuild[];`
- in `buildTable`: `const features = BUILD_REQUIREMENTS[build];` → `const features = BUILD_CAPABILITIES[build].requires;`

`tests/browser/target.ts` — import `BUILD_CAPABILITIES` instead of `BUILD_DEGRADES_WITHOUT` and `BUILD_REQUIREMENTS`; in `runsHere`, `...(BUILD_REQUIREMENTS[build] as readonly PlatformFeature[]),` → `...(BUILD_CAPABILITIES[build].requires as readonly PlatformFeature[]),`; the `'interruptible'` case becomes, its ten-line comment deleted:

```ts
    case 'interruptible':
      return allHere(BUILD_CAPABILITIES[build].interruptibleWithout, here);
```

`tests/browser/features.test.ts` — import `BUILD_CAPABILITIES` instead of `BUILD_REQUIREMENTS`; `...BUILD_REQUIREMENTS[TEST_TARGET.build],` → `...BUILD_CAPABILITIES[TEST_TARGET.build].requires,`.

`tests/conformance/helpers.ts` — import `BUILD_CAPABILITIES` instead of `BUILD_REQUIREMENTS`; in `missingHere`, `...(BUILD_REQUIREMENTS[build] as readonly PlatformFeature[]),` → `...(BUILD_CAPABILITIES[build].requires as readonly PlatformFeature[]),`; in its JSDoc, `` or to `BUILD_REQUIREMENTS` `` → `` or to a build's `requires` ``.

`tests/unit/test-target.test.ts` — import `BUILD_CAPABILITIES` instead of `BUILD_REQUIREMENTS`; `...BUILD_REQUIREMENTS[found.build],` → `...BUILD_CAPABILITIES[found.build].requires,`; `BUILD_REQUIREMENTS.jspi[0],` → `BUILD_CAPABILITIES.jspi.requires[0],`; `here([...noJspi.features, ...BUILD_REQUIREMENTS.jspi])` → `here([...noJspi.features, ...BUILD_CAPABILITIES.jspi.requires])`.

Then: `grep -rn "BUILD_REQUIREMENTS\|BUILD_DEGRADES_WITHOUT" src tests scripts` → no output.

- [ ] **Step 5: Format, type-check, run the tests**

```bash
pnpm exec biome check --write src/types.ts src/capabilities.ts scripts/render-vfs-matrix.ts tests/browser/target.ts tests/browser/features.test.ts tests/conformance/helpers.ts tests/unit/test-target.test.ts tests/unit/capabilities.test.ts
pnpm exec tsc --noEmit
pnpm exec rstest --project unit run
```

Expected: `tsc` clean; unit **519** passed, 0 failed.

- [ ] **Step 6: Falsify the registry check, then restore**

Add `wasm64: () => import('wa-sqlite/dist/wa-sqlite.mjs'),` to `WA_SQLITE_BUILDS` in `src/worker/worker.ts`, run `pnpm exec tsc --noEmit`. Expected: an error on `wasm64` (excess property, TS2353 or TS2561). Remove the line; `git diff --stat src/worker/worker.ts` → empty.

- [ ] **Step 7: The generator still renders the same `VFS.md`**

Run: `pnpm docs:vfs && git diff --exit-code VFS.md`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/capabilities.ts scripts/render-vfs-matrix.ts tests/browser/target.ts tests/browser/features.test.ts tests/conformance/helpers.ts tests/unit/test-target.test.ts tests/unit/capabilities.test.ts
git commit -m "refactor: one BUILD_CAPABILITIES registry, SQLiteBuild its keys

BUILD_REQUIREMENTS and BUILD_DEGRADES_WITHOUT become the fields of one
table, and SQLiteBuild is derived from its keys as SQLiteVFS is from
VFS_CAPABILITIES. WA_SQLITE_BUILDS and BUILD_NOTE, typed against
SQLiteBuild, are now checked against the registry both ways.

The build-level degradation is named for what it is: interruptibleWithout.
holds('interruptible') reads it instead of reading the whole degradation
list, which was only equivalent while sync had one entry. No build-level
degradesWithout remains; nothing read one.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The split

**Files:**
- Create: `src/const/platform.ts`, `src/const/builds.ts`, `src/const/vfs.ts`, `src/types/protocol.ts`
- Move: `src/sqlite-codes.ts` → `src/const/sqlite.ts`, `src/errors.ts` → `src/types/errors.ts`
- Delete: `src/types.ts`
- Modify: every importer listed in Step 6, `src/index.ts`, `scripts/render-vfs-matrix.ts` (marker), `VFS.md` (regenerated), and the comments in Step 8

**Interfaces:**
- Consumes: Task 1's `BuildCapability`, `BUILD_CAPABILITIES`, `SQLiteBuild`.
- Produces — where each name lives from now on:

| Name | Module |
|---|---|
| `PlatformFeature` | `src/const/platform.ts` |
| `BuildCapability`, `BUILD_CAPABILITIES`, `SQLiteBuild` | `src/const/builds.ts` |
| `VFSStorage`, `VFSMemoryModel`, `VFSCapability`, `VFS_CAPABILITIES`, `folderOf`, `SQLiteVFS`, `defaultBuildFor` | `src/const/vfs.ts` |
| `SQLITE_CODES`, `SQLITE_EXTENDED_CODES`, `SQLiteResultCode`, `SQLiteExtendedResultCode` | `src/const/sqlite.ts` |
| `SQLiteErrorCode`, `SQLiteError`, `SQLiteBulkWriteError` | `src/types/errors.ts` |
| `SQLiteWorkerMessageData`, `SQLWorkerResultData`, `SharedArrayTypes`, `SavepointOp`, `SQLOptions` (unexported, as today), `WasmLocation`, `ClientMessageData`, `WorkerMessageData` | `src/types/protocol.ts` |

- [ ] **Step 1: Move the two whole files**

```bash
mkdir -p src/const src/types
git mv src/sqlite-codes.ts src/const/sqlite.ts
git mv src/errors.ts src/types/errors.ts
```

In `src/types/errors.ts`, `} from './sqlite-codes';` → `} from '../const/sqlite';`.

- [ ] **Step 2: `src/const/platform.ts`**

Move `PlatformFeature` with its JSDoc from `src/types.ts`, verbatim. No import.

- [ ] **Step 3: `src/const/builds.ts`**

```ts
import type { PlatformFeature } from './platform';
```

then `BuildCapability`, `BUILD_CAPABILITIES`, `SQLiteBuild` with their JSDoc, verbatim from `src/types.ts` (as Task 1 wrote them).

- [ ] **Step 4: `src/const/vfs.ts`**

```ts
import type { SQLiteBuild } from './builds';
import type { PlatformFeature } from './platform';
```

then, verbatim and in today's order: `VFSStorage`, `VFSMemoryModel`, `VFSCapability`, `VFS_CAPABILITIES`, `folderOf`, `SQLiteVFS`, `defaultBuildFor`.

- [ ] **Step 5: `src/types/protocol.ts`, then delete `src/types.ts`**

```ts
import type { SQLiteBuild } from '../const/builds';
import type { PlatformFeature } from '../const/platform';
import type { SQLiteResultCode } from '../const/sqlite';
import type { SQLiteVFS } from '../const/vfs';
import type { SQLiteErrorCode } from './errors';
```

then everything `src/types.ts` still holds — `SQLiteWorkerMessageData` through `WorkerMessageData` — verbatim, `SQLOptions` still unexported. `src/types.ts` is now empty of declarations:

```bash
git rm -q src/types.ts
```

- [ ] **Step 6: Rewrite every import**

Each importer imports each name from the module in the Interfaces table, keeping `type` modifiers as they are. Relative depth follows the importer; `scripts/` and `tests/target-projects.ts` keep the explicit `.ts` extension they use today. The importers:

- `src/`: `api.ts`, `bulk.ts`, `capabilities.ts`, `client.ts`, `debug.ts`, `delete.ts`, `epochs.ts`, `inspect.ts`, `locks.ts`, `pool.ts`, `transaction.ts`, `utils.ts`
- `src/worker/`: `probes.ts`, `sqlite-code.ts`, `worker.ts`
- `tests/unit/`: `bulk.test.ts`, `capabilities.test.ts`, `errors.test.ts`, `quoting.test.ts`, `sqlite-codes.test.ts`, `statement-error.test.ts`, `test-target.test.ts`, `transaction.test.ts`, `utils.test.ts`
- `tests/browser/`: `delete.test.ts`, `exclusive-connection.test.ts`, `features.test.ts`, `helpers.ts`, `helpers/vfs-contract.ts`, `inspect-client.test.ts`, `inspect-marker.test.ts`, `pool-savepoint.test.ts`, `second-client.test.ts`, `statement-errors.test.ts`, `target.ts`, `tx-savepoint.test.ts`, `vfs-folders.test.ts`, `vfs.test.ts`, `write-lock-reclaim.test.ts`
- `tests/conformance/`: `builds.test.ts`, `folders.test.ts`, `helpers.ts`, `invariants.test.ts`
- `tests/target-projects.ts`
- `scripts/`: `recommended-vfs.ts`, `render-vfs-matrix.ts`, `test-matrix.mjs`

Example — `src/worker/worker.ts` today:

```ts
import type { SQLiteErrorCode } from '../errors';
import {
  type ClientMessageData,
  defaultBuildFor,
  folderOf,
  type PlatformFeature,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
  type WasmLocation,
  type WorkerMessageData,
} from '../types';
```

becomes:

```ts
import type { SQLiteBuild } from '../const/builds';
import type { PlatformFeature } from '../const/platform';
import {
  defaultBuildFor,
  folderOf,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../const/vfs';
import type { SQLiteErrorCode } from '../types/errors';
import type {
  ClientMessageData,
  WasmLocation,
  WorkerMessageData,
} from '../types/protocol';
```

Then prove nothing points at the old paths:

```bash
grep -rnE "from ['\"](\.\.?/)+(src/)?(types|errors|sqlite-codes)(\.ts)?['\"]" src tests scripts
```

Expected: no output.

- [ ] **Step 7: `src/index.ts`**

Replace the `./errors`, `./sqlite-codes` and `./types` exports and the comment above the last one with:

```ts
export { type SQLiteBuild } from './const/builds';
export { type PlatformFeature } from './const/platform';
export {
  SQLITE_CODES,
  SQLITE_EXTENDED_CODES,
  type SQLiteExtendedResultCode,
  type SQLiteResultCode,
} from './const/sqlite';
export {
  defaultBuildFor,
  folderOf,
  type SQLiteVFS,
  VFS_CAPABILITIES,
  type VFSCapability,
  type VFSMemoryModel,
  type VFSStorage,
} from './const/vfs';
// Nothing exports from `./types/protocol`: the wire protocol stays internal.
export * from './types/errors';
```

The other exports (`./api`, `./capabilities`, `./client`, `./delete`, `./inspect`) and the header comment stay as they are; biome orders the statements.

- [ ] **Step 8: Comments that name the old files**

- `src/api.ts` header: `` `types.ts` keeps the wire protocol and the VFS capability table. `` → `` The wire protocol is in `types/protocol.ts`, the VFS capability table in `const/vfs.ts`. ``
- `src/worker/worker.ts`, JSDoc of `VFSConfigs`: `` (`src/types.ts`) `` → `` (`src/const/vfs.ts`) ``
- `tests/browser/vfs.test.ts`: `` `VFS_CAPABILITIES` in `types.ts` `` → `` `VFS_CAPABILITIES` in `const/vfs.ts` ``
- `tests/browser/default-pragmas.test.ts`: `` `defaultPragmas` in types.ts `` → `` `defaultPragmas` in const/vfs.ts ``
- `tests/unit/errors.test.ts`: `in errors.ts` → `in types/errors.ts`; `in src/errors.ts` → `in src/types/errors.ts`
- `scripts/render-vfs-matrix.ts`, `BEGIN`: `edit VFS_CAPABILITIES in src/types.ts` → `edit VFS_CAPABILITIES in src/const/vfs.ts`

Then: `grep -rnE "src/types\.ts|[^/]types\.ts|src/errors\.ts|[^/]errors\.ts|sqlite-codes\.ts" src tests scripts` → no output. (`types/errors.ts` and `sqlite-codes.test.ts` do not match; the test files keep their names.)

- [ ] **Step 9: Node loads `const/` on its own**

```bash
node --input-type=module -e "const v = await import('./src/const/vfs.ts'); const b = await import('./src/const/builds.ts'); console.log(Object.keys(b.BUILD_CAPABILITIES).join(','), Object.keys(v.VFS_CAPABILITIES).length)"
```

Expected: `sync,async,jspi 9`.

- [ ] **Step 10: Regenerate `VFS.md`**

Run: `pnpm docs:vfs && git diff VFS.md`
Expected: one line changed — the `BEGIN GENERATED VFS TABLE` marker, now naming `src/const/vfs.ts`.

- [ ] **Step 11: Format, type-check, unit, lint**

```bash
pnpm exec biome check --write src tests scripts
pnpm exec tsc --noEmit
pnpm exec rstest --project unit run
pnpm exec biome ci .
ls src
```

Expected: `tsc` clean; unit **519**; `biome ci` exit 0; `ls src` shows neither `types.ts`, `errors.ts` nor `sqlite-codes.ts`, and shows `const` and `types`.

- [ ] **Step 12: Commit**

```bash
git add -A src tests scripts VFS.md
git status --short
git commit -m "refactor: split types.ts into const/ and types/

Platform, build and VFS declarations move to src/const/, each type
beside the const it derives from; sqlite-codes.ts becomes
const/sqlite.ts. The wire protocol and the errors move to src/types/.
src/types.ts is gone, with no barrel in its place: the protocol is
internal because nothing exports it, not because index.ts lists
around it.

Declarations move verbatim. The public surface is unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Check `git status --short` before committing: only renames, the four new files, the deleted `src/types.ts`, and modifications.

---

### Task 3: Verification

**Files:** none committed.

- [ ] **Step 1: Build and dump the new surface**

```bash
S=/tmp/claude-1000/-workspaces-wsqlite/c78afeb5-91f2-42b6-b87d-b75787357881/scratchpad
rm -rf dist && pnpm build
node "$S/surface.mjs" dist > "$S/surface-after.txt"
```

`rm -rf dist` first: rslib does not remove the stale `dist/types.d.ts`, `errors.d.ts`, `sqlite-codes.d.ts`, which would otherwise show as duplicate declarations.

- [ ] **Step 2: The public names are identical**

```bash
diff <(sed -n '/^# public/,/^$/p' "$S/surface-before.txt") <(sed -n '/^# public/,/^$/p' "$S/surface-after.txt")
```

Expected: no output, exit 0.

- [ ] **Step 3: The declarations differ only where Task 1 said**

```bash
diff "$S/surface-before.txt" "$S/surface-after.txt"
```

Expected, and nothing else: the declaration count line; `## BUILD_DEGRADES_WITHOUT` and `## BUILD_REQUIREMENTS` removed; `## BUILD_CAPABILITIES` and `## BuildCapability` added; `## SQLiteBuild`'s body `'sync' | 'async' | 'jspi'` → `keyof typeof BUILD_CAPABILITIES`. Any other difference is a defect to fix before going on.

- [ ] **Step 4: The type-level equality**

```bash
cat > "$S/check.ts" <<'EOF'
import type * as B from './dist-before/index';
import type * as A from '/workspaces/wsqlite/dist/index';
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const ok = <T extends true>() => {};
ok<Equals<B.SQLiteBuild, A.SQLiteBuild>>();
ok<Equals<A.SQLiteBuild, 'sync' | 'async' | 'jspi'>>();
ok<Equals<B.PlatformFeature, A.PlatformFeature>>();
ok<Equals<B.VFSCapability, A.VFSCapability>>();
ok<Equals<typeof B.VFS_CAPABILITIES, typeof A.VFS_CAPABILITIES>>();
ok<Equals<B.SQLiteErrorCode, A.SQLiteErrorCode>>();
ok<Equals<typeof B.defaultBuildFor, typeof A.defaultBuildFor>>();
EOF
pnpm exec tsc --ignoreConfig --noEmit --strict --skipLibCheck --module preserve --moduleResolution bundler --target esnext --lib esnext,dom "$S/check.ts"
```

Expected: exit 0, no output.

- [ ] **Step 5: The 2026-09-24 baseline, in one pass**

| command | expected |
|---|---|
| `pnpm exec tsc --noEmit` | clean |
| `pnpm exec biome ci .` | exit 0 |
| `pnpm exec rstest --project unit run` | 519 / 27 files |
| `pnpm test` | three reports, `failedFiles: 0` each: 1255 / 81 files (8 skipped), 738 / 55 (2 skipped), 14 / 3 (0 skipped) |
| `pnpm test:conformance` | Chromium 83 passed / 14 skipped, Firefox 79 / 18 — 97 tests / 3 files each |
| `pnpm test:consumer` | 24/24 stages |
| `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.mjs chromium --all` | `OK`, `"reasons": {}` |
| `pnpm lint` | 13 warnings, 1 info |
| `pnpm docs:vfs && git diff --exit-code VFS.md` | exit 0 |

`pnpm test` runs several minutes: launch it with a progress monitor. A Firefox `Browser page crashed` on `tests/browser/lifecycle.test.ts` is a known open flake (`mem:follow-ups`, two sightings 2026-09-23): re-run that file alone and report both results, do not count it as a pass.

- [ ] **Step 6: Report**

Every number above, read off this run, beside its expected value. No commit.
