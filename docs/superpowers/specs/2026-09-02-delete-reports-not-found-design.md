# `deleteDatabase` reports a database that is not there — design

**Date:** 2026-09-02 · **Status:** approved, unbuilt · **Target:** rc.5 · **Branch:** the cross-tab branch, continued

`deleteDatabase` resolves whether or not it deleted anything. This design makes it throw
`DATABASE_NOT_FOUND` when the database does not exist.

Requested by the user, 2026-09-02, and scoped by them to `deleteDatabase` alone —
`createSQLiteClient` creates a database that is absent, so "not found" has no meaning there.

Sibling: `docs/superpowers/specs/2026-09-02-connection-lifetime-lock-design.md`, which gave
`deleteDatabase` its other two refusals.

---

## 1. Why this is worth a public error code

Measured 2026-09-02, both engines: **`deleteDatabase` resolves in all seven cross-VFS cases** — the
four where it destroys a real database created through a different VFS of the same layout family, and
the three where it finds nothing at all. Success reports nothing about what happened.

Half of that is now documented as a warning. The other half — the silent no-op — is what this design
turns into an error. **The failure it catches is the most likely one a consumer makes:** deleting
through the wrong VFS, or against a name that never existed, and believing it worked.

## 2. The signal, and the one that was rejected

**`open_v2` without `SQLITE_OPEN_CREATE`**, in the delete worker, on the VFS instance it already
builds for `jDelete`. Absent → `SQLITE_CANTOPEN` (14). Present → it opens, and the handle is closed
at once.

Measured uniform across all seven persistent VFS on both engines, n=3 per cell, no variation. Table
in `mem:measurements` under EXISTS-PROBE. One guard, no per-VFS branches, because the probe goes
through `jOpen` — the VFS's real notion of existence, and what SQLite itself does.

**`jAccess` was measured first and rejected**, and the reason is worth keeping. It is reliable on four
of seven; on `OPFSCoopSyncVFS`, `OPFSWriteAheadVFS` and `IDBMirrorVFS` it returns 0 in every state,
because each consults an in-memory structure never seeded from storage at construction. On
`IDBMirrorVFS` that is **deliberate** — the upstream source says SQLite never calls `xAccess` on a main
database file, so the VFS skips the round trip. We would have been reading a field whose contract
excludes our use. **A signal right by luck on four of seven is worse than none:** right often enough
that nobody notices when it is wrong.

## 3. Decisions

**D1 · Idempotence goes, and it is a breaking change.** The README says today that deleting a database
that does not exist is not an error, and `tests/browser/delete.test.ts` has an `is idempotent` test
pinning it. Both go. A caller that deletes speculatively must now catch — and that is the point: the
silence being removed is the silence that hides a wrong `vfs`. Stated to the user twice before
building.

**D1b · No `throwOnMissing` option, and no return value either.** Both were weighed with the user
on 2026-09-02. A flag would suppress **one** of three error codes — `DATABASE_IN_USE` and `BUSY`
would still throw — so a best-effort caller would need its `try/catch` anyway and would have an
option to understand on top of it. `catch` does the whole job in one line and lets the caller tell
the three cases apart, which a boolean collapses. A return value of `'deleted' | 'not-found'` is the
textbook alternative and was rejected for the opposite reason: it is **ignorable**, and ignorable is
how the present defect survived. This project already prefers loud over convenient — `vfs` is
required rather than defaulted, and `RECOMMENDED_VFS` is deliberately not exported.

**D2 · `DATABASE_NOT_FOUND` must not swallow other failures.** The guard fires on `SQLITE_CANTOPEN`
(14) and on nothing else. A corrupt database reaches the header read and returns `SQLITE_CORRUPT`
(11); a WASM or VFS start-up failure throws before `open_v2` is reached at all. Both keep the errors
they have today.

**D3 · The probe runs before the deletion, in the same worker and on the same VFS instance.** That
instance already exists because `jDelete` is the only correct removal. Re-instantiating for the probe
would double the start-up cost and, on `AccessHandlePoolVFS`, risk the pool.

**D4 · The refusal order is: in use, then not found, then transient.** `DATABASE_IN_USE` is decided on
the main thread before any worker is spawned, so it necessarily comes first; a database that is open
is more useful to report than one whose absence we could not have checked anyway. `BUSY` stays last —
it means the check itself could not run.

## 4. What this does not do

- **It does not make deleting through the wrong VFS safe.** Within the `opfs-path` family the delete
  still destroys a real database and still succeeds, because the database genuinely is there. This
  design only removes the *silent no-op* case, which is the cross-family one.
- **It is not a `databaseExists()` API.** No probe is exposed; the check exists to give the delete an
  answer. Adding one is a separate decision with its own race — the answer is stale the instant it is
  returned.
- **The memory VFS are untouched.** `deleteDatabase` already returns early for `layout: 'memory'`,
  before any worker, so nothing there can be found or not found.

## 5. Testing

- **The falsifier is the current behaviour.** A delete against a name that was never created resolves
  today; each new test goes red without the guard. Verified by experiment, not by argument — six
  reasoned falsifiability claims on this branch, five of which were false when finally tested.
- **All seven persistent VFS**, since the whole claim is that the signal is uniform. A per-VFS test
  is what would catch it not being.
- **The three states**, not just the absent one: a delete against an existing database must still
  succeed, and a second delete of the same name must now throw.
- **`SQLITE_CORRUPT` must not be reported as not-found.** If a case can be constructed, it is worth
  more than another absent-state test; if it cannot, say so plainly rather than claiming coverage.
- **No wall-clock dependency.** This branch lost a full cycle to a test whose cleanup raced a timer.
