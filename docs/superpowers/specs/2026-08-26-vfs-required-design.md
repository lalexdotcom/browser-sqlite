# `vfs` becomes required, and the library reads its own capability table

**Date:** 2026-08-26
**Status:** design agreed with the user, ready for an implementation plan.

## 1. Why

Two defects, one cause: the library declares things about platforms and storage and then does not
act on them.

**The default `vfs` places data silently.** `createSQLiteClient` accepts no `vfs` and falls back to
`OPFSAdaptiveVFS` — in two places, `client.ts:400` (`clientOptions?.vfs ?? DEFAULT_VFS`) and
`worker.ts:142` (`const { vfs = 'OPFSAdaptiveVFS' }`). If a future version moved that default,
every consumer who never wrote a VFS name would open a different store and see an empty database.
The bytes would still exist, in a VFS nothing queries. This is `DEFAULT-1`'s argument — *the VFS
decides where the data is written* — turned on the library itself.

**Platform requirements are declared and ignored.** `VFS_CAPABILITIES[vfs].requires` is read by the
README generator, by the benchmark page, and by the conformance helpers. It is **never read by
`src/`**. There are zero platform probes in the shipped code. A consumer who asks for
`build: 'jspi'` on an engine without JSPI passes the client guard — which only checks that the
build is one the *VFS* declares — and fails later, asynchronously, inside a worker, with whatever
Emscripten throws during wasm instantiation.

`ANYCONTEXT-1` was the same shape: a platform requirement (`createWritable`, Safari 26) that
nothing declared and nothing probed, surfacing as `SQLITE_NOTADB` four versions later.

## 2. `vfs` becomes required

`CreateSQLiteClientOptions.vfs` changes from `vfs?: SQLiteVFS` to `vfs: SQLiteVFS`, so the options
argument stops being optional:

```ts
createSQLiteClient(file: string, clientOptions: CreateSQLiteClientOptions)
```

`createSQLiteClient('app.sqlite')` no longer compiles. For a TypeScript consumer the error arrives
at build time, which is the point.

A **synchronous** guard in `client.ts`, beside the existing option guards, throws
`SQLiteError('INVALID_OPTION')`:

> `vfs is required. OPFSAdaptiveVFS is the recommended universal choice and was the previous
> default — pass it to keep reading a database created before this version. Compare VFS in the
> README's VFS Selection guide, and measure your own targets at
> https://lalexdotcom.github.io/browser-sqlite/`

**`INVALID_OPTION` rather than a new code.** A dedicated code would let a migrating consumer catch
this precisely, but they can do nothing with it — the throw happens at construction, before any
database exists — and `SQLiteErrorCode` is a public union whose every addition breaks an exhaustive
`switch`. The project already routes every option guard through `INVALID_OPTION` (`bc1d7d9`). A
required option that is absent is an invalid option.

**Both fallbacks go.** `client.ts:400` loses `?? DEFAULT_VFS`; `worker.ts:142` loses
`= 'OPFSAdaptiveVFS'`. Keeping the worker's would let a JavaScript consumer who bypasses the client
guard land silently in `OPFSAdaptiveVFS` — precisely the silent placement being removed.

**`build` keeps its default.** It does not decide where the bytes live, only how they are reached.
Only the option that moves data becomes required.

### `DEFAULT_VFS` becomes `RECOMMENDED_VFS`, and stops being exported

There is no default any more, so the name lies. The *recommendation* survives — the error message
names it, the README prose names it, the generated table labels it — so one constant must hold it
or three copies will drift.

It is **not exported**. A consumer writing `vfs: RECOMMENDED_VFS` would be exposed to the same
displacement the day the recommendation changes: the same data loss, with a consent of appearance.
The whole point of removing the default is that the VFS name lives in the consumer's own source,
frozen by them. They write `'OPFSAdaptiveVFS'` in full.

Renaming rather than deleting also makes the breaking change do its job: anyone importing
`DEFAULT_VFS` gets a compile error and has to look. The README generator's label changes from
`**(default)**` to `**(recommended)**`.

## 3. The capability guard

### Two registries, one probe table

Requirements arrive on two axes; a single probe table serves both.

```ts
// src/types.ts, beside VFS_CAPABILITIES — same nature, same rule: one copy only.
export const BUILD_REQUIREMENTS = {
  sync: [],
  async: [],
  jspi: ['jspi'],
} as const satisfies Record<SQLiteBuild, readonly PlatformFeature[]>;
```

