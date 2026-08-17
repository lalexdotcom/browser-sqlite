# Resume Plan — how to pick this project back up

Read `mem:project-state` for what the code is, `mem:follow-ups` for the issue backlog.
This file holds only: what is in flight, what is undecided, in what order we work, and
what changed last.

## 0. Current state

The stack upgrade of 2026-08-17 is **done and verified green** — see `mem:project-state`
for the resulting versions and the TS 7 editor notes. Nothing is in flight.

**Wave 0 is done and closed** (2026-08-17, see §4), safety net included: CI, typed tests,
characterization suites, and a consumer smoke test covering the published tarball.

**Read this before anything else: the library does not work as published — B10.** The
packed tarball has no worker artifact, so a consuming Vite app fails to build (and hangs
in dev). Everything else in the backlog is quality; this one is existence. It is scheduled
for wave 4, but if the goal is "ship v1", it can legitimately be pulled forward at any
time — `pnpm test:consumer` reproduces it in about a minute.

**Next up: wave P** (§2) — packaging. Decided by the user on 2026-08-17: B10 + B8 are
pulled to the front, ahead of every correctness wave. **Goal, stated verbatim: make the
current package — defects and all — consumable.** Not "make it good"; make it installable
and runnable. Wave 1 slides behind it, unchanged.

Wave 1, when we get to it: extract the pool + scheduler, make `releaseWorker` the single
owner of `available`, relayer the query API on `chunk()` (§1.2), fix abort once. Two
`it.fails` tests are already waiting for it: B1 in `tests/browser/transaction.test.ts`,
B9 in `tests/browser/concurrency.test.ts`. Remember the convention: an `it.fails` turning
red means the bug is fixed.

## 1. Decisions — D1 to D5, all settled

| # | Decision | Recommendation | Consequence |
|---|---|---|---|
| D1 | Keep wa-sqlite, or move to `@sqlite.org/sqlite-wasm`? | **Keep wa-sqlite.** The official build's OPFS SAHPool VFS is single-connection, which removes the concurrent-read pool — i.e. the library's reason to exist. Fix the packaging complaint (B8) by vendoring the prebuilt WASM+glue at build time instead. | Reopening it means a rewrite, not a refactor. |
| D2 | Drop the `SharedArrayBuffer` (→ `navigator.locks` + a `postMessage`-driven boolean)? | **Yes** — and D3 now makes `navigator.locks` mandatory anyway (multi-tab `output()` cleanup), so the primitive must exist by wave 3. Removing the SAB itself can still wait for wave 4. | Touches `orchestrator.ts`, `worker.ts`, and the rstest browser plugin. |
| D3 | What shape does `output()` take? | **Decided 2026-08-17: staging table + atomic rename, `navigator.locks`-guarded, multi-tab safe.** See §1.1. | Implementation lands in wave 3. Hard prerequisites: B1 (real exclusivity) and a `navigator.locks` primitive. |

| D4 | Should the query API be layered on an explicit `chunk()` primitive? | **Decided 2026-08-17: yes.** See §1.2. | Lands in wave 1, together with the abort fixes. Renaming `stream()` is a silently-shaped break — accepted, we are in RC. |
| D5 | Wire the debug subsystem, or delete it? | **Decided 2026-08-17: wire it**, behind `debug?: string \| boolean`. See §1.3. | 221 dead lines become live. The unbounded `requests` array must be capped first or it leaks. |

Status: **D1 and D2 decided-with-recommendation; D3, D4, D5 decided** as of 2026-08-17.

**Standing assumption (user, 2026-08-17): there is NO consumer on `1.0.0-rc.3`, and none
can appear before we choose to create one.** Nothing is published until every correction
wave is done, and publishing only happens on a `v*.*.*` tag — merging to `main` ships
nothing. D3's and D4's breaking changes are therefore free, and stay free for the whole
sequence.

### 1.1 D3 — the decided design

