# Architecture — the barrier and cross-tab

Part of `mem:architecture`.

## The commit-propagation barrier

Read-your-own-writes holds **within a tab and across tabs** since rc.5, on every VFS but
`IDBMirrorVFS`. Two designs, and read both rather than any summary:
`docs/superpowers/specs/2026-08-21-ryow-barrier-design.md` for the barrier itself, and
`docs/superpowers/specs/2026-08-31-cross-tab-coordination-design.md` for how the epoch left
the realm. Four things the first settled that are easy to get wrong again:

- The epoch bump **cannot** ride on `lease.release()`: release is async, so `write()`
  resolves first and a read chained after it would still see the old epoch. It is posted
  synchronously in the write path's `finally`.
- New workers start at `seen = -1`, because a commit can land between a worker opening the
  file and entering the pool — the nominal startup ordering at `poolSize: 2`, not a rare
  race.
- `file` is normalized once at the client entry, in **relative** form. That also fixed
  `initLockName`'s raw-string key and `OPFSWriteAheadVFS` throwing on `'./name'`.
- A failed fallback `ROLLBACK` leaves an open transaction on a pooled connection, where
  the prelude would succeed and refresh nothing. The worker is evicted instead.

## Cross-tab, since rc.5 — the invariants that hold it up

Design: `docs/superpowers/specs/2026-08-31-cross-tab-coordination-design.md`. Line counts in
the table above are stale from here on; re-count before citing them.

- **Lock before lease, never after.** `acquireInstrumented` takes `bsq:write:<vfs>:<path>`
  before `scheduler.acquire`. The reverse holds a pool worker while blocked on a cross-tab
  lock, and at `poolSize: 2` two queued writes then starve the same tab's reads.
- **The epoch bump stays synchronous, and `write()`/`transaction()` await the publication.**
  Holding the write lock across the publish is **not** sufficient — reads take no lock, so a
  foreign read can `query()` in the gap and miss the commit. That hole was found twice: once
  on `write()` during implementation, once on `transaction()` by the final review.
- **The marker is held `shared`.** Nobody reads the lock; the name is the state. Exclusive
  would make two realms arriving at the same `n` block on each other, inside the write lock,
  unbounded.
- **One marker per realm per database**, released only when a higher one is taken and never on
  `close()`. That bound is what keeps `query()` cheap — its cost is linear in the origin's
  held-lock count (`mem:measurements`).
- **A client must never hold the write lock across more than one write.** A refcounted hold
  shared between a client's concurrent writes was proposed and rejected: with overlapping
  writes the count never reaches zero and that client starves every other tab.

**The staleness the barrier was built for was a defect of our worker, fixed since `aee3859`
(spike 2026-09-25, `mem:history`).** The worker read column names before the first `step()`,
so a statement SQLite re-prepared on a changed schema returned fresh rows under stale names — the
"identical on every VFS and every build" measurement was that bug. Without the barrier, no schema
scenario is stale today on any pair; data reads were stale 3 times in 1232 and never with it
(BARRIER-DATA, `mem:measurements`), so it stays. Its measured
cost is in `mem:measurements`.

**On `OPFSWriteAheadVFS` the barrier's read catches up by construction (2026-09-28).** That VFS
freezes a read's view as its `BroadcastChannel` has delivered commits, which can lag the reply
that triggered the read. `VFS_CAPABILITIES[vfs].catchUpPragma` names a pragma that makes a read
current (`wal_read_latest`, our wa-sqlite#365, merged and in the pin); `barrierSqlFor` wraps the
barrier as `PRAGMA x=1; <barrier>; PRAGMA x=0` in one message, computed once per client. User
reads keep the pragma off, so a large open write does not make them scan — turning it on for
every read was measured and rejected (365-LIB). The view of a `WriteAhead` only advances, so the
read after the barrier inherits it. A consumer who sets the pragma keeps their choice.
