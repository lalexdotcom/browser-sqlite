# The statement cache's bound, in bytes — design

**Date:** 2026-09-02 · **Status:** approved, unbuilt · **Target:** rc.5 · **Branch:** its own

`DEFAULT_STATEMENT_CACHE_SIZE = 32` counts entries. An entry can weigh 3.4 MB. This design
moves the eviction criterion to bytes, fed by `SQLITE_STMTSTATUS_MEMUSED`.

Parent: `docs/superpowers/specs/2026-08-27-statement-cache-design.md`, whose §9 deferred this
with a condition — *"if §8.3 shows the `bulkWrite` template dwarfing an ordinary statement by an
order of magnitude"*. It does, by three orders: 2.4 MB against 1.3 KB.

**Every number cited here is in `mem:measurements`** — the footprint table of 2026-08-28 and the
byte-bound campaign of 2026-09-02. None is repeated in full.

---

## 1. What is true today, measured

Four facts, all of 2026-09-02 unless stated, both engines.

- **A `bulkWrite` template weighs 2.31–3.37 MB**, and the peak is the *narrowest* table:
  `bulk.ts` caps parameters at `maxVariables = 32766`, so a one-column table gets 32 766 VALUES
  rows where a five-column table gets 6 553, and part of the footprint follows rows. **The
  library's own generated SQL therefore has a structural ceiling of ~3.4 MB.** Consumer-written
  SQL has none.
- **`MEMUSED` does not move over a statement's life** — after prepare, after binding 32 765
  values, after `step`, after `reset` + `clear_bindings`, after a second cycle: the same byte
  count, on both WASM builds.
- **Two concurrent `bulkWrite`s hold two large templates, not four.** Their batches interleave
  (`abababab…`, recorded), the two FULL templates alternate, and the two partials arrive once
  each at `close()`.
- **A bound too small to hold both cancels the cache** rather than degrading it: 32 of 32 batches
  recompile, indistinguishable from `cache=0`. **+19 % on Chromium, +110 % on Firefox.**

And one that resizes the risk this design exists to answer: at `poolSize: 4`, **all 32 INSERT
batches were served by worker 0** on both engines. The scheduler designates one writer at a time
and prefers `lastWriterIndex`, so large templates concentrate on one worker. The `× poolSize`
multiplier that sized the risk in `mem:follow-ups` is not what happens.

## 2. The rule

Decided with the user, 2026-09-02. Overshoot is deliberate.

```
set(sql, handle, weight):
  drop(sql)                                  // replace: subtract the old weight, if any
  while (total >= maxBytes && size > 0) evictLRU()
  insert(sql, handle, weight); total += weight
  while (size > maxEntries) evictLRU()
  return evicted                             // handles the worker must finalise
```

Three properties, and each is why the rule is shaped this way:

- **It never refuses to cache, and it never looks at the incoming weight.** There is no "this
  entry is larger than the budget" branch, so no non-terminating eviction loop and no statement
  that is structurally uncacheable. An entry heavier than the whole budget is simply accepted;
  what the loop trims is the overflow that was *already* there, and the bill for the oversized
  entry is paid by the **next** insertion, which finds the total over the bound and empties the
  cache before inserting.
- **The peak is `maxBytes + weight of the largest statement`.** The loop leaves the total under
  the budget *before* inserting, so the overshoot is exactly one entry. **State it that way and
  never as a multiple of an assumed maximum** — the assumption does not hold for consumer SQL,
  and the formula does not need it.
- **A re-set replaces, it never adds.** `settle` calls `set` on *every* successful exit,
  including a cache hit, so an implementation that adds the weight again reports a growing total
  for a cache that is not growing. This is where the one silent accounting bug lives.

## 3. Decisions

**3.1 `maxBytes` is not a memory figure, it is a count of concurrent `bulkWrite`s protected.**

The rule drops the incoming key *before* it measures, so what has to fit under the budget is the
sum of the **other** retained entries — not the sum including the one being re-set. For N large
templates alternating, the no-thrash condition is therefore `B > (N − 1) × 3.4 MB`:

| concurrent writers | budget needed | peak |
|---|---|---|
| 2 | > 3.4 MB | < B + 3.4 MB |
| 3 | > 6.8 MB | < B + 3.4 MB |
| 4 | > 10.2 MB | < B + 3.4 MB |

**The default is 8 MB per worker** (`DEFAULT_STATEMENT_CACHE_BYTES`): it protects three
concurrent writers, with a peak under 11.4 MB. Past that the thrash is accepted on purpose, and
§4 says so in the CHANGELOG's words.

**The `N − 1` is not a rounding detail, it is the reason the budget is affordable.** An earlier
draft of this section required `B > N × 3.4 MB` and would have doubled the default for nothing.
It also sets the falsifiers §6 can use: to force two alternating templates to evict each other,
the budget must be below **one** template, not below their sum.

**3.2 Both bounds stay.** `maxEntries` keeps its 32. Bytes alone would let ~6 000 small
statements live at 1.3 KB each; the entry cap is what still answers the churn that generated SQL
produces. Two bounds, three lines.

**3.3 No consumer option.** The parent spec's §3.2 stands and gains a reason: a consumer cannot
pick a VDBE byte figure — `mem:measurements` records that the bytes-per-character ratio is not
stable and that no extrapolation rule exists. Adding an option later is additive; removing one is
breaking. If the footprint should be visible it belongs on `db.debug`, with the `debug`
adaptation already deferred in `mem:follow-ups`, not here.