`SQLiteBuild` stays a literal union rather than `keyof typeof BUILD_REQUIREMENTS`. The `satisfies`
direction is the one that catches the likely mistake: adding a build to the union fails to compile
until its requirements are declared. With `keyof`, a forgotten entry silently means the build does
not exist. `VFS_CAPABILITIES` legitimately derives `SQLiteVFS` from its keys because that table
*is* the VFS registry; `BUILD_REQUIREMENTS` describes one attribute of builds, and the actual build
registry is `WA_SQLITE_BUILDS` in the worker — which keeps its own
`satisfies Record<SQLiteBuild, …>` and thereby checks that every declared build has a loader.

```ts
// src/capabilities.ts — keyed by FEATURE, not by build. That is what lets a VFS
// requirement and a build requirement travel the same path.
const PROBES: Partial<Record<PlatformFeature, () => boolean>> = {
  opfs: () =>
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined',
  jspi: () => typeof WebAssembly.Suspending === 'function',
  'writable-stream': () =>
    typeof FileSystemFileHandle?.prototype?.createWritable === 'function',
};
```

`readwrite-unsafe` has **no synchronous probe** and must be declared unprobeable rather than merely
absent: WebIDL ignores the unknown dictionary member, so asking whether the property is supported
answers yes and is wrong. Detecting it means opening two access handles on one file inside a
dedicated worker, which the benchmark page does asynchronously.

```ts
// Declared, not omitted. A feature in neither table is a mistake, and §5 has the
// test that says so.
const UNPROBEABLE = new Set<PlatformFeature>(['readwrite-unsafe']);
```

### The guard is a pure function

```ts
export const missingFeature = (
  vfs: SQLiteVFS,
  build: SQLiteBuild,
  available: ReadonlySet<PlatformFeature>,
): PlatformFeature | null;

export const detectFeatures = (): ReadonlySet<PlatformFeature>;
```

The client computes `available` via `detectFeatures()` and calls `missingFeature`. **The reason for
the shape is testability of the negative branches**, which are the ones worth testing and which are
unreachable in a real browser — JSPI cannot be taken away from Chromium. With the feature set
injected, every branch becomes a deterministic Node test.

Messages are **derived, never hardcoded**. For a build, `VFS_CAPABILITIES[vfs].builds` names the
alternative; for a VFS feature, the table names the VFS that do not require it:

> `This browser does not support JSPI, which the 'jspi' build requires. OPFSAdaptiveVFS also runs
> on: async.`

> `This browser does not support OPFS, which OPFSAdaptiveVFS requires. Without it, these store
> elsewhere: IDBBatchAtomicVFS, IDBMirrorVFS, MemoryVFS, MemoryAsyncVFS.`

This also removes a special case: `render-vfs-matrix.ts:220` hardcodes
`floorOf([...cap.requires, 'jspi'], browser)`. The generator will read `BUILD_REQUIREMENTS` like
everyone else.

### BENCH-DRIFT: the probe half closes

Without this section the change would make `BENCH-DRIFT` **worse** — `src/` would hold a second
copy of probes the benchmark page already has. The entry's justification ("a self-contained HTML
file cannot import `tests/**`") does not cover it: the page already imports `dist/index.js`.

- **Closed:** the page drops `HAS_JSPI`, `HAS_OPFS`, `HAS_WRITABLE_STREAM` and its own
  `missingFeature`, importing `detectFeatures` and `missingFeature` from the package. Its banner
  reads `features.has('jspi')`.
- **Stays, and permanently:** the six conformance invariants — ~220 lines on each side. Closing
  that half would mean shipping conformance assertions inside the published package, because
  `dist/index.js` is the page's only import channel. It is a design decision, not a debt.
- **Stays, for now:** `HAS_UNSAFE_HANDLES`, which has no synchronous equivalent.

The entry is rewritten to say which half is closed and why the other is permanent.

## 4. The README

All of it lands in `## VFS Selection`, before the generated table: the answer first, the reference
below. The sentence "When `vfs` is omitted, `OPFSAdaptiveVFS` is used." is deleted.

**Prose — three claims and nothing else.** `vfs` is required and there is no default, because the
VFS decides where the bytes live. `OPFSAdaptiveVFS` is the universal choice: across 13 runs on 8
engines it produced **no real failure** — availability and conformance only, not one millisecond.
Write it out and keep it.

