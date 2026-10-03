# Lessons — process, tooling, memory, git

Part of `mem:lessons`, which indexes every entry.

## About this project's own memory

**A memory that goes stale states falsehoods with confidence.** The default VFS was wrong
in the state memory twice: once it said `OPFSCoopSyncVFS` and a dispatch repeated it,
sending an agent down the wrong path for a full round; then it said `OPFSPermutedVFS` and
kept saying it for four days after that VFS was deleted, which produced a false statement
about the project's reliability to the user. **When the VFS choice changes, `mem:vfs` and
`mem:state` are the first things to rewrite.**

**A design corrected by measurement must record the version that was wrong.** BP-1's first
proposal — "the worker awaits one credit *message* per chunk, so the await is both the
accounting and the yield, no counter needed" — **deadlocks**: credits sent ahead are
dispatched during the query's start-up awaits, each resolving a signal nobody is waiting
on, after which the worker awaits a fresh signal that never arrives. The probe found it by
hanging. **Accounting and yielding are two separate roles** — a counter for the first, an
unconditional task turn for the second.

## A symbolic rename lands at stale offsets after a symbolic edit — 2026-08-27

`rename_symbol` on `Abortable` reported "5 changes applied" and **corrupted two
places** in a file whose body had been replaced with `replace_symbol_body`
earlier in the same session: `const { options, release } = …` became
`const AbortableOptions, release } = …`, and a comment lost three words. The
language server was renaming ranges it had computed against its own, older view
of the file.

It was loud — `tsc` failed immediately with a parse error — but it is exactly
the class of edit that would be silent if it landed inside a string or a
comment, and two of the five did land in prose.

**So: after replacing a symbol body, do not rename through the LSP in the same
breath.** Either re-read the file first, or rename textually with
`replace_in_files`, which works on the file as it is on disk and cannot desync.
Typecheck immediately after any rename either way — the second rename of that
session, done textually, was clean and `tsc` is what proved it.

## An empty `${{ }}` in a shell comment breaks a composite action — 2026-08-31

A comment inside a composite action's `run:` block explained that a value travels
through `env:` **rather than through `${{ }}` interpolation** — and wrote that
sequence literally, empty. GitHub's template parser scans the whole `run:` string,
comments included, found an expression with nothing in it, and refused the
manifest:

```
action.yml (Line: 146, Col: 12): An expression was expected
```

**What it cost:** a released action version that no consumer could load at all,
and a failed release tag. Every job pinned to it died at *Set up job*, before a
single step ran — so the error is nowhere near the code that caused it, and the
annotation names the action's line, not the workflow's.

