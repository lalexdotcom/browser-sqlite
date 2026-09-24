# The public surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The package entry exports only what a consumer can use, declares no subpath but `.`, and prints `SQLiteDB` as the return type of `createSQLiteClient`.

**Architecture:** Task 1 moves the bench page off the exported table first — the assembler writes the table as a module beside the page — so that Task 2 can remove the exports without reddening the path-import guard. Task 2 is the whole surface change in one green commit: exports, `package.json`, the exports test, and every document that names a removed symbol. Task 3 annotates the client's return type. Task 4 takes the `const/` split's internal leftovers. Task 5 is the delivery verification and the memories.

**Tech Stack:** TypeScript 7 (native), rslib, rstest (browser mode on Playwright Chromium and Firefox), biome, pnpm, Node 24 (strips types when a script imports a `.ts` file).

**Spec:** `docs/superpowers/specs/2026-09-24-public-surface-design.md`

## Global Constraints

- **Serena tools are primary for code** (AGENTS.md). Explore with `get_symbols_overview`, read with `find_symbol` (`include_body`), edit with `replace_symbol_body` / `insert_*_symbol` / `replace_content`. Built-in Read/Edit on code files only when Serena fails. Read/Edit are fine on `.md`, JSON, config — and on `scripts/bench/html/index.html`, which Serena cannot parse.
- **After the change the entry exports exactly these values:** `createSQLiteClient`, `deleteDatabase`, `inspectDatabase`, `detectFeatures`, `missingFeature`, `SQLiteError`, `SQLiteBulkWriteError`, `SQLITE_CODES`, `SQLITE_EXTENDED_CODES`.
- **Removed from the entry:** `VFS_CAPABILITIES`, `VFSCapability`, `VFSStorage`, `VFSMemoryModel`, `defaultBuildFor`, `folderOf`. **Removed from `package.json` `exports`:** `"./worker"`. **Not exported:** `ClientDebugState` (it is `@internal` on `SQLiteDB.debug`).
- **Kept exported, unchanged:** `export * from './api'` (so `Index`, `Interruptible`, `SQLiteQueryAPI` stay), `SQLiteVFS`, `SQLiteBuild`, `PlatformFeature`.
- **The removed symbols stay in the source.** Tests and scripts import `src/const/vfs.ts` and `src/capabilities.ts` directly and are not touched.
- **The release notes announce nothing this release removes from the surface (user).** The `folder` field of the table and `folderOf` were added after rc.5 and never reach a release: no CHANGELOG entry may mention either.
- **After every modification:** `pnpm exec biome check --write <touched files>`.
- **Comments state the fact, one or two lines**; the reasoning goes to the commit message.
- **Markdown prose is not hard-wrapped** — a paragraph you write or rewrite is one line. **No counts in docs or comments** ("the VFS above", never "the four VFS"). Commit messages are wrapped at 72 and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`.** Run `pnpm exec tsc --noEmit` yourself before each commit; if the hook fails, stop and report its output verbatim; after committing, confirm with `git log --oneline -1` and `git show --stat HEAD`.
- **Scratch files go in `.scratchpad/public-surface/`** at the repository root (gitignored). Nothing in `src/`, `tests/` or `scripts/` may depend on it.

## Review Focus

- **The Pages workflow assembles the published tag with the current assembler.** `.github/workflows/pages.yaml` copies `scripts/bench/assemble.mjs` into the rc.5 checkout, which has no `src/const/vfs.ts` and whose page imports the table from `dist/`. That run must still succeed. Pinned by Task 1 Step 5, which assembles rc.5's page with the new script.
- **`bench:dev` rebuilds on every page edit.** The table module must be rewritten on each assembly, since the assembler starts with `rmSync(target)`. Pinned by Task 1's implementation (written on every run the page asks for it) and Step 4's check.
- **A consumer still importing `browser-sqlite/worker`** gets a resolution error from its bundler. Intended; announced in the CHANGELOG (Task 2 Step 7).
- **The declaration file after the annotation.** `dist/client.d.ts` must print `=> SQLiteDB`, and `SQLiteDB` must still resolve for a consumer. Pinned by Task 3 Step 4 and by the consumer smoke in Task 5, whose TypeScript apps compile against `dist/`.
- **Parcel resolves through `main`, not `exports`.** Dropping `./worker` must not touch `main`. Pinned by the consumer smoke (Task 5), whose Parcel mode exists for this reason.

---

### Task 1: The bench page takes the VFS table from the assembler

**Files:**
- Modify: `scripts/bench/assemble.mjs` (after the `cpSync` of `dist/`, around line 125)
- Modify: `scripts/bench/html/index.html:284-290` (the module import)

**Interfaces:**
- Produces: `<outDir>/vfs-capabilities.js`, an ES module exporting `VFS_CAPABILITIES` (the table from `src/const/vfs.ts`, as JSON). Task 2 relies on the page no longer importing `VFS_CAPABILITIES` from `./dist/index.js`.

- [ ] **Step 1: Change the page's import**

In `scripts/bench/html/index.html`, replace

```js
      import {
        createSQLiteClient,
        deleteDatabase,
        detectFeatures,
        missingFeature,
        VFS_CAPABILITIES,
      } from './dist/index.js';