**The data-loss sentence**, which the user asked to be concise:

> **Each VFS is a separate store.** A database written through one VFS is not visible through
> another — the bytes are still there, but nothing reads them. Changing `vfs` later does not
> migrate anything.

**The table** is only about reasons to *leave* the universal choice. A "general case" column would
read `OPFSAdaptiveVFS` on every row, and a constant column is prose in disguise.

| Browser you can guarantee | Concurrent reads | Write-heavy workloads |
|---|---|---|
| None — the open web | `OPFSAnyContextVFS` if you can require Safari 26+; otherwise `IDBBatchAtomicVFS` | stay on `OPFSAdaptiveVFS` |
| Chromium 121+ | already the case | `OPFSWriteAheadVFS` |
| Firefox 111+ | `OPFSAnyContextVFS` | stay |
| Safari 26+ / iPadOS 26+ | `OPFSAnyContextVFS` | stay |
| iOS (iPhone) | none measured to help | stay |

The axis is **what you can guarantee**, not what a visitor happens to run — so nothing here invites
switching VFS under a live database. The Electron or kiosk case is the one that leaves the
universal choice.

**"Concurrent reads" is one column, not two.** Serving a read during a write and parallelising
reads under a pool have the same cause: a VFS holding one exclusive access handle can do neither,
because it is the same handle a second worker never gets. Measured across 13 runs, the two move
together without exception — every VFS with zero `blocked` observations sits above 1.35× read-burst
(`OPFSWriteAheadVFS` 2.0–3.0×, `OPFSAnyContextVFS` 1.70–2.51×, `IDBBatchAtomicVFS` 1.35–1.69×), and
every VFS with `blocked` observations sits at 1.00–1.19× (`OPFSAdaptiveVFS`, `OPFSCoopSyncVFS`).
The cells therefore state a **code property**, not a timing.

**No numbers enter the README**, per its own rule; the benchmark page answers "how much". The
iPhone row says "none" because `OPFSAnyContextVFS` measured 0.82× there with `pool-blocking` at
4.5 — suppressing a negative result would be the only real dishonesty available here.

## 5. Tests

**New, in `tests/unit/capabilities.test.ts`** (the file already exists):

- **Every feature named in any VFS `requires` or in `BUILD_REQUIREMENTS` is either in `PROBES` or
  in the declared `UNPROBEABLE` set.** This is the invariant that would have caught
  `writable-stream` shipping without a probe — `ANYCONTEXT-1`'s exact gap.
- `missingFeature`, table-driven over vfs × build × available features, including every negative
  branch.

**New, in `tests/browser/vfs.test.ts`** (where option guards already live): `createSQLiteClient`
without `vfs` throws `INVALID_OPTION` synchronously, and the message names `OPFSAdaptiveVFS` and
the benchmark URL.

**Changed:** `tests/unit/exports.test.ts:12` asserts that `DEFAULT_VFS` is exported; it becomes the
guard that catches a forgotten removal. Roughly 13 call sites across `tests/browser/`,
`tests/conformance/helpers.ts` and the three consumer smoke apps gain an explicit `vfs`.

## 6. Migration

There is no CHANGELOG. One is created — this is the first genuinely breaking change, more will
land before 1.0, and the README is the wrong home because it addresses users of the current
version.

> **Breaking:** `vfs` is now required. If you relied on the default, pass
> `vfs: 'OPFSAdaptiveVFS'` to keep reading your existing database.

## 7. Picked up on the way

Both in files this change opens anyway:

- `client.ts:74` still says "`jspi` is Chromium-only" — false since Firefox 153, Safari 27 and
  iOS 27.
- `client.ts:68` carries `@defaultValue 'OPFSAdaptiveVFS'`, which will have no referent.

## 8. Out of scope, deliberately

- **`readwrite-unsafe` keeps no guard.** `OPFSWriteAheadVFS` therefore keeps the obscure
  off-Chromium failure the README already documents: the first connection opens, the second cannot
  take the handle, and the pool breaks with no error naming the cause. The guard narrows the class,
  it does not close it.
- **The conformance invariants stay duplicated** between the suite and the benchmark page, for the
  reason in §3.
- **`RESIDUE-1`, `DELETE-1` and `ABORT-1`** are untouched. `DELETE-1` is the same root fact as this
  change seen from the cleanup side — a VFS stores where it likes — but it needs its own design.
