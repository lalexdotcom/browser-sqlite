# Debug run stages, and boot stages as codes — design

Date: 2026-11-05. Follow-up: `mem:follow-ups/debug-run-stage`. Branch: `feat/debug-run-stage`.

## Intent

`db.debug.workers[i].status` is page-side: `RUNNING` covers everything from the moment the page posts a query to the moment the answer arrives. Whether the worker was waiting for its mutex, compiling, stepping, deep in a long computation or waiting for credit, nobody can tell — neither live nor after the fact. Two needs follow:

- **Diagnosis.** Where a statement sat on a starved runner (mutex, prepare, step), which is what `tx-timeout`'s unexplained Windows red and the silent Chrome workers lacked.
- **Tests that can prove their case.** `abort-slot` and `early-exit` (4 tests) read the first row of a query whose second row is a 2 G-row count in one `sqlite3_step()`, leave, and conclude the step was cut. If the worker had not entered the count when the stop came, it stopped at a row boundary, nothing was cut, and the test passes with the cutting code broken (`mem:follow-ups/false-greens-remaining`).

At the same time, `BootStage` — today a union of English phrases — becomes a union of codes, and the boot stages, like the new run stages, are sent only by a worker whose client has the `debug` option.

## Goals

1. The worker knows whether its client is a `debug` client, once, at creation.
2. Boot stages are posted only by a debug worker, and are codes.
3. A live run stage per worker: `db.debug.workers[i].run`.
4. A per-query record of where its time went: `stages` on each entry of `requests[].queries[]`.
5. The four false-green tests use them to prove their case, or report `not-exercised`.

## Non-goals

- No event or subscription API on `db.debug`: it stays a tree read by polling.
- No timeline (ordered list of transitions) per query: a fixed-size per-stage total instead (see § Stages).
- No stage for the verdict path, the freshness barrier as such, or the `delete` worker. A barrier or a transaction's `BEGIN` is a query of its own (`internal: true`) and gets stages like any query.
- No change to the `status` field or its values.

## Anti-goals

- **Any cost to a non-debug client** beyond one boolean test per transition and per progress-handler call. No message, no `performance.now()`, no allocation on the production path.
- **One message per row.** `sqlite3_step()` is called once per row; a stage is posted only when it changes.
- A stage that lies: `awaiting-turn` or `awaiting-credit` shown while nothing waited, `computing` shown outside the caller's step.

## Decisions (the user's)

- **Debug flag:** sent once, in the `open` message (`debug?: true`). The `debug` option cannot change during a client's life, and a replacement worker gets the same `open` message, so it inherits it. No per-query flag.
- **Boot stages are debug-only and codes.** Nothing but `debugWorker?.boot()` reads them today (`src/pool.ts`, `case 'boot'`), so gating them changes nothing in production.

  | Today | Code |
  |---|---|
  | `waiting for the client` | `awaiting-client` |
  | `loading the build` | `loading-build` |
  | `instantiating wasm` | `instantiating-wasm` |
  | `loading the VFS module` | `loading-vfs-module` |
  | `creating the VFS` | `creating-vfs` |
  | `waiting for the open lock` | `awaiting-open-lock` |
  | `opening the database` | `opening-database` |
  | `waiting for a held file` | `awaiting-held-file` |
  | `applying pragmas` | `applying-pragmas` |

- **Run stages:** `RunStage = 'awaiting-turn' | 'preparing' | 'stepping' | 'computing' | 'awaiting-credit'`, public and exported exactly as `BootStage` is (`src/debug.ts`, `src/index.ts`).
- **`stepping` and `computing` are two codes**, because `db.debug` is polled: a second `stepping` identical to the first would be invisible.
  - `stepping`: at the first `sqlite3_step()` of a statement (and again at the first step after another stage). It exists on every build and every VFS, so it separates "stuck in prepare" from "stuck in step" even for a short statement.
  - `computing`: at the first call of the progress handler (every `PROGRESS_OPS` = 100 000 VM instructions) — "in a long computation". Only the progress handler can cut a step (`src/worker/worker.ts`, the handler returns 1 once stopped), so a statement that never reached `computing` could not have been cut. Absent where the handler is not installed (`sync` without the shared abort slot), which is also where no step can be cut.
- **Durations, reported per transition.** Each run-stage message carries the duration of the stage it ends, measured on the worker's own clock (`performance.now()`); the page knows the previous stage (a worker's messages arrive in order) and adds the duration to it. The query's final reply carries the duration of its last stage. A duration is a difference on one clock, so the page and worker `timeOrigin`s never need reconciling.
- **The four false-green tests are fixed in this branch** (§ Tests).

## The protocol

- `ClientMessageData`'s `open` gains `debug?: true` (absent for a non-debug client). The `delete` message does not.
- `WorkerMessageData` gains `{ type: 'run'; callId: number; stage: RunStage; elapsed?: number }`. `elapsed`: milliseconds spent in the previous stage of this query; absent on the query's first stage.
- The query's terminal replies (`done`, and `error` for a query) gain `elapsed?: number`: the duration of the stage the query was in when it ended. Present only when the worker is a debug worker and the query announced at least one stage.
- `BootStage` keeps its message (`{ type: 'boot' }`); the worker's `boot()` posts nothing unless debug.

## When the worker announces each stage

A debug worker keeps, per query, the current stage and the instant it began. It posts a `run` message only when the stage changes. The timer starts when the query message is received; time before the first announced stage (bindings, nothing waited) is not attributed to any stage.

