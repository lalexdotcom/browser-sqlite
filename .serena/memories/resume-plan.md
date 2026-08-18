# Resume Plan — how to pick this project back up

Read `mem:project-state` for what the code is, `mem:follow-ups` for the issue backlog.
This file holds only: what is in flight, what is undecided, in what order we work, and
what changed last.

## 0. Current state

The stack upgrade of 2026-08-17 is **done and verified green** — see `mem:project-state`
for the resulting versions and the TS 7 editor notes. Nothing is in flight.

**Wave 0 is done and closed** (2026-08-17, see §4), safety net included: CI, typed tests,
characterization suites, and a consumer smoke test covering the published tarball.

**Wave P is done and closed** (2026-08-17, see §4). B10 and B8 are resolved. The
package is consumable from four modes (Vite dev, Vite preview, rsbuild preview,
no-bundler). 11/11 consumer smoke stages pass; `consumer-smoke` CI job is now blocking.

**Next up: wave 1** — extract pool + scheduler, fix exclusivity (B1), relayer the query
API on `chunk()` (D4, §1.2), fix abort once inside it (covers `stream()`'s early `break`
and B9). Two `it.fails` tests are waiting for it: B1 in
`tests/browser/transaction.test.ts`, B9 in `tests/browser/concurrency.test.ts`.
Remember: an `it.fails` turning red means the bug is fixed — drop `.fails`, do not
re-add it.

Wave 1, when we get to it: extract the pool + scheduler, make `releaseWorker` the single
owner of `available`, relayer the query API on `chunk()` (§1.2), fix abort once. Two
`it.fails` tests are already waiting for it: B1 in `tests/browser/transaction.test.ts`,
B9 in `tests/browser/concurrency.test.ts`. Remember the convention: an `it.fails` turning
red means the bug is fixed.

## 1. Decisions — D1 to D5, all settled

| # | Decision | Recommendation | Consequence |
|---|---|---|---|
| D1 | Keep wa-sqlite, or move to `@sqlite.org/sqlite-wasm`? | **Keep wa-sqlite.** The official build's OPFS SAHPool VFS is single-connection, which removes the concurrent-read pool — i.e. the library's reason to exist. Fix the packaging complaint (B8) by vendoring the prebuilt WASM+glue at build time instead. | Reopening it means a rewrite, not a refactor. |
| D2 | Drop the `SharedArrayBuffer` (→ `navigator.locks` + a `postMessage`-driven boolean)? | **Yes** — and D3 now makes `navigator.locks` mandatory anyway (multi-tab `output()` cleanup), so the primitive must exist by wave 3. **But the two SAB usages do not have the same replacement date — see §1.5, corrected 2026-08-18.** | Touches `orchestrator.ts`, `worker.ts`, and the rstest browser plugin. Full removal is gated on back-pressure, not on wave 4 alone. |
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
      ├─ first()   Promise<T | undefined>       first row + internal abort (was one())
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
- **`one()` is renamed `first()`** (user, 2026-08-17). More accurate as well as clearer:
  the method returns the first row of a result set, not the only one, and it does not
  assert or enforce that exactly one row matched. Land it with the rest of D4 in wave 1 —
  the relayering already rewrites every one of these methods, so renaming costs nothing
  extra there and would cost a second breaking change later. Loud CHANGELOG entry
  alongside `stream()`'s yield change; both are covered by the standing "no consumer on
  rc.3" assumption. Note the internal-abort trap described above stays attached to this
  method under its new name.
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

### 1.4 D6 — asset resolution: we own the Vite integration, and `wasmUrl` is the escape hatch

Decided 2026-08-18, after asking what more could be done about VIT-1 given it is *not*
an artefact defect. It is not a defect, but it is ~25 lines of boilerplate pushed onto
every Vite consumer, and the version we published in the README is fragile. Four items,
all approved:

1. **Ship the plugin ourselves** — a `browser-sqlite/vite` export subpath returning a
   Vite plugin that does both corrections itself: push `optimizeDeps.exclude`, and copy
   `dist/worker/*` using the **resolved** `build.assetsDir` instead of a literal
   `dist/assets`. Consumer config collapses to `plugins: [browserSqlite()]`.
   **Zero-runtime-dependency is preserved**: a Vite plugin is a plain object, so `vite`
   stays a devDependency (types only) — do not let it become a runtime or peer dep.
   Coverage is free: smoke mode 2 already exercises this path, the fixture just switches
   to the shipped plugin. **Wave 4** (with the rest of the packaging work).