```

with

```js
      import {
        createSQLiteClient,
        deleteDatabase,
        detectFeatures,
        missingFeature,
      } from './dist/index.js';
      import { VFS_CAPABILITIES } from './vfs-capabilities.js';
```

Nothing else in the page changes.

- [ ] **Step 2: Write the module from the assembler**

In `scripts/bench/assemble.mjs`, add `pathToFileURL` to the existing `node:url` import (`import { fileURLToPath, pathToFileURL } from 'node:url';`), then insert after `cpSync(join(root, 'dist'), join(target, 'dist'), { recursive: true });`:

```js
// The package does not export the VFS table; the page imports it from here.
// A page that does not import it — a released tree assembled by pages.yaml — gets no file.
const TABLE_MODULE = 'vfs-capabilities.js';
if (page.includes(`./${TABLE_MODULE}`)) {
  const { VFS_CAPABILITIES } = await import(
    pathToFileURL(join(root, 'src/const/vfs.ts')).href
  );
  writeFileSync(
    join(target, TABLE_MODULE),
    `// Generated by scripts/bench/assemble.mjs from src/const/vfs.ts.\nexport const VFS_CAPABILITIES = ${JSON.stringify(VFS_CAPABILITIES, null, 2)};\n`,
  );
}
```

Update the file's header comment: its sentence "The only transformation is substituting __LIB_VERSION__" is no longer the only one — add one line saying the VFS table is written beside the page as `vfs-capabilities.js`.

Run: `pnpm exec biome check --write scripts/bench/assemble.mjs scripts/bench/html/index.html`

- [ ] **Step 3: Build and inspect the output**

Run: `pnpm bench:build && head -3 _site/vfs-capabilities.js && node --input-type=module -e "import('./_site/vfs-capabilities.js').then(m => console.log(Object.keys(m.VFS_CAPABILITIES).length))"`
Expected: the header comment, `export const VFS_CAPABILITIES = {`, the first VFS key; then `9`.

- [ ] **Step 4: Drive the page on both engines**

Run: `BENCH_PORT=8199 node scripts/bench/check.mjs chromium` then `BENCH_PORT=8199 node scripts/bench/check.mjs firefox`
Expected: both report the page working (the driver asserts the page, not the VFS results). A failure to load `./vfs-capabilities.js` shows as the page never starting.

- [ ] **Step 5: Assemble rc.5's page with the new script**

This is what `pages.yaml` does on its next run. No install and no build are needed: the assembler only copies `dist/`.

```bash
S=.scratchpad/public-surface/rc5
rm -rf "$S" && mkdir -p "$S/scripts/bench/html" "$S/dist"
git show v1.0.0-rc.5:scripts/bench/html/index.html > "$S/scripts/bench/html/index.html"
git show v1.0.0-rc.5:package.json > "$S/package.json"
cp scripts/bench/assemble.mjs "$S/scripts/bench/assemble.mjs"
node "$S/scripts/bench/assemble.mjs" "$S/_site" --ref v1.0.0-rc.5 --release && ls "$S/_site"
```

Expected: `assembled … RELEASE build (v1.0.0-rc.5)`, and `ls` shows `dist` and `index.html` with **no** `vfs-capabilities.js`.

Then the loud case — a page that needs the module where the source is missing:

```bash
sed -i "s#} from './dist/index.js';#} from './dist/index.js';\nimport { VFS_CAPABILITIES } from './vfs-capabilities.js';#" "$S/scripts/bench/html/index.html"
node "$S/scripts/bench/assemble.mjs" "$S/_site" --ref x; echo "exit $?"
```

Expected: `ERR_MODULE_NOT_FOUND` naming `src/const/vfs.ts`, and a non-zero exit.

- [ ] **Step 6: Commit**

Run `pnpm exec tsc --noEmit` first (expected: clean).

```bash
git add scripts/bench/assemble.mjs scripts/bench/html/index.html
git commit -m "feat(bench): the page takes the VFS table from the assembler

The page imported VFS_CAPABILITIES from the package entry, which made
it the table's only reader through the export and kept every field of
the table public contract. The assembler now writes the table beside
the page as vfs-capabilities.js, read from src/const/vfs.ts.

It writes the module only when the page imports it: pages.yaml runs
the current assembler over the published tag, whose page still takes
the table from its own dist/ and whose tree has no src/const/. A page
that needs the module where the source is missing fails the run on
the import rather than shipping a page that cannot load.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Remove what has no consumer from the entry and the exports map

**Files:**
- Modify: `src/index.ts`
- Modify: `package.json:31-38` (`exports`)
- Modify: `tests/unit/exports.test.ts`
- Modify: `src/client.ts:328-333` (the two `@throws` of `createSQLiteClient`)
- Modify: `src/api.ts:439` (the doc comment of `build`)
- Modify: `VFS.md:269` (last sentence of the paragraph under "Builds reference")
- Modify: `CHANGELOG.md` (`## Unreleased`, `### Breaking`)

**Interfaces:**
- Consumes: Task 1 — the bench page no longer imports `VFS_CAPABILITIES` from `./dist/index.js`.
- Produces: the entry of the Global Constraints. Tasks 3–5 rely on `tests/unit/exports.test.ts` pinning it.

- [ ] **Step 1: Rewrite the entry tests**

In `tests/unit/exports.test.ts`:

1. Add `import { VFS_CAPABILITIES } from '../../src/const/vfs';` beside the existing imports.
2. Move `const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');` from its current place (below the first `describe`) to just above the first `describe`, unchanged.
3. Replace the doc comment above `describe('public entry', …)` and the whole `describe('public entry', …)` block with:

```ts
/**
 * What the package entry exports at runtime, exactly. A name added to or
 * dropped from `src/index.ts` changes the public contract and must show here.
 */
describe('public entry', () => {
  // Falsifiable: re-export VFS_CAPABILITIES from src/index.ts, or drop deleteDatabase.
  it('exports exactly the public values', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'SQLITE_CODES',
        'SQLITE_EXTENDED_CODES',
        'SQLiteBulkWriteError',
        'SQLiteError',
        'createSQLiteClient',
        'deleteDatabase',
        'detectFeatures',
        'inspectDatabase',
        'missingFeature',
      ].sort(),
    );
  });

  // Falsifiable: drop either re-export from src/index.ts.
  it('exposes the SQLite result codes, primary and extended', () => {
    expect(api.SQLITE_CODES.CONSTRAINT).toBe(19);
    expect(api.SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE).toBe(2067);
  });

  // Falsifiable: restore "./worker" in package.json's exports.
  it('declares no subpath but the entry', () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'package.json'), 'utf8'),
    );
    expect(Object.keys(pkg.exports)).toEqual(['.']);
  });
});

// Falsifiable: re-export one of these from src/index.ts; tsc then reports an unused directive.
// @ts-expect-error VFSCapability is not exported
type _NoVFSCapability = api.VFSCapability;
// @ts-expect-error VFSStorage is not exported
type _NoVFSStorage = api.VFSStorage;
// @ts-expect-error VFSMemoryModel is not exported
type _NoVFSMemoryModel = api.VFSMemoryModel;

describe('VFS_CAPABILITIES', () => {
  // Falsifiable: drop one VFS from VFS_CAPABILITIES.
  it('wires every VFS', () => {
    expect(Object.keys(VFS_CAPABILITIES).sort()).toEqual(
      [
        'AccessHandlePoolVFS',
        'IDBBatchAtomicVFS',
        'IDBMirrorVFS',
        'MemoryAsyncVFS',
        'MemoryVFS',
        'OPFSAdaptiveVFS',
        'OPFSAnyContextVFS',
        'OPFSCoopSyncVFS',
        'OPFSWriteAheadVFS',
      ].sort(),
    );
  });
});
```

The removed tests ("still exposes the client and the error type", "exposes the capability probes the benchmark page needs", and the `DEFAULT_VFS` / `RECOMMENDED_VFS` / `BulkWriteError` absence checks) are subsumed by the exact list. The `_PinClientToTx` block and the `files that import the entry by path` block stay as they are.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec rstest --project unit exports`
Expected: FAIL — "exports exactly the public values" receives `VFS_CAPABILITIES`, `defaultBuildFor`, `folderOf` in addition; "declares no subpath but the entry" receives `['.', './worker']`.

Run: `pnpm exec tsc --noEmit`
Expected: three `TS2578: Unused '@ts-expect-error' directive` in `tests/unit/exports.test.ts`.

- [ ] **Step 3: Remove the exports**

`src/index.ts` — replace the `./capabilities` and `./const/vfs` blocks with:

```ts
export { detectFeatures, missingFeature } from './capabilities';
```

and

```ts
export type { SQLiteVFS } from './const/vfs';
```

`package.json` — `exports` becomes:

```json
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js",
			"default": "./dist/index.js"
		}
	},