The question was reframed during the 2026-08-17 session. It was recorded as
"does `output()` leave the core for an optional module?"; that framing came from
calling `output()` an "ETL helper". The user's actual design intent is **MongoDB's
`$out`** — a pipeline sink used to build staging tables. Under that intent the
relocation question is minor organisation (variant B below), and the real question
is whether `output()` delivers `$out`'s defining guarantee. Today it does not.

**Why not one big transaction.** SQLite's DDL *is* transactional, so
`BEGIN; DROP; CREATE; INSERT…; COMMIT;` would be atomic — but it holds the single
writer worker for the entire reload (today `write()` releases the worker after every
statement, so unrelated writes interleave between `bulkWrite` batches) and the WAL
cannot checkpoint until COMMIT. Rejected on both counts.

**The chosen shape** — `bulkWrite` is unchanged (un-transacted batches, worker
released between each):

1. Populate `__bsq_staging_<uuid>` in `main` (a normal table, **not** `TEMP` — a
   `TEMP` table lives in the `temp` database and `ALTER TABLE … RENAME TO` cannot
   move a table across databases).
2. Final short transaction: `DROP TABLE IF EXISTS <target>;
   ALTER TABLE <staging> RENAME TO <target>;` then **create the indexes inside that
   same transaction, after the rename** (decision (a)). SQLite has no
   `ALTER INDEX … RENAME`, so indexes built on the staging table would keep
   `__bsq_staging_…` names forever; building them with final names before the swap
   collides with the old table's indexes. The lock lasts the index build, which is
   small next to the row inserts.

**Cleanup, three stacked nets:**

1. `try/finally` around the populate → `DROP TABLE IF EXISTS <staging>`. Covers
   application-level failure, the common case.
2. Sweep at the client's **first `output()`** (not at `open()` — the writer is only
   designated lazily on the first write, and a sweep at open would race the *n*
   workers): `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE
   '__bsq_staging_%'`, drop everything not in flight. Recovers orphans from a closed
   tab or a crashed session. **Guarded by `navigator.locks`** so it is safe when
   several tabs run `output()` concurrently — this is a user requirement, not an
   option.
3. If the final transaction fails, the staging table survives and net 2 collects it.

**Consequences:**
- `temp: true` is incoherent under this design (un-renameable across databases, and
  invisible to the other pool workers since `TEMP` is per-connection). It must either
  require `poolSize: 1` or be dropped. Open.
- Multi-tab `output()` is now a **supported** scenario. The rest of the client stays
  uncoordinated across tabs — see `W-multitab` in `mem:follow-ups`.
- Relocation (variant B: implementation moved to its own module, `db.output` kept as
  a thin delegation) is now a free organisational choice, no longer a breaking change,
  so it no longer gates the version number. Do it opportunistically in wave 3 for the
  Node-testability win.

### 1.2 D4 — the query API layered on `chunk()`

The hierarchy already exists inside `client.ts`, unnamed and unexposed. The single
primitive is `worker.query()` (an async generator yielding `T[] | number` — chunks,
then the affected count); `readWorker` / `writeWorker` / `streamWorker` / `oneWorker`
are thin derivations of it, and every public method is the same 6-line
acquire → delegate → `finally releaseWorker` wrapper. Making the layering explicit is
mostly deletion.

```
worker.query()                                  primitive
  └─ chunk()   AsyncGenerator<T[]>              chunkSize lives HERE
      ├─ stream()  AsyncGenerator<T>            flattens
      ├─ read()    Promise<T[]>                 drains
      ├─ one()     Promise<T | undefined>       first row + internal abort
      └─ write()   Promise<{result, affected}>  drains + captures the number
```

- **`signal`: on every method**, and **added to `one()`**, which currently excludes it
  (`Omit<SQLiteQueryOptions<T>, 'chunkSize' | 'signal'>`). Cancellation is call-site
  semantics, not transport configuration — an earlier draft of this decision wrongly
  lumped it with `chunkSize`. `one()` consolidates the caller's signal with its own via
  `AbortSignal.any([caller, internal])`. **Implementation trap:** the two aborts do not
  mean the same thing — the internal one means "got my row, stop" (resolve normally),
  the caller's means "cancelled" (reject with `AbortError`). Test `caller.aborted`
  afterwards; the combined signal alone does not say which fired. Verify
  `AbortSignal.any`'s browser baseline — it is more recent than OPFS.
