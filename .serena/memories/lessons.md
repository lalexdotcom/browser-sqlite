# Lessons — paid for once each, do not relearn them

Append only. Each entry names what it cost and what to do instead.

The lessons live in the sub-memories below, by theme, each in the order it was written. **A new lesson goes in the sub-memory of its theme**; this index gets its line.

## `mem:lessons/tests` — tests and falsifiers

- About tests
- Reading a test report needs four fields, not three
- A declaration and the skip it causes confirm each other
- A test that waits for a TRANSIENT state must bound the wait
- A regression test's shape can delete the race it was written to pin
- A streaming API tested by a consumer that never pauses is not tested
- A test that measures the END of a query cannot pin an INTERRUPT
- A timeout budget can reintroduce the failure a helper was written to prevent
- A documentation heading can be asserted by a test
- A plan's list of tests to invert is a guess until the tests are grepped
- Deleting a function orphans every Falsifiable comment that names it
- A falsifier also stays green when a second guard produces the same outcome
- A spec rule with no line in its own test list does not get built
- A conformance that does not count live workers can refute a true claim
- `pnpm test` stops at the first red config
- A dry run finds the tests that turn red, not those that turn vacuous
- A fix round can move a test's only falsifier
- A timeout test on a build that cannot interrupt measures the query's length
- A test can pin a defect as the contract
- A suite pinned to one VFS hides every defect in the VFS it does not run
- `afterEach` registered from inside a test body NEVER RUNS in rstest
- A falsifier claim written months ago is a claim, not a fact
- A falsifier that stays green may be one guard of two (2026-09-25, `lifecycle.test.ts`)
- A readiness predicate that matches any activity lets a test act on the wrong event (2026-09-27, `fix/abort-waits-for-its-query`)
- A mutation run covers the three configs, and a mutant that survives is traced before it is called untested (2026-09-28, `test/falsifiers`)
- A suite count says nothing about the builds that were skipped (2026-09-30, wa-sqlite #351)
- A green arm needs an arm that must go red in the same harness (2026-09-30, wa-sqlite #362)
- Find a request in `db.debug` by what it is, never by sniffing its SQL (2026-09-30)

## `mem:lessons/debugging` — debugging, probes, measurement

- About debugging
- For a sub-millisecond effect, count the round trips
- Use every platform you have before announcing a measurement
- When a timing says nothing, count a state instead
- `Promise.race` breaks ties among already-settled inputs by ARRAY ORDER
- A probe must touch what it measures
- A verdict that flips across a corpus is split by commit before engine
- A swallowed cleanup turns one defect into an unreadable cascade
- A delay that does not fix it has only refuted the delay you tried
- A defect identical on every backend may live in the layer they all share
- Two harnesses disagreeing by 45× is a harness finding until a pure probe says otherwise (2026-09-28, `fix/writeahead-read-to-current`)
- A VFS fix is not verified until SQLite has been run through it (2026-09-30, wa-sqlite #351)
- Wrong bytes in the store are not wrong bytes read (2026-09-30, wa-sqlite #351)
- The traps of a page-level VFS probe (2026-09-30, wa-sqlite #351)
- A probe that always throws hides its own cleanup (2026-09-30)
- A reader that finds nothing may be the one that erased it (2026-10-01)
- A rare crash is amplified, not waited for (2026-10-03)
- A VFS that fails a write inside SQLite's batch window gets a journal it never asked for (2026-10-03, wa-sqlite #371)
- Reload a VFS's view only where SQLite revalidates or discards its cache
- `IDBTransaction.abort()` throws once `commit()` was called (2026-10-03, wa-sqlite #371)
- A probe summary that drops a field can invent a defect (2026-10-03, wa-sqlite #372)

## `mem:lessons/claims-and-docs` — claims, documentation, upstream

- About claims and documentation
- Check the upstream signal before waiting on the downstream one
- A comment can outlive the premise of the branch beside it
- A design's "read from the code, not measured" is a hypothesis
- Put a design to the consumer's use cases before its mechanism
- Publishing a value that used to be dropped publishes its sloppiest producer
- A hand edit inside a generated span is erased by the next render
- A measurement the maintainer cannot rerun is not evidence for them
- A changed default is described in more places than the spec lists (2026-09-24, `feat/default-build`)
- Before calling a design new work, look for the mechanism already there (2026-09-28, `fix/writeahead-read-to-current`)
- A PR description says what was observed, and labels what was constructed (2026-09-30, wa-sqlite #351)
- A reservation written down is a probe not yet run (2026-09-30, wa-sqlite #351)
- A defect of a VFS is not an exposure of the library until the library's path is followed (2026-09-30)
- Remove each part of a multi-part fix once before sending it (2026-10-03, wa-sqlite #371)
- A platform gap measured with one tool version is a fact about that version (2026-10-05, Discussion #373)

## `mem:lessons/process` — process, tooling, memory, git

- About this project's own memory
- A symbolic rename lands at stale offsets after a symbolic edit
- An empty `${{ }}` in a shell comment breaks a composite action
- A subject routed to a list is a subject nobody owns
- A plan written by the same head that wrote the spec inherits its blind spots
- An install that "succeeded" can be missing an optional dependency
- A branch can produce the defect it exists to remove, three times
- A pre-merge verification is not ceremony
- A hook that ends with `tsc` is not proof that a commit typechecks
- Code a plan hands over verbatim must compile under the repo's own flags
- A subagent handed a 16-file triage reads for fifteen minutes before it writes anything
- A variable name you did not choose may already be taken
- About verification (2026-09-23, `feat/vfs-folders`)
- About proving a refactor neutral (2026-09-24, `refactor/build-capabilities-const-split`)
- A type claim checked outside the project's own `tsconfig` is not checked (2026-09-24, `feat/public-surface`)
- A sabotage reverted with `git checkout -- <file>` also reverts the uncommitted work (2026-09-30)
- `pkill -f` with a pattern from your own command line kills your own shell (2026-10-03)
- A stub on `PATH` is checked before the script under test runs (2026-10-06)

## `mem:lessons/design` — design of the library

- Abandonment needs an owner, or every `await` is a hole
- A deadline belongs to an operation CLASS, and abandoning a wait is not free everywhere
- A wait you add must be owed by the statement that pays it
- A deadline "counted from the call" includes everything before the callback
- What can run inside a WASM call depends on the build
- A bound on the live set is not a bound on the process (2026-09-26, #361)
- A backstop applied everywhere can break the VFS that use the signal it swallows (2026-10-01)
