# PREPARE-1 — the prepared-statement cache

**STATUS: designed, not built. 2026-08-27.**

Branch: `feat/statement-cache`. Designed in one session against
`mem:follow-ups` § "The prepared-statement cache — discussed 2026-08-27, not
built", which this document supersedes. Three of that section's claims turned
out to be wrong once `wa-sqlite`'s source was read; §2 records which, because
each was a load-bearing assumption about how much work this is.

Scope: the worker's statement execution path only. No public API changes, no
README changes, no change to routing, leasing, the barrier or back-pressure.

## 1. What exists today, and where the gain is

Both worker execution sites go through `sqlite.statements(db, sql)`:
[`src/worker/worker.ts:255`](../../../src/worker/worker.ts#L255) in the query
generator, and [`src/worker/worker.ts:204`](../../../src/worker/worker.ts#L204)
in the PRAGMA loop that runs once at open.

That generator loops on `sqlite3_prepare_v3`, yields each statement, and in its
`finally` finalises the statement and frees the SQL buffer
([`node_modules/wa-sqlite/src/sqlite-api.js:655-724`](../../../node_modules/wa-sqlite/src/sqlite-api.js)).
**Every statement this library executes is therefore compiled and thrown
away** — every `BEGIN`, `COMMIT`, `ROLLBACK`, every barrier statement, every
`bulkWrite` batch with its ~65 KB of placeholders.

For a single execution, a prepared statement and a one-shot statement are the
same three calls and cost the same. **The entire gain is reuse.** That makes the
cache the feature; a public `prepare()` is not (§2.2).

Two call sites make the gain concrete:

- `BARRIER_SQL = 'SELECT count(*) FROM sqlite_master'`
  ([`src/epochs.ts:25`](../../../src/epochs.ts#L25)) — a constant string, applied
  on every barrier. The most frequent single statement in the system.
- the `bulkWrite` INSERT template
  ([`src/bulk.ts:199`](../../../src/bulk.ts#L199)) — identical for every full
  batch; only the final partial batch differs. Since `feat/last-writer-routing`
  a `bulkWrite` tends to stay on one worker, so the cache warms once rather than
  `poolSize` times, and `tx.bulkWrite()` is pinned to one worker by
  construction.

## 2. Three corrections to the prior notes

### 2.1 `unscoped` is the supported mechanism, not a workaround

`mem:follow-ups` states that a cache "leaves the generator for `prepare_v3`
directly". It does not have to, and must not.

`sqlite3.statements(db, sql, options)` accepts `options.unscoped`: with it set,
the generator's `maybeFinalize` does not finalise the yielded statement
([`sqlite-api.js:680`](../../../node_modules/wa-sqlite/src/sqlite-api.js)). The
option is declared and documented in wa-sqlite's own shipped types —
`SQLitePrepareOptions`, `node_modules/wa-sqlite/src/types/index.d.ts:140`:
"statement handles … are normally valid only within the scope of an iteration.
Set `unscoped` to `true` to give iterated statements an arbitrary lifetime."
`options.flags` is the same object's channel for `SQLITE_PREPARE_PERSISTENT`.

The SQL buffer is still freed by the generator's `finally` under `unscoped`.
That is safe: `sqlite3_prepare_v3` copies the text, which is what makes
`sqlite3_sql(stmt)` work at all.

### 2.2 Bypassing the generator is closed, not merely inadvisable

`mapStmtToDB` is private to `sqlite-api.js` and is populated in exactly one
place — inside `statements()`, at
[`sqlite-api.js:717`](../../../node_modules/wa-sqlite/src/sqlite-api.js).
`verifyStatement` throws `SQLITE_MISUSE` for any statement absent from it
([`sqlite-api.js:92`](../../../node_modules/wa-sqlite/src/sqlite-api.js)), and
`bind_collection`, `column_names`, `step`, `reset` and `clear_bindings` all call
it.

A statement prepared outside `statements()` is therefore rejected by the whole
wa-sqlite façade. Owning the prepare loop would mean forking the façade, not
writing a loop. This is the argument that settles the approach; it is not a
preference.

### 2.3 The cleanup is smaller than stated, and the correctness risk is elsewhere

`mem:follow-ups` calls the replaced cleanup "the real work". Half of it is
inherited intact: allocation, freeing, `retry`, and registration in
`mapStmtToDB` all stay inside the generator. What we take over is finalisation.

The real correctness risk is one the prior notes do not mention, found by
reading `bind_collection`
([`sqlite-api.js:206-218`](../../../node_modules/wa-sqlite/src/sqlite-api.js)):

```js
const value = bindings[key];
if (value !== undefined) {
  sqlite3.bind(stmt, i, value);
}
```

A parameter whose value is `undefined` is **not bound at all** — a skipped
`?NNN`, a key missing from the object form of `:VVV` / `@VVV` / `$VVV`, an array
shorter than the placeholder count. Today that is harmless: the statement was
just compiled, and an unbound parameter is NULL. On a reused statement it means
*keeping the value bound by the previous execution*. Two calls, the first
supplying `:name` and the second omitting it, would write the first call's value
while the caller believes it is writing NULL.

`clear_bindings` is therefore not hygiene here. It is the condition under which
reuse is correct, and §5 treats it as such.

## 3. Scope

### 3.1 In

A per-worker, bounded, LRU cache of single-statement SQL, keyed by the exact SQL
string, covering every statement the query path executes.

### 3.2 Out, with the reason

**No public `prepare()`.** A prepared statement belongs to one connection and
this pool has `poolSize` of them. A public handle would either pin its caller to
one worker — destroying the concurrent reads the lease system exists to
protect — or prepare lazily on whichever worker serves the call, which *is* a
cache keyed by SQL. The only thing an explicit API would add is a guarantee that
a hot statement is never evicted, and that is a number, not a handle.

**No consumer-facing option in this wave.** The capacity is a constant declared
client-side next to `DEFAULT_POOL_SIZE` and sent to the worker in the `open`
message. The worker knows only what it is told, so exposing
`statementCacheSize` later is one options line, not a redesign. It is not
exposed now because no measurement asks for another number, and a public `0`
would create a second execution path to keep tested forever.

**Multi-statement strings are not cached** (§4.2). They stay on today's path.

**The open-time PRAGMA loop is not cached.** It runs once per worker, before a
cache has any meaning.

**No README change.** The cache is invisible to the consumer: no option, no
constraint, no behaviour change. The project rule is that the README states what
something costs the consumer, and here the answer is nothing.

## 4. The cache unit and the execution path

### 4.1 `src/worker/statement-cache.ts` — pure bookkeeping

A new module that prepares nothing, finalises nothing, and does not import
wa-sqlite. It holds a `Map` from SQL to handle in LRU order and answers four
questions; `worker.ts` performs every effect.

```
createStatementCache(capacity)
  get(sql)            → handle | 'uncacheable' | undefined
  set(sql, handle)    → handle[] to finalise (the evicted)
  markUncacheable(sql)
  delete(sql)         → handle | undefined
  drain()             → handle[]
```

Three properties this boundary buys:

**It is unit-testable in Node for free.** A sqlite statement is an integer and
the cache only files it. `tests/unit/statement-cache.test.ts` manipulates
numbers; no fake façade is needed. This is the role `mem:architecture` describes
for `supervisor.ts` and `scheduler.ts` — a pure policy tested outside the
browser, in a subsystem whose remainder is browser-only.

**One bound covers two collections.** The uncacheable marking (§4.2) lives in
the same `Map` with `null` for a value and is evicted like everything else.
Otherwise generated SQL would grow a second unbounded reservoir beside the one
just bounded.

**`set` returns the evicted instead of dropping them.** The cache cannot
finalise — `finalize` is asynchronous and belongs to wa-sqlite. It returns the
list and `worker.ts` finalises it. Failing to consume the return value is
visible, so no handle can be lost by omission.

Eviction can only ever strike an unused statement: it happens at `set`, between
queries, and a worker holds one lease at a time, so the only live statement at
that instant is the one being inserted.

### 4.2 Detecting a single statement without consuming the generator

The cache key is the whole SQL string, so caching the *first* statement of a
multi-statement string under that key would later execute only that first
statement. The distinction is mandatory.

It cannot be made by counting what the generator yields. `first()` breaks after
one row and a signal-aborted read breaks earlier still; both are hot, and
neither would ever learn the count.

`sqlite3_sql(stmt)` returns a verbatim copy of the text that produced *that
statement* — its own span of the input, not the whole input. It is wrapped by
the façade as `sqlite3.sql` ([`sqlite-api.js:644`](../../../node_modules/wa-sqlite/src/sqlite-api.js)).
So at the first statement yielded, before any `step`, compare the statement's
text against the input string, both normalised. Equal → one statement, cachable.
Different → multi-statement, mark uncacheable. One prepare, no consumption,
verdict available before the first row.

`sqlite3_sql` normalises nothing: the two SQLite functions that transform text
are `sqlite3_expanded_sql` (substitutes bound values) and
`sqlite3_normalized_sql` (replaces parameters and literals with `?`). Only
`_sqlite3_sql` and `_sqlite3_expanded_sql` are compiled into this build —
`normalized_sql` is absent. All five placeholder forms (`?`, `?NNN`, `:VVV`,
`@VVV`, `$VVV`) come back exactly as written.

**The failure direction is a false negative**: SQL whose normalisation does not
land exactly on the returned text is not cached. Correct, merely without gain,
and it touches neither `BARRIER_SQL` nor the `bulkWrite` template, both
generated by our own code.

**A false positive would be the worst defect available here** — every
multi-statement string would run only its first statement. It rests entirely on
`sqlite3_sql` returning the span rather than the whole input. Task 1 of the plan
falsifies that before the cache is written:

| input | expected |
|---|---|
| `SELECT 1` | cachable |
| `SELECT 1;` | cachable |
| `SELECT 1;\n  SELECT 2` | **not cachable** |
| `SELECT 1\n  WHERE 1=1` | cachable |
| `SELECT 1; ` | cachable |

### 4.3 The key is never normalised

The cache key is `sql` byte for byte: no `trim`, no `toLowerCase`, no whitespace
folding. Two spellings differing by case or by a newline are two entries — one
extra prepare, once, and no collision is possible.

This is required, not cautious. `SELECT 1 AS foo` and `SELECT 1 AS FOO` produce
different column names, therefore different keys in the row objects `query()`
builds from `column_names`. A case-folded key would return a statement whose
columns do not match the SQL the caller asked for.

Normalisation exists only for the tail test of §4.2, between two texts derived
from *the same input string* — case is identical on both sides by construction,
so nothing is folded. It touches only edge whitespace and one trailing
semicolon, applied identically to both sides. An interior newline is present on
both sides in the same place and changes nothing.

### 4.4 The three branches

`query()` keeps its generator shape, its `chunkSize`, its credit gate and its
final `yield sqlite.changes(db)`. What changes is upstream:

| `cache.get(sql)` | path |
|---|---|
| a handle | execute it directly; `statements()` is never entered |
| `'uncacheable'` | today's path, unchanged |
| `undefined` | `statements(db, sql, { unscoped: true, flags: SQLITE_PREPARE_PERSISTENT })`, verdict per §4.2 |

In the multi-statement branch each statement is finalised as soon as its
execution ends, before the generator prepares the next — today's exact schedule.
`unscoped` makes us hold nothing extra.

## 5. Lifetime discipline

### 5.1 Every exit resets

`reset` + `clear_bindings` on the current statement in a single `finally`
covering all three branches, whatever the exit: normal completion, `first()`'s
`break`, `gate.stop()`, an exception. Then, only for the "unknown and cachable"
branch, `cache.set(sql, stmt)` and finalisation of what `set` returns.

`sqlite3_reset` ends the statement's implicit transaction, which is what keeps a
cached statement from holding a read transaction open — the failure that poisons
the barrier and meets HANDLE-1. `clear_bindings` is the §2.3 correctness
condition.

The alternative — finalise and evict on any abnormal exit — was rejected because
`first()`'s early break is a *normal, hot* exit. Under that rule `first()` would
never benefit from the cache and would pay a `finalize` on every call.

**On a SQLite error**, including one thrown by `reset` or `clear_bindings`
themselves, the statement is finalised and evicted. Errors are cold, and this
removes any need to reason about the state of a statement that failed.

A statement in the cache is therefore clean by invariant, so entry costs no
second clearing.

### 5.2 Close drains before it closes

SQLite refuses to close a connection carrying live statements; `close(db)` would
return `SQLITE_BUSY` and the `close` path's `catch` would swallow it, leaving
the database open.

The drain sits at one exact point: **after `idleUntilQueryEnds()`**, which
guarantees the in-flight query has finished and its statement is already reset
and filed, and **before `sqlite.close(db)`**. `cache.drain()` returns every
handle, `worker.ts` finalises them, then closes.

A worker killed mid-flight finalises nothing and needs to: the whole WASM
instance dies with it.

### 5.3 Schema changes, and the stale column names they expose

A statement prepared under v2 semantics re-prepares itself automatically when
the schema has moved; `step` surfaces an error only if re-preparation fails. No
mechanism is added — but a test is, because this is an inherited guarantee we do
not want to discover missing.

The consequence is a real defect in the current code, widened by the cache.
`query()` reads `column_names(stmt)` **before** the first `step`, while
re-preparation happens *during* `step`. On a cached `SELECT *` followed by
`ALTER TABLE ADD COLUMN`, the names read beforehand describe the old table while
`row()` returns the new one — correctly populated rows under wrong keys. The
window exists today for the duration of a prepare; the cache widens it to the
worker's lifetime.

**Fix: read `column_names` after the first `step` that returns `SQLITE_ROW`.**
This removes the class entirely and saves a wasted call on every write — an
`INSERT` returns `DONE` and has no columns, yet pays for that computation today.

## 6. Instrumentation

The compilation counter rides exactly the path `affected` already rides. The
`done` message carries `affected: number`
([`src/types.ts:74`](../../../src/types.ts#L74)) and `debug.ts` files it into
`QueryDebugState.affectedRows` ([`src/debug.ts:96`](../../../src/debug.ts#L96)).
`prepared: number` is added to both: the count of statements the generator
yielded during that query — zero on a cache hit.

No new message type, no new channel, one integer on a path that already carried
one.

## 7. Tests

**Unit** (`tests/unit/statement-cache.test.ts`), handles as integers: LRU order;
`set` returning the evicted; the uncacheable marking sharing the bound and being
evicted like the rest; `drain` emptying and returning everything; capacity 0
caching nothing.

**Browser** — what only a real SQLite can answer:

| test | what it locks down |
|---|---|
| the §4.2 table | tail detection, including the negative multi-statement case |
| `:VVV` with the key, then without | `clear_bindings`; the silent corruption of §2.3 |
| `close` after queries | the drain before `close`, otherwise a swallowed `SQLITE_BUSY` |
| `ALTER TABLE ADD COLUMN`, then re-run a `SELECT *` | automatic re-preparation **and** column names read after the first `ROW` |
| same SQL twice under `debug`, `poolSize: 1` | `prepared: 0` on the second — the non-regression assertion |
| repeated `first()` | the hot early exit: reset, no finalise, hit on the next call |

`poolSize: 1` in the counter test is deliberate: at the default size two
executions can land on two workers and compile once each, which is correct and
unreadable.

**Baseline not to move** (`mem:state`, 2026-08-27): 410 tests, 0 failed files,
`tsc --noEmit` clean, `pnpm build` clean. Read four fields from the report —
`status` and `failedFiles` included.

## 8. The measurement campaign

Numbers are presented at delivery, not during. The harness lives in the
scratchpad, not in the repository, so that it runs unchanged against a worktree
of `main` for the "before" and against the branch for the "after".

### 8.1 Axes

**Not several VFS — two builds.** The cost removed is compilation: CPU inside
the WASM module, no I/O once the schema is cached. The absolute saving should
not depend on the VFS. But on the `async` build every descent into the VFS goes
through Asyncify, including those `sqlite3_prepare_v3` makes while reading the
schema, so a compilation there can suspend and resume the stack. **The gain may
be larger on `async` than on `sync`** — that is the only variation expected.

So: one VFS from the `sync` column, and `OPFSAdaptiveVFS`, which cannot use it
and leads with `async` ([`src/types.ts:198-200`](../../../src/types.ts#L198-L200)).
Crossed with Chromium and Firefox: four cells. `jspi` is out — Chromium only, so
no cross-engine comparison exists; it will be recorded as not measured rather
than left to look covered.

### 8.2 Workloads

Three, answering different questions:

- **repeated identical reads** — isolates the compilation cost. A microbenchmark;
  its percentage means nothing outside its own context.
- **`bulkWrite`** — what a consumer writes by default, and the number they will
  live with. Expect it smaller: each batch is its own transaction, so ~300
  commits and as many OPFS fsyncs per million rows, and commit cost can drown
  the compilation saving. **A small number here is not a failure, it is a
  signal-to-noise ratio**, and it will be presented as such rather than
  replaced by a flattering workload.
- **`tx.bulkWrite`** — one commit instead of ~300, cache warmed once on a worker
  pinned by construction. The clearest reading of the mechanism.

The gap between the last two is itself a result: it prices the intermediate
commits, an open question in `mem:follow-ups`, answered in passing without
building anything for it.

### 8.3 What is reported

**Gain per cell** (workload × VFS/build × engine) as a percentage or multiplier —
never one global figure, because the denominator is the workload. **Milliseconds
saved per execution alongside it**, because that is the only quantity that
transfers: a cell's percentage predicts nothing about its neighbour, while the
saving is the same compilation removed everywhere. That is what will let us say
anything about the seven VFS we do not measure.

**Prepare counts.** The "after" is measured by §6's counter. The "before" is not
and cannot be — the counter does not exist on `main`. It is structural: one
compilation per execution, by construction of the generator, and it will be
written in those words rather than as a reading.

**Footprint.** `Module._sqlite3_stmt_status(stmt, 99, 0)`
(`SQLITE_STMTSTATUS_MEMUSED`) per statement, and `_sqlite3_memory_used()` for
the SQLite heap before and after warming. Both are exported by the WASM build
even though the JS façade does not wrap them; both take a pointer and return a
number, so `mapStmtToDB` — a JS-side guard only — is not involved. Two points:
the `bulkWrite` template and an ordinary read, each beside the length of its SQL
string. If the bytes-per-character ratio is stable between them it becomes a
usable rule for sizing the bound; if it is not, it is written as measured and
not extrapolated. This is an absolute measurement with no "before": on `main`
statements are finalised, there is nothing to weigh.

Three things hold memory, and only one is the cache itself: the compiled VDBE
program per retained statement; the bound values, which is why §5.1's
`clear_bindings` also stops a cached `bulkWrite` template from pinning 32 766
bound values — blobs included — for the worker's lifetime; and the multiplier,
one cache per worker, times `poolSize`. Emscripten never returns heap to the
system, so a peak is acquired for the worker's life.

### 8.4 Where the numbers land

`mem:measurements`, with date and method, and the unreleased section of
`CHANGELOG.md`. Nothing in the README (§3.2). At closure, the
"No prepared-statement cache" entry and the "discussed, not built" section leave
`mem:follow-ups`.

## 9. Deferred, with where each is tracked

- **A byte budget for the bound.** The capacity stays in entries. If §8.3 shows
  the `bulkWrite` template dwarfing an ordinary statement by an order of
  magnitude, the LRU's eviction criterion moves to bytes fed by `MEMUSED` — a
  measured decision, inside the pure module, redesigning nothing.
- **Caching multi-statement strings** (§4.2). Widening the stored value from
  `handle` to `handle[]` is the whole change; the cost is elsewhere — the bound
  must count statements rather than entries, `reset` + `clear_bindings` must
  apply to each, and a statement throwing mid-string obliges resetting those
  already run. Three more obligations on the exact point §5 identifies as the
  work. DDL and migrations run once; the payoff is not there.
- **`statementCacheSize` as a consumer option** (§3.2).

## 10. Acceptance

1. `pnpm check` clean; `tsc --noEmit` clean; `pnpm build` clean.
2. The §7 baseline holds — 410 existing tests still green, read on four fields —
   plus the new unit and browser tests.
3. The §7 counter test passes: the same SQL executed twice reports
   `prepared: 0` the second time.
4. The four cells of §8.1 measured on all three workloads, reported as §8.3
   prescribes.