**What to do instead:** never write the literal `${{` in a composite action, in
any position — a comment is not a hiding place. Name the mechanism ("a workflow
expression") instead of quoting it. `grep -n '\${{ *}}'` over the file catches
the empty case; the general form is that every `${{ … }}` in the file must
contain something.

**The tell:** a failure at *Set up job* with zero steps executed is never your
logic. It is the manifest failing to load or to parse.

## A subject routed to a list is a subject nobody owns — 2026-09-03

**What happened:** the ryow-barrier design deferred "a default `busy_timeout`" by
writing "perf list" in its out-of-scope table. Nothing was created. Ten days later
`feat/perf-measure` closed *the performance backlog* by name, deciding two items it
could see and never learning this one existed. On 2026-09-02 the subject was
rediscovered from the original external assessment, reopened in `mem:follow-ups` as
though it had been forgotten — and it had, but not by anyone who could have known.

**Then it got worse before it got better.** The reopened entry was written without
reading `mem:vfs`, which already held the decision on the PRAGMA half. So a closed
decision was reopened, argued for a turn, and had to be closed again.

**What to do instead:** a deferral names a destination that EXISTS. An entry in
`mem:follow-ups`, or a line in a spec's own §Deferred that the closing branch will
read. "The perf list", "the backlog", "later" are not destinations — nothing can be
handed to them and nothing can be checked against them.

**The tell:** if closing a list would not surface the item, the item is not on the
list. And before reopening anything, grep every memory, not the two that seem
relevant — the decision that made the reopening wrong was one file away.

## A plan written by the same head that wrote the spec inherits its blind spots — 2026-09-03

Nine tasks, executed by fresh subagents. **Five defects were in the plan, not in the
implementations**, and every one was caught by someone who did not write it:

- a test asserting `db.debug.name === 'ledger 1'` where `clientIndex` is a per-realm module
  counter, so the index depends on how many clients earlier tests created — the assertion
  was simply unreachable, and the fix is an anchored regex;
- a unit test calling `inspectWith` with no `ownMarkerName`, which routes into a nonce path
  that cannot succeed against a stub — and which would nonetheless have passed whenever two
  other tests ran first, because the realm id memoises at module scope;
- a browser test returning a queued writer's promise from inside a transaction callback,
  which **deadlocks**: the transaction holds the very lock the queued writer awaits;
- "the unit project runs on Node, where `navigator.locks` is absent" — false, **Node 24
  ships Web Locks**, so the degenerate-case test would have resolved instead of rejecting;
- a README sentence describing behaviour the code did not have, left over from a design
  decision the user had reversed two messages earlier.

**The pattern is one thing, not five.** Every defect is a claim the plan asserted rather
than checked, and the controller could not catch any of them, because the controller is
what wrote them. The implementers caught four by running the code; the fifth was caught by
a reviewer told to check every documented claim against the source.

**So: state the assumption in the dispatch, in the words that make it checkable.** "The
unit project runs on Node, where `navigator.locks` is absent" got corrected because it was
written down as a fact an implementer could disprove. An unstated assumption reaches
production as behaviour.

**And a reviewer asked to verify documentation against the code will find things nobody
else can.** The Critical of this branch — `db.inspect()` answering a memory VFS with an
empty roster where `inspectDatabase` refuses — was found by a DOCUMENTATION review, because
checking whether a sentence was true meant reading two entry points side by side. No
task-scoped review had both in view.

## An install that "succeeded" can be missing an optional dependency — 2026-09-04

`pnpm test:consumer` failed twice in a row at 21/24, with Parcel dying on
`Cannot find module '@swc/core-linux-arm64-gnu'`. It looked exactly like a regression from
the branch under test — it was not, and it was not even a change: **an optional dependency
that fails to download does not fail `npm install`.** The scaffold stage reported success,
and the absence only surfaced when Parcel tried to load its native binding.

Two runs agreed, which is what made it convincing. What settled it: a clean-room `npm
install` of the same fixture pulled the package fine, the two-install sequence the script
uses reproduced nothing, and the next `pnpm test:consumer` was 24/24.

**Before concluding that a consumer-smoke failure is yours: re-run it, and run it on
`main`.** Both were done here — but both failing runs were minutes apart and shared the
transient cause, so agreement between them proved nothing. Two observations of one flake
are one observation. The fixtures pin floating ranges on purpose (they test the newest
bundlers), so this failure mode stays possible and will return wearing another package's
name.

## A branch can produce the defect it exists to remove, three times — 2026-09-09

The abandoned-generator branch fixed a generator that stranded its pool worker. Along the way it
introduced, and had to fix, **three defects of that same class**:

1. a `Promise.race` tie that silently dropped 3900 of 4000 rows (above), bisected against `main`;
2. a permanent pool wedge on Firefox — evicting a worker stranded the rotated exclusive OPFS
   handle, and nothing could open the database again (`mem:vfs`, HANDLE-2);
3. an `await gen.return()` parked behind an in-flight `next()`, so a transaction never rejected,
   never returned its lease, and held the origin's write lock indefinitely.

**None was found by re-reading the plan.** Each was found by a whole-branch review or by an
implementer who would not work around a red test. The controller wrote all three, reviewed them,
and passed over them.

Two things follow. **A fix in this area is not more trustworthy for being a fix** — it is code in
the same place, written under the same assumptions, and it earns the same review as the defect
it replaces. And **the whole-branch review is the only step that caught two of the three**: task
reviews saw diffs, and the defects lived in the interaction between a change and the untouched
code beside it.

## A pre-merge verification is not ceremony — 2026-09-09

The session's closure was stopped by `pnpm test` going red on the merged-to-be tree, on a
one-in-eighteen flake, after every task review had passed and a whole-branch review had said
ready. The user's own challenge — *"on clôture ne bypass pas la revue de branche normalement"* —
was right on a second count: four commits had landed after the last whole-branch review and none
had been reviewed at that level.

**A red suite at closure is the cheapest place to find a defect, and the last one.** What
followed was a full systematic-debugging session that turned a flake into HANDLE-2. Had the
merge gone through on a green-looking summary, the wedge would have shipped in rc.5.


## A hook that ends with `tsc` is not proof that a commit typechecks — 2026-09-10

Commit `c2ef918` landed with `tsc` failing, although the pre-commit hook ends with
`pnpm exec tsc --noEmit`. Traced the next day from the implementer's transcript: nobody bypassed
it — its previous attempt was refused by the hook's `tsc` — but the attempt that landed was a
commit in `git log` 25 s after it started, while the hook's suite alone takes ~100 s. The
likeliest cause, not proven, is the agent's tool cutting the command mid-hook
(`mem:git-hooks`). Three checks passed over it: the implementer's report called
the error "pre-existing, not related to this task" twice; the task reviewer ran lint only;
the controller's own verification ran `pnpm test` only. It surfaced when the NEXT commit, a
documentation-only one, was refused.

**Two rules out of it.** A verification run is `pnpm test` AND `pnpm exec tsc --noEmit`,
never the suite alone. A subagent's "pre-existing" is a claim about the base commit: check it
there before accepting it. What proved the rest of the branch was a per-commit check in
clean worktrees — `git worktree add /tmp/rev-<sha> <sha>`, symlink `node_modules`, run `tsc`
and the linter, remove the worktree — and it is the only proof that does not trust a hook.

## Code a plan hands over verbatim must compile under the repo's own flags — 2026-09-15

Task 2 of the statement-errors plan gave its implementer exact code, and it failed `tsc` three
times over: `exactOptionalPropertyTypes` refuses `{ sqliteCode: maybeUndefined }` for an optional
property. The implementer adapted it; the next task's dispatch had to warn about the same trap.
The plan had been written without type-checking a line of it. **When a plan carries code to
transcribe, put it through `tsc` under this repo's `tsconfig.json` before handing it over** — a
scratch file is enough. `exactOptionalPropertyTypes` is the flag that bites: pass an optional
field through a conditional spread, never as `key: value | undefined`.

## A subagent handed a 16-file triage reads for fifteen minutes before it writes anything — 2026-09-15

Three batches behaved identically: 10-18 minutes of reading, no edit, no report. What fixed it was one line
in the brief — *work file by file; write your first table row within ten minutes* — plus a controller
message when the ledger showed no edit after ten. **Split a batch before dispatching it, and give the first
artifact a deadline.** A monitor that counts the report's rows, not only the modified files, shows the
difference between thinking and stalling.

## A variable name you did not choose may already be taken — 2026-09-23

A measurement driver read `process.env.BROWSER` to pick a Playwright engine. This container defines
`BROWSER` — VS Code's own helper script — so the Chromium arm launched nothing and died on
`undefined.launch()`. Firefox worked throughout, because it was passed explicitly, which is what made the
failure look like a Chromium problem. Second instance of "the environment an agent runs in is not
neutral" above: prefix a probe's variables (`PW_BROWSER`), and suspect the environment when one arm of
a symmetric harness fails.

## About verification (2026-09-23, `feat/vfs-folders`)

**A task that changes a name every test builds must run the whole suite, not its own file list.**
Task 3 re-keyed every lock on the VFS; its brief listed the tests that call the lock-name helpers, and
the implementer ran exactly those. `exclusive-connection.test.ts` held a hardcoded `bsq:conn:opfs:…`
literal nobody had listed, and went red on a commit reported green. The same sweep found four unit
tests whose hardcoded prefix now failed the prefix check before reaching the branch they named —
green for the wrong reason. What works: after changing a name, grep the tests for the NAME'S SHAPE
(`bsq:`, `getDirectory()`, `LockName(`), not for the helper, and run `pnpm test` whole.

**A fixture sitting exactly on a bound is invisible until the bound moves.** Every
`browser-sqlite-test-${uuid}` was exactly 56 characters — SQLite's path limit — and nothing said so
until a folder prefix pushed all of them over and every default-named client failed to open with a
bare `SQLITE_CANTOPEN`. When a change shrinks a budget, measure the fixtures against it first.

## About proving a refactor neutral (2026-09-24, `refactor/build-capabilities-const-split`)

**TypeScript 7 ships no JavaScript compiler API** — `require('typescript')` exposes two keys, no `createProgram`. A surface check must work from the emitted `.d.ts`: a text dump of every top-level declaration keyed by name, plus a type-level `Equals<A, B>` file run with `tsc --ignoreConfig` (without that flag, tsc 7 refuses a command-line file while a `tsconfig.json` is present, TS5112). **`Equals` across two declaration trees gives false differences on generic methods**: two byte-identical copies of the same `dist` compare unequal on `output` and `transaction`. Run the control — the tree against a copy of itself — before believing a cross-tree failure.

**A tool's green says nothing about files outside its scope — read the scope before trusting the green.** Until 2026-09-24 `tsconfig.json` included `src` and `tests` only and `biome.json` the same: `scripts/render-vfs-matrix.ts` carried seven type errors for twenty days, and a `satisfies Record<PlatformFeature, …>` written to force a support row fired the day `cross-origin-isolated` was added — into a file no gate read. Both now cover `scripts/`; the `.mjs` files are still not type-checked (`mem:follow-ups`).

**Reordering CSS to satisfy `noDescendingSpecificity` changes nothing when specificity decides — it can only silence the lint.** `.warn b` (700) sat after `#banner b` (600); moving it up made biome quiet and left the development-build badge inside `#banner` at 600, which is the defect the warning was pointing at. Ask whether the lower-specificity rule ever applied where it was meant to, and measure the computed style (Playwright, `getComputedStyle`) before and after.

**The VFS.md generator finds its span by the BEGIN marker string.** Change that string in the generator and the next run cannot find the old marker in `VFS.md`: edit the marker line in `VFS.md` by hand, then run `pnpm docs:vfs` and check it changes nothing else.

## A type claim checked outside the project's own `tsconfig` is not checked (2026-09-24, `feat/public-surface`)

The spec claimed `createSQLiteClient`'s new `): SQLiteDB` return annotation "compiles as is", verified with a scratch `tsc --strict` run that carried no `exactOptionalPropertyTypes` — the project's own flag. Under the project config the annotation failed: `SQLiteDB.debug` was declared `debug?:` while the client always publishes that key, present or `undefined`, so the assignability check the annotation exists to add caught a real mismatch the scratch check could not see. **Check a type claim with `pnpm exec tsc --noEmit` on a file inside the project's `include`, or with the project's own flags copied verbatim — never with a `tsc` invocation assembled from memory.**

## A sabotage reverted with `git checkout -- <file>` also reverts the uncommitted work (2026-09-30)

A plan that says "apply the sabotage, see the test fail, revert with `git checkout -- src`" assumes the real change is already committed. An implementer who sabotaged before committing lost its whole uncommitted change to `pool.ts` that way, and had to reapply it. Commit (or `git stash`) the real change before any sabotage, and write plans with that order.

## `pkill -f` with a pattern from your own command line kills your own shell (2026-10-03)

`pkill -f "wtr-ff.config.mjs --files ./test/sql.test.js"` matched the `bash -c` that ran it (exit 144) and left the runner alive, while the background loop moved on to its next run. **Stop a background run by PID**, read off `ps`, children included; and stop the loop's own shell first, or it starts the next iteration.
