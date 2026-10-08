# History — what each wave shipped

One line each, with one sanctioned exception: a **release** also gets a short section
saying what it was, because a table of increments cannot show an arc. `CHANGELOG.md` holds
the consumer-facing delta; `git log` holds the detail. This file exists only so a date or a
merge commit can be found without archaeology.

The rows live by month: `mem:history/2026-08`, `mem:history/2026-09-01-to-15`, `mem:history/2026-09-16-to-30`, `mem:history/2026-10`. What each merged wave left that the code will not tell you is in `mem:history/waves`, frozen since 2026-10-08 (its last wave merged on 2026-09-15). **A new row goes in the month it was merged.**

## What rc.4 was — the one entry that is not one line

**Deliberately longer than the rule above (user, 2026-08-31),** because the table
reads as twenty increments and rc.4 was not twenty increments. Between rc.3 of
2026-03-26 and rc.4 the library was **reimplemented**, and the rows are the steps
of one arc rather than a list of features.

What actually changed shape:

- **Concurrency became a design instead of a hope.** Exclusivity moved to opaque
  leases with availability unreachable from outside the scheduler; one query is in
  flight per worker; the writer designation is released as soon as nothing is
  queued behind it. `SharedArrayBuffer` and `orchestrator.ts` were deleted
  outright, which is what removed the cross-origin-isolation requirement.
- **Cross-connection staleness turned out to be a property of the setup, not of a
  VFS** — measured identical on every VFS and every build. The commit-propagation
  barrier is permanent architecture because of that, and it is what holds the
  scheduling rules up.
- **The VFS surface became declared and executed rather than described.**
  `VFS_CAPABILITIES` is the single source of truth the client guard, the
  conformance suite, the README generator and the benchmark page all read; every
  declared pair is run, never trusted. `vfs` became required, because a default
  that moves decides where a consumer's bytes live.
- **The failure surface was built.** Typed errors and codes, worker death
  detection with bounded restart, a real asynchronous `close()`, abort implemented
  once and honoured everywhere, back-pressure on `bulkWrite`, and a readiness gate
  so `poolSize` means what it says.
- **Evidence became the currency.** A benchmark page on Pages, a conformance
  project, device campaigns on real Apple hardware, a bundler matrix over five
  bundlers, and `mem:measurements` — where a number without a date and a method
  does not go.

The consumer-facing delta is `CHANGELOG.md`; this section is the shape, which the
changelog's Breaking/Added/Changed/Fixed cannot show.

## Where the specs are

`docs/superpowers/specs/` and `docs/superpowers/plans/`, dated by filename. Two carry
in-place corrections written after execution proved them wrong — the wave-4 back-pressure
design (§3.6 and §6.2) and the wave-3 SQL-safety design (§2.4, §2.5, §3.1). Read the spec
for a design, but read it knowing execution corrected it; `mem:lessons` records why.