2. **The documented snippet is fragile and must die with item 1.** Two hard-coded
   assumptions: `dist/assets` (wrong the moment a consumer sets `build.assetsDir`) and
   `node_modules/browser-sqlite/dist/worker` (a flat node_modules — wrong in a pnpm
   workspace or monorepo). Resolve the package via `import.meta.resolve`. If item 1 ever
   slips, fix the snippet in place — it is wrong as written either way.
3. **`wasmUrl`, optional** — an explicit base URL for the three `.wasm`. **When omitted,
   behaviour is exactly today's** `new URL('wa-sqlite.wasm', import.meta.url)` resolution,
   which works in most setups (user requirement, 2026-08-18): this is an escape hatch, not
   a new default, and the default config must not change by a single byte. It covers the
   wider "assets re-hosted on a CDN at another path" case, of which Vite is one instance.
   It does **not** replace the copy step — the files still have to exist somewhere.
   This closes the "WASM location" open question left by wave P (§2.1).
4. **Turn the hang into a diagnostic** — see B2 in `mem:follow-ups`. Belongs to **wave 2**,
   and is not Vite work: a `Worker` `onerror` that rejects with the attempted URL and a
   README pointer. This is what downgrades a misconfigured consumer from "hangs forever"
   to "reads an error".

**Rejected: inlining the `.wasm` as base64** into `worker.js`. It would remove the
external-asset problem for every bundler at once, but costs +33 % on 2.4 MB raw and gives
up streaming compilation. Acceptable only as an opt-in subpath entry, never as the default.

**Rejected: waiting for Vite.** The `import.meta.url` rewrite during esbuild pre-bundling
is intended behaviour, not a bug in flight — do not plan around a fix.

### 1.5 D2, corrected — the SAB's two usages have different replacement dates

Found 2026-08-18 while reading `worker/worker.ts` for wave 1's brainstorming. D2 as
originally written assumed `navigator.locks` + a `postMessage`-driven boolean replaced
**both** SAB usages, so the whole SAB could go in wave 4. That is true of one usage only.

| SAB usage | Replacement | Available from |
|---|---|---|
| Init mutex (`lock`/`unlock`, `Atomics.wait` worker-side) | `navigator.locks` | Wave 3 (D3 already brings the primitive in) |
| Per-worker `ABORTING` status byte | a `postMessage`-driven boolean | **Only once back-pressure exists** |

**Why the abort flag is different.** The worker's row loop
(`worker/worker.ts:170-205`) is an unbroken chain of `await sqlite.step()`. It never
returns to its event loop for the duration of a query, so **a `postMessage` sent during
a query is never delivered**. Shared memory is the only channel that reaches a worker in
that state — which is exactly why the SAB exists. The flag becomes replaceable only when
the worker awaits a client message per chunk, i.e. the credit/ack scheme currently filed
under wave 5 perf.

**Consequence, to arbitrate when wave 4 gets there (not before):** either pull the
credit/ack scheme forward into wave 4 so D2 completes in one go, or push the SAB removal
to wave 5 and accept that COOP/COEP holds until then. Removing only the init mutex in
wave 4 leaves a SAB behind and therefore banks **none** of D2's actual benefit.