```

`main` and `types` stay.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec rstest --project unit exports && pnpm exec tsc --noEmit`
Expected: PASS, and `tsc` clean. The `files that import the entry by path` test passes because of Task 1.

- [ ] **Step 5: Consumer-facing comments stop naming internal symbols**

`src/client.ts`, in the doc comment of `createSQLiteClient`, replace the two `@throws` with:

```ts
 * @throws {SQLiteError} With code `INVALID_OPTION` when `build` is not one of
 *   the builds the chosen `vfs` supports. The message names the supported
 *   builds.
 * @throws {SQLiteError} With code `INVALID_OPTION` when `poolSize` exceeds the
 *   cap the chosen `vfs` declares. The message names the cap and the reason
 *   for it.
```

`src/api.ts`, the comment on `readonly build: SQLiteBuild;` becomes:

```ts
  /** The build actually loaded: the `build` option, or the first build the VFS declares that the browser supports. */
```

- [ ] **Step 6: `VFS.md`**

In the paragraph under `## Builds reference` (line 269), delete the last sentence: "The pairing is declared in one place, `VFS_CAPABILITIES`, which is also what the `SQLiteVFS` type is derived from." The rest of the paragraph stays. The `<!-- BEGIN GENERATED VFS TABLE — edit VFS_CAPABILITIES … -->` marker is for maintainers and stays.