**3.4 A test-only knob is the price of a falsifiable byte bound.** Every assertion §6 makes about
the *byte* criterion needs a budget the test can move; at a fixed 8 MB default nothing in the
suite can distinguish a working bound from a bound that never fires. So
`__unsafeTestStatementCacheBytes` joins `__unsafeTestWriterPolicy` on
`InternalSQLiteClientOptions` — same precedent, same "TEST-ONLY, UNSUPPORTED" comment, absent
from the public options type. This is not the consumer option §3.3 refuses; it is the falsifier
§6 depends on, and without it the whole feature ships unfalsifiable.

**3.5 The weight is read in `settle`, once per query.** `settle` is the single place `set` is
called, so reading `Module._sqlite3_stmt_status(stmt, 99, 0)` there needs no special case for
the hit branch and no state threaded through the generator. One synchronous WASM call per query;
not an I/O call, so it costs nothing on the Asyncify build either. Reading once after `prepare`
would also be correct — `MEMUSED` is stable — and is not worth the extra branch.

**3.6 The Emscripten `module` must be carried to the query path.** `worker.ts` resolves
`openedDB` to `{ sqlite, db }` and drops it. The JS façade does not wrap `sqlite3_stmt_status`,
so the call needs the raw module and a cast — `wa-sqlite.d.ts` declares `WASQLiteModule = {}`.
Declare the one function narrowly there rather than widening a cast at the call site; the
twelve structural `any` in `src/` are not to become thirteen.

## 4. What this does not do

- **It does not reduce the common footprint.** One `bulkWrite` commits ~3 MB on one worker today
  and will commit ~3 MB after. **This change makes the worst case finite and stated; it buys a
  ceiling, not a saving.** The CHANGELOG must say that in those words, or a reader will expect a
  memory reduction and not find one.
- **It does not bound consumer SQL.** A hand-written statement has no ceiling. The peak formula
  degrades gracefully — `maxBytes + that statement` — but it degrades.
- **It does not protect three or more concurrent `bulkWrite`s.** At the 8 MB default they thrash,
  and the cost of that is measured: the cache is cancelled, not degraded.
- **It changes nothing about churn.** Generated SQL still fills the LRU with single-use entries
  and every eviction is still a `finalize` on the hot path. Unprofiled, and it stays that way.

## 5. Where it touches the code

| File | Change |
|---|---|
| `src/worker/statement-cache.ts` | `createStatementCache({ maxEntries, maxBytes })`; `set(sql, handle, weight)`; running total; §2's loop |
| `tests/unit/statement-cache.test.ts` | signature change across the existing tests, plus §6's new ones |
| `src/worker/worker.ts` | carry `module` through `openedDB`; read the weight in `settle` |
| `src/wa-sqlite.d.ts` | declare `_sqlite3_stmt_status` on the module type |
| `src/types.ts`, `src/pool.ts`, `src/client.ts` | `statementCacheBytes` beside `statementCacheSize`, internal, on the `open` message |
| `src/scheduler.ts`, `src/client.ts` | `__unsafeTestStatementCacheBytes` on `InternalSQLiteClientOptions` (§3.4) |
| `tests/browser/statement-cache.test.ts` | §6's browser assertions |

No public surface. No README change.

## 6. Testing

**Pure module** — the bound, with no SQLite involved:

- A re-set of an existing key leaves the total unchanged. *Falsifier: add instead of replace, and
  two sets of the same key double the total.*
- Insertion is allowed while the total is under the budget and overshoots it. *Falsifier: check
  `total + incoming` instead of `total`, and the second large entry is refused.*
- An entry heavier than the whole budget is accepted, and the next insertion is what pays for it.
  *Falsifier: a `refuse to cache` branch, and the handle comes back as evicted immediately.*
- Eviction returns every handle it drops, and only live ones (`markUncacheable`'s `null` entries
  weigh 0 and are not returned to `finalize`).
- Both bounds fire independently: many small entries hit `maxEntries`, two large ones hit
  `maxBytes`.

**Browser** — the phenomenon, which the pure module cannot see:

- The two templates of a `bulkWrite` are both retained at the default budget: `prepared` is 0
  from the second batch on. *Falsifier: set `statementCacheBytes` below one template and it is 1
  on every batch.*
- Two concurrent `bulkWrite`s on two tables recompile nothing after the first batch of each.
  **This is the regression test for §1's measured +110 %**, and it is the one that would catch a
  future default set too low.

## 7. Answered while writing this, and worth keeping

**Sharing statements across workers or tabs is impossible, not merely unbuilt.** A
`sqlite3_stmt*` is an offset into one WASM instance's linear memory, bound to one connection.
Sharing a cache means sharing the connection, which means a coordinator — and the cross-tab spec
of 2026-08-31 already records why there cannot be one: the four VFS that matter need
`createSyncAccessHandle()`, a SharedWorker cannot open the connection, and spawning a dedicated
worker from inside one throws on Chrome. **The `× poolSize` multiplier is intrinsic; the only
levers on the total are `maxBytes` and `poolSize`.** What *is* shareable is the compiled
`WebAssembly.Module`, and that is a separate deferred entry with its own dead premise.

**Bound values were measured for integers only.** Binding 32 765 integers moves `MEMUSED` by
zero. Blobs and strings allocate elsewhere; `clear_bindings` in `settle` is what releases them,
so the accounted value stays the right one — but do not write that bound values are free.

## 8. Open, and not decided here

- **Whether the default should be measured rather than reasoned.** 8 MB is derived from a
  measured template ceiling and a measured working set, not from a run at 8 MB. A campaign at
  4 / 8 / 16 MB against the two-writer workload would settle it, and §6's browser test is the
  shape it would take.
- **Whether the write designation migrates over a long session.** The concentration on worker 0
  is n=1, one workload, and four reads afterwards did not move it.