**Verified the same day: no VFS forces cross-origin isolation.** `grep -rE
'SharedArrayBuffer|Atomics\.'` over the whole of `node_modules/wa-sqlite` (`src/` and
`dist/`) returns nothing — not in the six VFS examples, not in the Emscripten glue, not
in the shipped `.wasm`. The OPFS VFS rely on `FileSystemSyncAccessHandle`, which does not
require isolation; `OPFSAdaptiveVFS` requires JSPI, an unrelated constraint. So the
COOP/COEP requirement is **entirely self-imposed by our `orchestrator.ts`**, and D2 really
does remove it. W-sab asserted this; it is now measured.

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
| P ✅ | **Packaging — make the package consumable, nothing more.** See §2.1. Closed 2026-08-17. | B10, B8 |
| 0 ✅ | CI running the suite; put `tests/` in the tsc program; characterization tests for `transaction` / `bulkWrite` / `output`; fix the assertions that cannot fail | B7 |
| 1 | Extract pool + scheduler into a pure module unit-testable in Node (parameterized over a minimal `{ available: boolean }` shape); make `releaseWorker` the single owner of `available`; **relayer the query API on `chunk()` per §1.2** and fix abort once inside it (covers `stream()`'s early `break` and B9). **Exit criteria in §2.2 — FLK-1 is one of them.** | B1, B9, FLK-1, W-arch, part of W-types |
| 2 | `onerror` / `onmessageerror`, per-request timeouts, distinct `open-error` message, `close()` handshake that settles in-flight work and calls `sqlite.close()` | B2, B3 |
| 3 | `quoteIdent()` + pragma allowlist; **debug wired per §1.3** (do it here, before wave 5, so the perf work is measurable); **`output()` rebuilt as staging + atomic rename per §1.1** (needs a `navigator.locks` primitive — pull it forward from wave 4); `bulkWrite` surfaces per-batch failures | B4, B5, B6 |
| 4 | Packaging, round two — B10/B8 and the `consumer-smoke` gate moved to wave P and are **done**. What is left here: remove the SAB (D2), and **D6 (§1.4): the `browser-sqlite/vite` plugin subpath + the optional `wasmUrl` escape hatch**, which retires the fragile README snippet. | W-sab, VIT-1 |
| 5 | Performance, **with the debug instrumentation live** so the gains are measurable | perf section |

Correctness items not tied to a wave (`W-route`, `W-multitab`, `W-types`) fold into
whichever wave touches the same code.

### 2.2 Wave 1 — exit criteria

Added 2026-08-18. The wave is not closed until all of these hold, on top of the standing
three (CI green, memories updated, git clean):

1. Both pinned `it.fails` (B1 in `transaction.test.ts`, B9 in `concurrency.test.ts`) have
   turned red and had `.fails` removed.
2. **FLK-1 is gone, and gone for the right reason.** The abort check must live **client
   side**, in `chunk()`, evaluated before each yield — not only worker side. Rationale:
   `INT-09` fails intermittently because the worker pushes all 20 chunks into the
   `postMessage` queue before the `ABORTING` flag is read (no back-pressure), so the
   consumer drains an already-full buffer and `chunkCount` reaches 20. Stopping the
   worker loop alone does **not** fix that; refusing to yield what is already queued does,
   deterministically. Fixing B9 and the worker ack without this leaves the flake alive.
3. `INT-09`'s assertion is tightened to an exact value (`toBe(1)`, or `<= 2` if one chunk
   in flight is tolerated). Leaving `< 20` on a now-deterministic mechanism recreates the
   unfalsifiable-assertion defect wave 0 was spent removing.

4. **The abort ack already exists — do not invent a protocol.** After breaking on
   `ABORTING`, the worker still posts `done` (`worker/worker.ts:227`). The client simply
   does not wait for it: `query()`'s `finally` republishes the worker while that `done` is
   still in flight, which is the second half of B1 (a worker freed while still inside
   `sqlite.step()`). The fix is to await the pending `done` / `error` before releasing.
   **Caveat:** that wait hangs forever if the worker died — it depends on wave 2's
   per-request timeout for robustness. Note the dependency; do not pull wave 2 forward.

**Settled at wave 1's brainstorming, 2026-08-18** (was left open here):
- **A caller abort rejects with `AbortError`** on `chunk()` / `stream()` / `read()` /
  `write()`, matching `fetch` and the web streams. The decisive argument: today a caller
  aborting on a timeout cannot tell "I received everything" from "I was cut off", and
  processes a truncated result set as complete. `first()`'s *internal* abort stays
  distinct and resolves normally — the D4 §1.2 trap, unchanged.
- **Full W-arch split in this wave**, with `bulkWrite` and `output` together in `bulk.ts`
  (user). This also resolves D3 §1.1's open relocation question: the target is `bulk.ts`.
  Risk accepted and mitigated by commit sequencing — pure code movement first, semantic
  changes after, so a move bug stays distinguishable from a logic bug.
- **Exclusivity by opaque lease.** `PoolWorker.available` is deleted outright; availability
  lives inside the scheduler. No module outside it can write the flag, so B1's `finally` is
  not fixable-but-rewritable — it is inexpressible. `release()` is idempotent.