Run: `pnpm docs:vfs && git diff --stat VFS.md && git diff VFS.md | grep '^[-+][^-+]'` — expected: one line changed, and the diff shows only the paragraph losing that sentence (the generator does not own line 269, and regenerating changes nothing else).

- [ ] **Step 7: `CHANGELOG.md`**

Under `## Unreleased` → `### Breaking`, delete these two entries whole:

```md
- **`VFS_CAPABILITIES` loses `layout`, and `VFSLayout` is no longer exported.** `storage` says where a database lives; the new `folder` is set exactly on the VFS above.
```

```md
- **`defaultBuildFor(vfs)` becomes `defaultBuildFor(vfs, available)`**: pass `detectFeatures()`.
```

and append at the end of `### Breaking`:

```md
- **`VFS_CAPABILITIES`, `VFSCapability`, `VFSLayout`, `VFSStorage`, `VFSMemoryModel` and `defaultBuildFor` are no longer exported.** `db.build` reports the build a client resolved; `SQLiteVFS`, `SQLiteBuild` and `PlatformFeature` still name the options.
- **The `browser-sqlite/worker` subpath is gone.** The client starts its worker itself, and no option accepts one.
```

Check: `awk '/^## Unreleased/{f=1} /^## 1\.0\.0-rc\.5/{f=0} f' CHANGELOG.md | grep -n "folder\`\|folderOf\|defaultBuildFor(vfs"` — expected: no output.

