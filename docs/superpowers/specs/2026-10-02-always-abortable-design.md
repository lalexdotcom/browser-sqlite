# Every statement abortable — design

Date: 2026-10-02. Status: decided by the user the same day, after measurement.

## Problem

`chunk()` and `writeWorker` pass `abortable: signal !== undefined`, and the worker installs its
progress handler only for an abortable statement (or a `yieldsDuringStatements` VFS, whose handler
still answers 0 without a signal). So a `first()`, a `break` out of `chunk()`/`stream()`, or a
`return()` on one, issued without `signal`/`timeout`, stops nothing in flight: the worker finishes
the step it is in before the lease comes back, and the NEXT call on that worker pays for it —
measured at the full remaining step (~1 s in the probe). Inside a transaction every statement is
already abortable (`closeSignal` is always merged), so the two paths behave differently today.

## Decision

Drop the `abortable` option. Every statement the worker runs installs the progress handler its
build allows:

- `async` / `jspi`: the yielding handler, which returns 1 once `gate.isStopped()`.
- `sync` with an abort slot (cross-origin isolated): the polling handler on the slot.
- `sync` without one: nothing, as today — no mechanism exists there.

`yieldsDuringStatements` loses its only reader (`worker.ts`) and is removed from `VFSCapability`
and `VFS_CAPABILITIES`: every VFS now yields on every statement on `async`/`jspi`, which is what
the flag granted `IDBBatchAtomicVFS` alone.

Nothing else changes: who sends a stop is untouched. A statement is stopped only when its own
transport asks (`interrupt()` / the `stop` posted by `pool.ts`'s finally) or when the worker's
`close` handler calls `gate.stop()`.

## Behaviour that changes

1. A generator read left early without a signal — `first()`, `break`, `return()` — now cuts its
   running step on `async`, `jspi` and isolated `sync`. The next call on that worker no longer
   waits the step out.
2. A `close` message that reaches the worker mid-statement (only after `drainTimeout`, while a
   lease is still held) now interrupts an unsignalled statement on those builds instead of letting
   it run to its end. An interrupted write is rolled back by SQLite as a whole statement.
3. `read()` and `write()` without a signal gain nothing — nothing can leave them early — and lose
   nothing measurable.

## Evidence (probe of 2026-10-02, `.scratchpad/gen-abort-2026-10-02/`)

A page flag forced `abortable` on, so the "on" arm was exactly this change and "off" was `main`.
Every declared (vfs, build) pair on Chromium and Firefox, plus the `sync` pairs cross-origin
isolated. Numbers go to `mem:measurements` (GEN-ABORT).

- **Benefit** (next read after leaving a ~1 s step, median of 4): ~1 000 ms → 1-2 ms on Chromium,
  4-10 ms on Firefox, every VFS on `async`/`jspi`, and 1 ms on isolated `sync`. Unchanged on `sync`
  without isolation.
- **Read cost** (7 alternated rounds, ~400 ms workloads): ratios 0.93-1.04, sign varying.
- **Per-statement cost** (2 000-statement batches, 15 rounds): -10 to +13 µs per statement, re-runs
  0 to +4 µs; at most a few µs, ≤ 2 % of a statement that does nothing.
- **Write cost** (233 workloads): median paired ratio 1.002; the outliers fall in both directions,
  including on pairs where the change does nothing, and an A/A control on `IDBBatchAtomicVFS`
  spreads 0.87-1.03 on its own.
- **Concurrency** (a long read or write while another worker of the same client and a second
  client read and write): no error, no partial state seen, counts and `integrity_check` correct in
  every round; `OPFSAdaptiveVFS` (Firefox) and `OPFSCoopSyncVFS` do not hand their handle over
  mid-statement.
- **Not measured**: Safari (Linux WebKit needs root-installed system libraries here). The bench's
  earlier reading — a yielding statement costs Safari nothing on `IDBBatchAtomicVFS` — stands.

## Changes

- `src/types/protocol.ts`, `src/pool.ts`, `src/queries.ts`: the `abortable` field and both
  producers go.
- `src/worker/worker.ts`: `abortable` / `wantsSignal` go; `yields = canYield`,
  `polls = !canYield && slot !== undefined`, the yielding handler returns
  `gate.isStopped() ? 1 : 0`.
- `src/const/vfs.ts`: `yieldsDuringStatements` goes.
- Comments made false by the change are corrected where they stand — `transaction.ts`'s "the
  client path, which passes no signal and is genuinely not abortable", the IDB test's falsifier.
- A browser test that fails on `main`: `first()` on `SELECT 1 UNION ALL SELECT (<long count>)`
  with no signal, then `SELECT 1` on a `poolSize: 1` client, bounded, on a pair with
  `needs: ['interruptible']`. Plus the same through a `break` out of `chunk()`.
- Consumer documentation (`API.md`, `README.md`) and `CHANGELOG.md`: written in the main session
  with the user, not by the implementer.