- Module layout: `scheduler.ts` (pure, Node-testable) / `pool.ts` (transport) /
  `queries.ts` / `transaction.ts` / `bulk.ts` / `client.ts` (assembly).

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
- **Phase workflow (user, 2026-08-17).** Each wave/phase is implemented **on its own
  feature branch, by a subagent** — not on `main`, not inline in the main session. A phase
  is closed only when all three hold: **CI green** (types, format, lint), **memories
  updated**, **git clean**. Groundwork already validated by the user outside a phase
  (dependency bumps, specs) lands on `main` directly.
- **Unplanned working-tree changes are committed, not discarded — but only after the user
  confirms.** Never resolve a dirty tree by reverting or stashing on your own initiative.
- **"On clôture la session" is a defined procedure (user, 2026-08-17), not a figure of
  speech.** It means the work continues in a *different* session, so nothing may be left
  live in this one. Three steps, in order:
  1. **Merge the feature branch into `main`.** The phase's closure conditions must hold
     first — CI green, memories updated, git clean.
  2. **Write the Serena memories.** Anything the next session needs and cannot re-derive
     from the code: decisions and their rationale, traps paid for, open items with their
     evidence. Whatever lives only in a scratch ledger or in the conversation is lost.
  3. **Commit whatever is still outstanding.** Obvious leftovers go in directly; for
     anything that is not obvious, ask first.
- **Open questions stay in the backlog; each wave's own brainstorming raises them when it
  gets there** (user, 2026-08-17). Do not front-load a decision session for a wave that is
  not the next one. The open items are listed per wave in `mem:follow-ups` and in §1.

## 4. Changelog of this plan

- **2026-08-18** — **D6 decided** (see §1.4). VIT-1 stays "not an artefact defect", but the
  boilerplate moves from the consumer to us: a `browser-sqlite/vite` plugin subpath in
  wave 4 (`vite` stays a devDependency — the zero-runtime-dependency state from wave P is
  not to be traded away), plus an **optional** `wasmUrl` whose absence keeps today's
  `import.meta.url` resolution byte-for-byte (user requirement). The README snippet was
  found fragile on two counts (hard-coded `dist/assets`, flat-node_modules path) and is
  retired by the plugin. Wave 2's `onerror` work gains an explicit requirement: name the
  attempted worker URL, so a misconfigured consumer reads an error instead of hanging.
  Inlining wasm as base64 and waiting for a Vite fix were both considered and rejected.

- **2026-08-17** — **Wave P closed.** B10 and B8 resolved. What shipped:
  - Two rslib entries: `index` (rslib defaults, keeps `import.meta.url` literal) and
    `worker` (`importDynamic: true`, `url: false`, `asyncChunks: false`, wa-sqlite
    fully inlined). Source file moved: `src/worker.ts` → `src/worker/worker.ts`.
  - Three `.wasm` copied flat beside `worker.js` via `output.copy` (no content hash).
    `url: true` was the original design but was rejected: its webpack runtime anchor
    (`__webpack_require__.b`) cannot be followed by Rollup or a consumer's rspack.
  - `exports["./dist/*"]` dropped (surface too wide before any consumer exists).
  - `@lalex/promises` removed; `Promise.withResolvers()` native. `dependencies: {}`.
  - `NOTICE` added: full verbatim MIT text (year 2023) + inline `/*!` banner on
    `worker.js`. The plan's draft linked the text instead of reproducing it and used
    year 2024 — both corrected.
  - Four consumer smoke modes green (11/11 stages); `consumer-smoke` CI now blocking.
  - **Task 7 (chunked worker) permanently wontfix.** Rollup refuses `format=iife`
    for a code-splitting build; Vite always re-bundles worker entries that way. The
    monolithic worker (117,405 bytes gzip) is the permanent shape. Recorded as W-chunks
    in `mem:follow-ups`.
  - **Surprise (genuine limitation):** Vite requires consumer configuration — esbuild
    pre-bundling rewrites `import.meta.url` in dev, and prod build does not copy wasm
    beside the emitted worker. Documented in README, recorded as VIT-1 in
    `mem:follow-ups`. rsbuild/no-bundler modes need nothing.
  - **Flaky test found (pre-existing):** `AbortSignal INT-09` in
    `tests/browser/concurrency.test.ts` timing-races intermittently. Recorded as FLK-1
    in `mem:follow-ups`; can block commits and CI.
  - Spec (`docs/superpowers/specs/2026-08-17-wave-p-packaging-design.md`) and plan
    (`docs/superpowers/plans/2026-08-17-wave-p-packaging.md`) amended with an
    "Amendments" section at the end of each. Both originals are unmodified above it.

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