- **`awaiting-turn`**: the query waits for the worker's SQLite mutex (`holdSqlite()` returned a promise) — at the start of the query, and again when the query takes the mutex back after a credit wait. Not announced when the mutex was free.
- **`preparing`**: before SQLite compiles a statement of the query. Not announced on a statement-cache hit. A multi-statement query announces it before each statement it compiles, so `preparing` and `stepping` alternate.
- **`stepping`**: before the first `sqlite3_step()` after any other stage (or none).
- **`computing`**: in the progress handler, at its first call while the worker is inside the query's step (the existing `stepping` flag around `step_asap()` is set), and again at the next such call after any other stage. Recorded before the handler tests for the stop, so a call that cuts the step at its first occurrence still leaves its trace. Not from a handler call outside the step — the prepare of a verdict served while the query waits for credit.
- **`awaiting-credit`**: the query has a chunk ready and no credit to send it (`gate.take()` would wait). Not announced when the credit was already there.

The savepoint statements a write opens or concludes before the caller's statement (`options.savepoint`) run inside the same query, so their stages count in that query's record.

## The debug tree

- `WorkerDebugState.run?: RunStage` — the stage of the query in flight on this worker. Set by each `run` message, cleared when the query's terminal reply arrives, and absent when the worker is idle.
- `QueryDebugState.stages: Readonly<Partial<Record<RunStage, number>>>` — milliseconds per stage, cumulated as the stages end. A stage never entered is absent. Filled while the query runs: a live reader sees the stages already left, `run` names the current one. Empty (`{}`) for a query that announced no stage.
- `WorkerDebugHandle.boot` keeps its role; a `run(stage, elapsed)` entry point is added on the worker handle, and the query handle's `done`/`failed` take the final `elapsed`. Exact handle shapes are the builder's.

**A query that ends without its final duration** (its worker died or was terminated mid-query): *(my call)* the page closes the current stage with the time elapsed on its own clock since it received that stage's message, so the stage the query died in holds the tail and `stages` is never silently short. That one figure includes delivery delay; the others do not. The worker's `run` is cleared then too *(my call)*.

## Cost

- Non-debug: one boolean test where `boot()` is called, at each transition site, and per progress-handler call. No message, no clock read.
- Debug: at most one message per stage change — typically 1-3 per short query, plus two per paused chunk of a stream (`awaiting-credit`, then `stepping`), plus `computing` once per long step.

## Breaking change

`BootStage` changes value set: a breaking change of a public type, although `API.md` already says `db.debug`'s shape is outside semver.

- The commit that changes `BootStage` is `feat(debug)!:` with a `BREAKING CHANGE:` footer in a paragraph of its own above `Co-Authored-By`.
- `CHANGELOG.md` `[Unreleased]`: a `Breaking` entry (boot stages are codes, listed), an `Added` entry (`run`, `stages`, `RunStage`), through the `changelog-maintenance` skill.
- `API.md` § Debugging: the `workers` row gains `run`, the `boot` description lists the codes; the query fields gain `stages`, with a line saying what `stepping` and `computing` mean and that `computing` needs the progress handler.

## Tests

- **Boot codes.** `lifecycle`, `open-retry` and `abort-slot` compare boot stages (through `interceptWorkers().stages`, `tests/browser/helpers/index.ts`, on clients that already set `debug`); they move to the codes.
- **Exports.** `tests/unit/lib/exports.test.ts` lists the exported types: it gains `RunStage`.
- **Boot gating.** A non-debug client's workers post no `boot` message (a unit test on the worker side, or on the pool's message handling — the builder's choice).
- **Run stages, unit.** Stage changes, the per-transition `elapsed` cumulation, the reset of `run` at the terminal reply, the death path of § The debug tree.
- **Run stages, browser.** A cached statement shows no `preparing`; a long statement shows `computing`; a paused stream shows `awaiting-credit`; a non-debug client sends no `run` message.
- **A helper** `theQueryIsComputing(db, sql)` in `tests/browser/helpers/index.ts`, on the model of `theQueryIsRunning`: the query `sql` is in flight and its worker's `run` is `computing`.
- **The four false greens.** The two `chunk()` tests (`early-exit` "a break out of chunk() cuts the step it left running", `abort-slot` "stops a running statement when the consumer leaves a chunk early") wait for `theQueryIsComputing` instead of `sleep(100)` before the `break`. The two `first()` tests (`early-exit` "first() cuts the step it left running", `abort-slot` "stops a running statement when first() leaves it, with no signal") read the query's `stages.computing` after the following `SELECT 1`; absent, the test calls `exercised(…)` (`tests/browser/helpers/exercised.ts`, `mem:conventions`) — never an `expect`. A `chunk()` test whose wait does not see `computing` within its bound also goes through `exercised`, not red; `waitUntil` throws on timeout, so that wait needs a non-throwing form *(my call)*. Their clients need `debug`: `createTestClient` does not set it by default, so these four pass it.

## Verification

- `node scripts/hook-gate.ts delivery --run` green, its report read.
- The branch touches `src/pool.ts` and `src/worker/`: the matrix runs on GitHub before the merge (`mem:conventions`, § What runs where) — ask the user to push the branch.

## Left to the builder

- How the credit gate tells whether `take()` would wait, and how `holdSqlite()`'s wait is detected (both already expose enough, or need a small accessor).
- Where exactly `preparing` is posted in the multi-statement branch, whose compile happens inside wa-sqlite's `statements()` iterator.
- Handle shapes in `src/debug.ts`; message names beyond those fixed above.
- Test placement (unit file names, which browser file holds the run-stage tests).