- [ ] **Step 8: Build and inspect the published surface**

Run: `pnpm build && grep -c "VFS_CAPABILITIES\|defaultBuildFor\|folderOf" dist/index.d.ts; grep -n '"./worker"' package.json`
Expected: `0`, and no output from the second grep.

- [ ] **Step 9: Commit**

Run `pnpm exec biome check --write src/index.ts src/client.ts src/api.ts tests/unit/exports.test.ts package.json` and `pnpm exec tsc --noEmit` first.

```bash
git add src/index.ts src/client.ts src/api.ts tests/unit/exports.test.ts package.json VFS.md CHANGELOG.md
git commit -m "feat!: the entry exports only what a consumer can use

VFS_CAPABILITIES and its types made every field of the table public
contract, internal ones included, for a single reader: the bench page,
which now gets the table from its assembler. defaultBuildFor has no
caller outside the tests, which import it from src/; db.build reports
the resolved build. folderOf joined the entry after rc.5 and is
removed before any release ships it. The ./worker subpath had no use:
the client spawns its worker by a URL relative to its own module,
which never goes through the exports map.

The runtime exports are now pinned exactly, the removed types by
@ts-expect-error, and package.json's exports by key.

The unreleased CHANGELOG loses the two entries that described changes
to the table and to defaultBuildFor, since this release removes both.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `createSQLiteClient` is declared to return `SQLiteDB`

**Files:**
- Modify: `src/client.ts:350-353` (the signature of `createSQLiteClient`)
- Modify: `CHANGELOG.md` (`## Unreleased`, `### Changed`)

**Interfaces:**
- Consumes: `SQLiteDB` from `src/api.ts`, already imported at `src/client.ts:1`.
- Produces: `dist/client.d.ts` prints `=> SQLiteDB`.

- [ ] **Step 1: See what the declaration prints today**

Run: `grep -n "export declare const createSQLiteClient" -A1 dist/client.d.ts`
Expected: `=> {` followed by `chunk: <T …` — the structural copy.

- [ ] **Step 2: Annotate the return type**

In `src/client.ts`, the signature becomes:

```ts
export const createSQLiteClient = (
  file: string,
  clientOptions: CreateSQLiteClientOptions,
): SQLiteDB => {
```

Nothing else in the function changes.

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: clean (checked on 2026-09-24: the returned object is assignable to `SQLiteDB` and has exactly its keys).

- [ ] **Step 4: Build and inspect**

Run: `pnpm build && grep -n "export declare const createSQLiteClient" dist/client.d.ts && grep -c '"AccessHandlePoolVFS" | "IDBBatchAtomicVFS"' dist/client.d.ts`
Expected: the line ends in `=> SQLiteDB;`, and the count is `0`.

- [ ] **Step 5: `CHANGELOG.md`**

Append at the end of `## Unreleased` → `### Changed`:

```md
- **`createSQLiteClient` is declared to return `SQLiteDB`**, instead of a copy of its members spelled out in the type declarations.
```

- [ ] **Step 6: Commit**

Run `pnpm exec biome check --write src/client.ts` first.

