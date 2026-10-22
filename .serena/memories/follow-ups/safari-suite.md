# Safari in the library's suite — what its first runs left to fix (2026-10-22)

Part of `mem:follow-ups`. **The wiring is done on `feat/safari-suite`** (spec `docs/superpowers/specs/2026-10-22-safari-suite-design.md`): Safari is a third, opt-in browser (`--browser safari`, `test:safari*`, `test:conformance:safari`, `test:matrix --engine safari`), macOS only, its jobs one at a time, both macOS workflows test `chrome,firefox,safari`. How it works: `mem:stack-and-build`, `mem:stack-and-build/ci`. The numbers: SAFARI-LIB-SUITE, `mem:measurements/test-browsers/library`.

**What comes next (user, 2026-10-22): the Safari fixes, one branch each.** The goal stays the user's of 2026-10-20: every test that applies to Safari passes there; a skip keyed on Safari's version only for a WebKit defect, never for ours.

## The open failures — one family: a worker killed while it holds an OPFS file

Seven tests per OS on `OPFSWriteAheadVFS/sync` and `AccessHandlePoolVFS/sync` (list and errors in SAFARI-LIB-SUITE), plus two files whose wipe meets `.wa-sqlite`/`.wa` still held. The replacement's open, or a later open, gets WebKit's `InvalidStateError`, which `HELD_ELSEWHERE` (`src/worker/worker.ts`) does not match: it matches only `NoModificationAllowedError`, Chrome's and Firefox's name (`mem:follow-ups` § the name differs by engine; `mem:follow-ups/lifecycle-restart-held`, whose `afterDeath` retry therefore never runs on Safari).

**Before matching `InvalidStateError` (my reading, 2026-10-22, to check first):**
- **Measure whether Safari releases a terminated worker's sync access handle, and how fast.** The wipe still meeting `.wa-sqlite` held at the end of a file, and `lifecycle`'s budget test timing out its 5 s wait for the replacement (8/20 runs before this piece, SAFARI-IDB-LIB), suggest it may release late or never — then no retry passes, and the answer is elsewhere (the library, or a skip keyed on the version if it is WebKit's defect). Safari kept a terminated worker's IndexedDB connection (WebKit 324094): OPFS may behave alike.
- **`InvalidStateError` is generic in WebKit** (a closed handle raises it too): match it only on the open path, where a held file is the plausible cause.
- **`second-client` "fails the client with that worker's error rather than hanging"** stays `'still waiting'`: a longer retry may make it wait longer still. Look at it on its own.

## Not seen on Safari in these runs

The IndexedDB strand (`mem:follow-ups/safari-idb-stranded`, fixed) did not show: `IDBBatchAtomicVFS` cells green on both OS.
