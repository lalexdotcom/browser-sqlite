# Follow-up — proposals to wa-sqlite for a cheaper `step()`

Part of `mem:follow-ups`, opened 2026-10-16 (user) when the library-side fast step merged (`src/worker/step.ts`, `mem:history/2026-10-12-to-18`). **Optional, and upstream's to take or not**: the library already has the gain. It may start as a GitHub Discussion or an enhancement issue on wa-sqlite (user, 2026-10-16). Upstream is not preferred by this project (`mem:conventions`); what an upstream change would buy the library is the deletion of `src/worker/step.ts` and of its fingerprints in `tests/unit/lib/wa-sqlite-pin.test.ts`.

## The two proposals

- **`step()` kept `async`, without the nested `retry()`** — API unchanged, nothing to change in the library (the gain arrives at the repin), but only part of the gain: about half on `jspi`, ~80-85 % on `sync`/`async` (Firefox), measured on wa-sqlite alone below.
- **A synchronous-when-possible method beside `step()`**, returning `number | Promise<number>` — additive for wa-sqlite users; the library switches its two call sites to it and deletes `step.ts` and its fingerprints.

**Changing `step()`'s own return type to `number | Promise<number>` is breaking** for wa-sqlite users (`.then` on a number; its type is `step(stmt: number): Promise<number>`, `src/types/index.d.ts:765`), so under semver it needs a major version of wa-sqlite (user, 2026-10-16) — a reason to propose the other two, and to name it only as the alternative they avoid.

**The invariant any such method must keep, to state in the proposal: never decide ahead that a call is synchronous — look at what it returned.** `sync`: `OPFSCoopSyncVFS` answers `SQLITE_BUSY` and queues `Module.retryOps`; ignoring them surfaces a false "database is locked". `async`: calling the raw export while the VFS unwinds returns a meaningless value with the operation still in flight, and calling into the module again corrupts Asyncify's state — hence `ccall` without the `async` option, which detects the unwind (`Asyncify.currData` changed) and returns `whenDone()`'s promise. `jspi`: the export always returns a promise; comparing it to `SQLITE_ROW` ends the loop at the first row. So: a number and nothing queued → synchronous; a promise, or any `retryOps`/`pendingOps` entry before or after the call → the asynchronous path of `retry()`, continuing from the call already made.

## The evidence, on wa-sqlite alone (`mem:conventions`: upstream evidence must stand without this library)

**The probe** (2026-10-08): a module worker importing a build's glue, `sqlite-api.js` and `MemoryVFS`, filling 4 000 000 `(a, b)` integer rows, timing `while ((await sqlite3.step(s)) === SQLITE_ROW)` against the raw export and a fast step. To be rewritten as a runnable snippet or a test in wa-sqlite's tree before posting. **Time Firefox on a stock build**: Playwright's Firefox inflates every `await` (FF-PW-AWAIT, `mem:measurements/footprint`), which matters for upstream's own CI if it moves to Playwright (Discussion #373). A stock Firefox launched by hand updates itself unless a `DisableAppUpdate` policy is installed (`mem:stack-and-build`).

**Where the time goes, `sync` build, stock Firefox 157 / Chromium, ms:** raw `_sqlite3_step` 163 / 207; raw step + reading both columns 240 / 310; `await sqlite3.step()` 2 829 / 877; `sqlite3.step()` + `sqlite3.row()` 3 276 / 1 302; `retry()` around the raw call 1 764 / 548; `cwrap` with `{ async: true }` awaited 330 / 565. The per-row cost is the façade's `step()` — an `async` function awaiting the `async` `retry()`, ~0.65 µs a row on Firefox against ~0.17 on Chromium.

**`step()` → upstream-compatible variant (kept `async`, no nested `retry()`) → fast step, 4 000 000 rows, stock Firefox / Chromium, ms:** `sync`/`MemoryVFS` 2 835 → 450 → 216 / 893 → 310 → 213; `async`/`MemoryVFS` 3 282 → 968 → 707 / 970 → 626 → 460; `jspi`/`MemoryVFS` 4 409 → 3 324-3 486 → 2 400 / 1 641 → 1 253-1 311 → 1 118. With `async`/`MemoryAsyncVFS` at `cache_size = 10` (15 846 calls a pass really suspended): 3 449 → 807 / 1 001 → 520 (fast step). Row counts exact everywhere.

**WebKit** (Playwright's Linux WebKit 26.6 — not Safari): `step()` → upstream variant → fast step, `sync` 688-714 → 270-281 → 157-169, `jspi` 1 049-1 059 → 670-684 → 548-556; `async` unreadable (3.6-4.1 s every pass after the first, the Asyncify-on-WebKit slowdown). Real Safari not measured.

**What it gave in the library** (FAST-STEP, `mem:measurements/statement-cache-and-perf`): `chunk()` of 4 000 000 rows, `MemoryVFS`, Chromium −49 / −38 / −20 %, Firefox −80 / −59 / −38 % (`sync` / `async` / `jspi`) — a figure for the proposal's motivation, not its evidence.

## The Discussion (2026-10-19)

**Drafted, not posted.** Three options, with pros and cons (user, 2026-10-19: the return-type change is listed as a third option, not dismissed): (1) `step()` kept `async` without the nested `retry()`, (2) a new method returning `number | Promise<number>`, (3) `step()` itself returning `number | Promise<number>` (breaking: `.then()` on a number, a synchronous throw, the declared type — a major). **No runnable snippet for this Discussion (user, 2026-10-19): the maintainer knows his library and will reproduce if the idea interests him.**

**Re-measured 2026-10-19** on a clean export of upstream `master` `6238f53` (no patch), wa-sqlite alone in a module worker, `MemoryVFS`, 4 000 000 `(a, b)` rows, stock Chrome 153 and Firefox 155.0.1 launched by hand (update policy installed), 3 pages × 2 passes per build and engine, arm order alternating, row counts checked, median ms Firefox / Chrome: `sync` today 3 470 / 910, option 1 485 / 312, option 2 241 / 218, option 3 with callers unchanged (`await` on a number) 255 / 309, raw export 178 / 215; `asyncify` 3 867 / 999, 1 016 / 599, 769 / 485, 794 / 587; `jspi` 5 153 / 1 688, 3 846 / 1 401, 2 961 / 1 197, 2 903 / 1 178. **Option 3 with callers unchanged gets nearly option 2's gain** on Firefox and on `jspi` (on Chrome `sync`/`asyncify`, about option 1's): awaiting a number is cheap.

## A separate one-line report, not sent

**wa-sqlite's `MemoryAsyncVFS.create()` returns a `MemoryVFS`** (`new MemoryVFS(name, module)`), so anything created through it never suspends.