- **`chunkSize`: on `chunk()` and `read()` only.** Real transport knob on `read()`
  (1M rows at 500 = 2000 `postMessage`; at 50000 = 20). Meaningless on `write()`
  (writes rarely return rows; `RETURNING` can use `chunk()`). **Harmful on `one()`** —
  its only correct value is 1, and a caller passing 5000 would fetch 5000 rows for one.
  Revisit whether `read()` really needs it once D5 makes it measurable.
- **`chunk()` stays public.** It is the performance path (a row-wise generator costs a
  microtask per row) and the place where back-pressure will live.

**Why in wave 1, not a later API pass:** wave 1 already rewrites `stream()`'s abort
(B1's early-`break` half, and B9). Both defects, plus the future back-pressure
credit/ack scheme, collapse into the single `chunk()` primitive — fix once instead of
four times. Doing the abort work in the old shape and then moving it is double work.

**Cost, stated plainly:** `stream()` changing its yield from `T[]` to `T` is a
*silent* break — an existing `for await (const chunk of db.stream(…))` keeps running
and `chunk[0]` becomes `undefined` on a row object. TypeScript catches it for typed
consumers, the runtime does not. Accepted because RC is exactly that window, and the
double-loop wart is otherwise permanent. Requires a loud CHANGELOG entry. The
zero-risk alternative (keep `stream()` = chunks, add `rows()`) was rejected: it keeps
a `stream` that does not stream.

### 1.3 D5 — the debug subsystem is wired, not deleted

`debug.ts` is **not a logger** — there is no `console.*` in it (the only one in `src/`
is a stray `console.error` at `client.ts:412`). It builds a live introspection tree
exposed as `db.debug`: client config, both queue depths, and per worker a request
history with `startTime` / `acquireTime` / `releaseTime` / `affectedRows` and a query
history. `status` is a `Proxy` getter delegating to `orchestrator.getStatus(index)`, so
it is never stale. This is exactly the instrumentation wave 5 needs; the design is
sound, it was simply never plugged in — `client.ts:302-307` destructures
`{} as ReturnType<typeof createClientDebug>`, so all four bindings are `undefined` and
`createClientDebug` is an `import type` only.

`debugSQLQuery(sql, params)` is a separate utility: renders copy-pasteable SQL with
parameters substituted, quote-aware. **Display only, forever** — it concatenates user
values into SQL.

**Option shape (user's convention):** `debug?: string | boolean` on the client —
`string` is the log prefix, `true` falls back to the existing `clientPrefix`
(`"${name ?? 'SQLite'} ${clientIndex}"`, `client.ts:286`, already used to name workers
as `"SQLite 1 / Worker 2"`). Note this reveals a missing brick: wiring `debug` revives
*state collection*, it produces no console output. A real prefixed logger has to be
added for the convention to mean anything. The per-query `debug?: string` label already
present in `SQLiteQueryOptions` is the matching request tag.

**Fix before wiring — in this order:**
1. **Memory leak.** `MAX_QUERY_HISTORY_LENGTH` (50) caps only `currentRequest.queries`.
   `worker.requests` is pushed to on every request and never trimmed — wiring as-is
   grows memory with the client's total query count. Cap it too.
2. ~~`Buffer.isBuffer` / `Buffer.from` at `debug.ts:76`~~ — **done 2026-08-17**, during
   the wave 0 packaging fix.
3. `status: 'HAHA'` (`debug.ts:158`) — unobservable behind the Proxy, but it ships.
4. Off-by-one: `if (length > MAX) shift()` peaks at 51 before trimming to 50.

## 2. Order of work

Each wave is independently shippable. The ordering rationale that matters: **the test
safety net comes first**, before the scheduler refactor — the original review put tests
last, which is backwards. B1 survived precisely because the scheduler is only reachable
through slow browser tests.

The stack upgrade in §0 lands **before** wave 0 — no point writing the safety net on a
toolchain we are about to replace.

Wave **P** was inserted in front on 2026-08-17 rather than renumbering, so that every
"wave 1 / wave 3" cross-reference already written into §1.1-§1.3 stays true.

| Wave | Contents | Covers |
|---|---|---|
| P | **Packaging — make the package consumable, nothing more.** See §2.1. | B10, B8 |
| 0 ✅ | CI running the suite; put `tests/` in the tsc program; characterization tests for `transaction` / `bulkWrite` / `output`; fix the assertions that cannot fail | B7 |
| 1 | Extract pool + scheduler into a pure module unit-testable in Node (parameterized over a minimal `{ available: boolean }` shape); make `releaseWorker` the single owner of `available`; **relayer the query API on `chunk()` per §1.2** and fix abort once inside it (covers `stream()`'s early `break` and B9) | B1, B9, W-arch, part of W-types |
| 2 | `onerror` / `onmessageerror`, per-request timeouts, distinct `open-error` message, `close()` handshake that settles in-flight work and calls `sqlite.close()` | B2, B3 |
| 3 | `quoteIdent()` + pragma allowlist; **debug wired per §1.3** (do it here, before wave 5, so the perf work is measurable); **`output()` rebuilt as staging + atomic rename per §1.1** (needs a `navigator.locks` primitive — pull it forward from wave 4); `bulkWrite` surfaces per-batch failures | B4, B5, B6 |
| 4 | Packaging: **ship a real worker artifact and an `exports` entry for it — B10, the library is unusable as published**; vendor wa-sqlite (**not** a peer dependency: the problem is the `github:` specifier and wa-sqlite is not on npm at all, so a peer dep would just push the git URL into every consumer's `package.json`); remove the SAB (pending D2). Flip `consumer-smoke` to blocking in CI when done. | B10, B8, W-sab |
| 5 | Performance, **with the debug instrumentation live** so the gains are measurable | perf section |

Correctness items not tied to a wave (`W-route`, `W-multitab`, `W-types`) fold into
whichever wave touches the same code.

### 2.1 Wave P — packaging

**Goal (user, 2026-08-17): the package as it stands today, defects included, must be
consumable — both through a bundler and without one.** Explicitly NOT in scope: B1, B2,
B9, or any other correctness work. The library may still hang on a worker crash; it must
simply install and run.

**Two requirements, one fix.** Vendoring satisfies both consumption modes at once:

- *With a bundler*: today `dist/esm/index.js` points `new Worker(new URL(…))` at a
  `worker.ts` that is not in the tarball → hard build failure. Building `worker.ts` as a
  second entry fixes that, but its bare specifiers (`wa-sqlite/src/sqlite-api.js`,
  `wa-sqlite/dist/*.mjs`, `wa-sqlite/src/examples/*.js`) would then have to be resolved
  by the *consumer's* bundler, which needs wa-sqlite installed — i.e. B8's `github:`
  specifier, which breaks behind a registry proxy.
- *Without a bundler*: the criterion is binary — **the published bundle must contain zero
  bare specifiers**. A browser cannot resolve `@lalex/promises` or `wa-sqlite/…` without
  an import map, and we will not base bundler-free support on a third-party CDN's `/+esm`
  rewriting.

So: bundle wa-sqlite's glue and the VFS files *into* `dist/esm/worker.js`, copy the
`.wasm` files beside it, resolve them via `import.meta.url`. wa-sqlite becomes a
devDependency and leaves consumer lockfiles entirely. **B8 and B10 are the same piece of
work, not two.**

Replacing `defer()` with native `Promise.withResolvers()` (already a cleanup item) drops
`@lalex/promises` too — the package then has **zero runtime dependencies**, which is the
end state to aim for.

**Open for this wave's own brainstorming:**
- *Weight.* Three WASM variants (`wa-sqlite`, `-async`, `-jspi`), ~1.2 MB each, and the
  VFS is chosen at runtime so we cannot know which is needed. Ship all three (~3.7 MB
  tarball), or make `-async`/`-jspi` opt-in via an `exports` subpath?
- *WASM location.* Automatic resolution via `import.meta.url` is elegant but breaks if the
  consumer re-hosts assets on a CDN at another path. Add a `wasmUrl` escape hatch?
- *Licensing.* Vendoring means shipping wa-sqlite's code — MIT, SQLite itself public
  domain. The notices travel with it.

**Definition of done:** `pnpm test:consumer` green in both Vite modes, and its CI job
flipped from `continue-on-error` to blocking. Consider adding a bundler-free mode to the
smoke test (plain `<script type="module">`, no Vite) since that is now a supported use.

**COOP/COEP is NOT solved by this wave.** Cross-origin isolation stays a hard requirement
on the consuming page — that is D2 (drop the `SharedArrayBuffer`), still slotted at
wave 4. "Consumable" after wave P means "installs and runs in a cross-origin-isolated
page", not "drop it in any page".

## 3. Working conventions for this project

- Follow `AGENTS.md`: user leads, one step at a time, French in chat / English everywhere
  else, no unsolicited action on a question, `pnpm check` (biome) after every modification.
- Serena symbolic tools are primary for code; built-in Read/Edit for `.md`/JSON/config only.
- Agent framework is **superpowers**. The old `.planning/` directory was deleted on
  2026-08-17 — do not recreate it or trust anything quoting it.
- These memories live in `.serena/memories/`, which is **not** gitignored — commit them.
- **Open questions stay in the backlog; each wave's own brainstorming raises them when it
  gets there** (user, 2026-08-17). Do not front-load a decision session for a wave that is
  not the next one. The open items are listed per wave in `mem:follow-ups` and in §1.

## 4. Changelog of this plan

- **2026-08-17** — **wa-sqlite bumped v1.0.9 → v1.1.2** (commit `2bf1c59`), ahead of wave P
  and at the user's instruction, because wave P vendors these exact binaries into the
  tarball — vendoring an eleven-month-old build and bumping afterwards would mean redoing
  the whole four-mode packaging validation. Verified green: `tsc --noEmit`, `biome check`,
  `pnpm build`, **105/105 tests**, and both `it.fails` (B1, B9) still failing as expected —
  the upstream `retry()` change did not silently mask either bug. Payload: SQLite
  **3.50.1 → 3.53.0** in all three `.wasm`; `retry()` in `sqlite-api.js` bounded to 2
  attempts instead of a potentially infinite `do/while`, with a new `Module.pendingOps`
  whose errors surface as a return code; `OPFSCoopSyncVFS` (our default) wraps access-handle
  creation in `try/catch/finally` so a failure no longer pins `isRequestInProgress` at
  `true` forever; three WAL fixes from v1.1.1. No API break on anything `worker.ts` calls.
  A sixth VFS appeared upstream (`OPFSWriteAheadVFS`) — opt-in, `VFSConfigs`'s
  `satisfies Record<SQLiteVFS, …>` is unaffected. No source file was touched.

- **2026-08-17** — **B10 + B8 pulled to the front as wave P** (user decision). The stated
  goal for the next phase is that the package as it stands, defects included, becomes
  consumable — via a bundler and without one. Design and open questions in §2.1. Wave 4
  keeps D2 / the SAB removal. ~~Watch item: publishing a consumable RC would create the very
  consumers whose absence justified D3's and D4's breaking changes.~~ **Closed by the user
  the same day: nothing is published until all the correction waves are done.** Publishing
  is tag-driven (`release-and-publish.yaml` fires only on `v*.*.*`), so merging to `main`
  never ships anything. Wave P makes the package *buildable and testable* as a consumer
  would use it; it does not make it public.

- **2026-08-17** — **Wave 0 gap closed: the safety net covered the sources, not the
  published package.** Added `scripts/consumer-smoke.mjs` + the `tests/consumer/` Vite
  fixture + a non-blocking `consumer-smoke` CI job. It immediately reproduced **B10** —
  the published tarball cannot be consumed at all (no worker artifact beside `index.js`);
  `vite build` fails outright and `vite dev` hangs forever, which also demonstrates B2.
  Two packaging bugs fixed along the way: the published `types` field pointed at a
  missing `dist/esm/index.d.ts` (pre-existing), and wave 0's `tsconfig` change had started
  shipping `dist/esm/tests/**` (my regression). Both fixed by `tsconfig.build.json`
  scoped to `src` + `rootDir`, which in turn surfaced the `Buffer` bug in `debug.ts` as a
  compile error — also fixed. 105 tests still green.
- **2026-08-17** — **D4 and D5 decided** (see §1.2, §1.3). D4: the query API is relayered
  on an explicit `chunk()` primitive — the hierarchy already exists internally, so it is
  mostly deletion; `signal` on every method including `one()` (an earlier draft wrongly
  proposed removing it — cancellation is call-site semantics, not transport config);
  `chunkSize` narrowed to `chunk()` and `read()`. Pulled into wave 1 because it collapses
  B9, `stream()`'s early-`break` abort and the future back-pressure scheme into one place.
  D5: the debug subsystem is wired, not deleted, behind `debug?: string | boolean` with
  `clientPrefix` as the `true` fallback; moved into wave 3 so wave 5's perf work is
  measurable. Found while tracing `clientPrefix`: the instrumentation call sites already
  exist, optional-chained into no-ops, so D5 is far smaller than "221 dead lines" implied.
- **2026-08-17** — **D3 decided** (see §1.1). Reframed from "does `output()` leave the
  core?" to "does it deliver MongoDB `$out`'s guarantee?" after the user stated the
  design intent. Chosen: staging table + atomic rename, indexes built inside the final
  transaction, three-net cleanup, `navigator.locks` so multi-tab `output()` is
  supported. One big transaction was considered and rejected (monopolises the single
  writer for the whole reload, WAL cannot checkpoint). Knock-ons: `navigator.locks`
  moves from wave 4 to wave 3; `temp: true` becomes incoherent and is now an open
  sub-question; relocation drops to a free organisational choice and no longer gates
  the version number — the `rc.4` vs `2.0.0` framing recorded earlier is moot.
- **2026-08-17** — **Wave 0 completed** (B7 closed). Added `.github/workflows/ci.yaml`
  (biome ci + tsc + build + full suite, on push to main and on every PR, Chromium cached);
  added `tests` to the tsconfig `include` (it type-checked clean, no fallout);
  `createTestClient()` now takes a `CreateSQLiteClientOptions` override. New suites:
  `transaction.test.ts`, `bulk-write.test.ts`, `output.test.ts`, `vfs.test.ts`.
  Fixed both unfalsifiable abort assertions in `concurrency.test.ts` — the second one
  immediately exposed **B9** (already-aborted `AbortSignal` ignored, 100/100 chunks
  delivered). 81 → 105 tests, all green; no source file was touched.
- **2026-08-17** — Stack upgrade **completed and verified green**: TS 7.0.2, rslib 0.23.2,
  rstest 0.11.8, biome 2.5.8, playwright 1.62.1. Two devcontainer rebuilds (the second for
  the VS Code TS-7 extension swap). Only fallout was a one-line `biome.json` migration.
  `tsc --noEmit`, `biome check`, `pnpm build`, 57 unit tests and 24 browser tests all pass.
  No source file was touched.
- **2026-08-17** — Created. Triaged `docs/reviews/2026-08-17-0759-browser-sqlite.md`,
  verified B1/B6/B8 and the SAB usage directly in source, re-graded severities, inverted
  the review's test-vs-refactor ordering, and closed D1 with a recommendation. No code
  changed yet; work has not started.