```bash
git add src/client.ts CHANGELOG.md
git commit -m "feat: createSQLiteClient is declared to return SQLiteDB

The returned object was unannotated, so the declaration emitter
printed a structural copy of its members, with vfs and build expanded
to their unions, and nothing checked the object against SQLiteDB. The
return annotation makes the declared type the published one and the
compiler check the object at the return.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The `const/` split's internal leftovers

**Files:**
- Modify: `src/types/protocol.ts:21-25` (delete `SharedArrayTypes`)
- Modify: `src/inspect.ts:1-2`
- Modify: `src/locks.ts:12-13`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks use.

- [ ] **Step 1: Delete `SharedArrayTypes`**

Confirm first: `grep -rn "SharedArrayTypes" src tests scripts` — expected: only its declaration in `src/types/protocol.ts`. Delete it with Serena's `safe_delete_symbol` (it refuses if a reference exists).

- [ ] **Step 2: One import of `./const/vfs` per file**

In `src/inspect.ts`, replace

```ts
import type { SQLiteVFS } from './const/vfs';
import { VFS_CAPABILITIES } from './const/vfs';
```

with

```ts
import { type SQLiteVFS, VFS_CAPABILITIES } from './const/vfs';
```

Same replacement in `src/locks.ts` (lines 12-13, identical text).

- [ ] **Step 3: Check and commit**

Run: `pnpm exec biome check --write src/types/protocol.ts src/inspect.ts src/locks.ts && pnpm exec tsc --noEmit && pnpm test:unit`
Expected: clean, unit project green.

```bash
git add src/types/protocol.ts src/inspect.ts src/locks.ts
git commit -m "refactor: the const/ split's leftovers

SharedArrayTypes had no reference before the split and was moved
verbatim. inspect.ts and locks.ts imported ./const/vfs twice, a type
import then a value import, inherited from ./types.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Delivery verification and memories

**Files:**
- Modify: `.serena/memories/architecture.md` (section "Public surface")
- Modify: `.serena/memories/follow-ups.md`
- Modify: `.serena/memories/state.md`

Memories are edited with Serena's `read_memory` / `edit_memory` / `write_memory`, never by shell or Read/Edit.

- [ ] **Step 1: Full verification**

Run each and read every report:

```bash
pnpm exec tsc --noEmit
pnpm exec biome ci .
pnpm test
pnpm test:consumer
```

Expected: all green. `pnpm test` runs three configs (Chromium, Firefox, isolated); report the counts beside those the last run on `main` produced. `pnpm test:consumer` packs the tarball and drives every bundler mode, Parcel included. The full matrix is not needed: no VFS, build, pool or worker code changes (`mem:conventions`, "When to run the full matrix").

- [ ] **Step 2: `mem:architecture`, "Public surface"**

Replace the sentence that begins "Exported besides:" and ends with "`InspectDatabaseOptions`." with the list from the spec § 1: values `createSQLiteClient`, `deleteDatabase`, `inspectDatabase`, `detectFeatures`, `missingFeature`, `SQLiteError`, `SQLiteBulkWriteError`, `SQLITE_CODES`, `SQLITE_EXTENDED_CODES`; types everything in `src/api.ts` plus `CreateSQLiteClientOptions`, `WorkerLostEvent`, `DeleteDatabaseOptions`, `InspectDatabaseOptions`, `DatabaseInspection`, `ClientInspection`, `InspectionBase`, `DatabaseClient`, `SQLiteVFS`, `SQLiteBuild`, `PlatformFeature`, `SQLiteErrorCode`, `SQLiteResultCode`, `SQLiteExtendedResultCode`. Add: the package declares no subpath but `.`; the runtime list is pinned by `tests/unit/exports.test.ts`; the bench page gets the VFS table from `scripts/bench/assemble.mjs`, which writes it only when the page imports it, because `pages.yaml` runs the current assembler over the published tag.

- [ ] **Step 3: `mem:follow-ups`**

Delete the entry "Unexport `VFS_CAPABILITIES` — the public surface" and the whole section "Left by the BUILD_CAPABILITIES / `const/` split". Keep "`db.debug` — for the documentation review session".

- [ ] **Step 4: `mem:state`**

Remove the obligation that "the public-surface chantier must drop" `defaultBuildFor`'s second parameter from the CHANGELOG — it is done — and add this chantier to the list of what `## Unreleased` carries: Breaking (the removed exports, the `./worker` subpath) and Changed (`createSQLiteClient` declared `SQLiteDB`).

- [ ] **Step 5: Commit**

```bash
git add .serena/memories/architecture.md .serena/memories/follow-ups.md .serena/memories/state.md
git commit -m "docs(memory): the public surface

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
