# Wave 3 — Safe generated SQL, atomic `output()`, live debug

**Date:** 2026-08-19
**Branch:** `wave-3-sql-safety`
**Closes:** B4, B5, B6 (see `mem:follow-ups`)
**Decisions applied:** D3 (`mem:resume-plan` §1.1), D5 (§1.3)

---

## 0. Scope and framing

Three backlog items ship on one branch:

- **B4** — unescaped identifier interpolation and unvalidated PRAGMA construction;
  plus the routing obligation that read PRAGMAs return to `read()`.
- **B5** — `output()` rebuilt as a staging table with an atomic rename (D3), and
  `bulkWrite`'s silent batch loss.
- **B6** — the debug subsystem wired behind `debug?: string | boolean`, plus a
  minimal lifecycle logger.

They share one branch because B4 and B5 rewrite the same lines: the identifiers B4
must quote are exactly the ones B5's staging path regenerates. Splitting them means
writing that SQL twice. B6 is independent but small, and the plan wants it live
before wave 5 so the performance work is measurable.

**Commit order:** B4 → B5 → B6-fixes → B6-wiring. `quoteIdent()` must exist before
the staging path generates SQL.

### Decisions taken during this brainstorming

| # | Question | Decision |
|---|---|---|
| 1 | Wave 3 on one branch, or split? | One branch, three items, in the order above. |
| 2 | What becomes of `temp: true`? | **Removed.** See §2.4. |
| 3 | How is the `pragmas` option validated? | **Syntactic validation**, not a fixed name allowlist. See §1.3. |
| 4 | When are client pragmas applied? | **Once, at open**, before `ready`. See §1.4. |
| 5 | What does `bulkWrite` do when a batch fails? | **Stop immediately, latched error.** See §2.5. |
| 6 | How far does the debug wiring go? | **State + lifecycle logger**, no per-query log line. See §3. |
| 7 | How far does `navigator.locks` go? | **Staging sweep only.** The init mutex stays on the SAB until wave 4. See §2.2. |

---

## 1. B4 — safe generated SQL

### 1.1 The actual surface

Verified by grep over `src/`: every SQL interpolation in the project sits at four
sites. There is no fifth.

| Site | What is interpolated |
|---|---|
| `bulk.ts:58` | table name, column names (INSERT) |
| `bulk.ts:114` (`output`'s CREATE TABLE) | table name, column names, column types, `generated` expressions |
| `bulk.ts:159` | derived index name, table name, column names |
| `worker/worker.ts:113` | PRAGMA key and value |

### 1.2 `quoteIdent()`

Lives in `utils.ts`, exported for tests, not part of the public API surface.

```
quoteIdent(name: string): string
```

Wraps in `"`, doubles any internal `"`, rejects a name containing `\0` (throws
`SQLiteError`, code `INVALID_IDENTIFIER`). Applied to table names, column names and
index names at all three `bulk.ts` sites.

Three consequences, accepted:

1. Quoted identifiers are **case-preserving** in `sqlite_master`. SQLite still
   resolves them case-insensitively, but the stored name is now exactly what the
   caller wrote. No consumer exists, so the cost is nil today.
2. The derived index name (`${table}_${cols.join('_')}_IDX`) is assembled from the
   **raw** identifiers and quoted as a whole — quoting the parts first would embed
   quote characters in the name.
3. **`type` and `generated` are not identifiers and cannot be quoted.** They are SQL
   fragments the caller writes (`'INTEGER'`, `GENERATED ALWAYS AS (base * 2)`). They
   are validated by shape instead:
   - `type` must match `/^[A-Za-z][A-Za-z0-9 ]*(\([0-9, ]+\))?$/`
   - `generated` must be parenthesised and contain no `;`

   This is the one channel where caller-authored SQL still reaches the database. It
   is narrowed, not closed, and the JSDoc says so. The trust boundary is the
   application developer, not the end user — unchanged from the original triage.

Validation failures throw `SQLiteError` with code `INVALID_IDENTIFIER`, naming the
offending value.

### 1.3 PRAGMA validation — syntactic, not a name allowlist

Validated when the client is constructed, not on first use, so a bad configuration
fails at `createSQLiteClient()` rather than inside an unrelated query.

- key must match `/^[A-Za-z_]\w*$/`
- value must be one of: an integer, a bare word matching `/^[A-Za-z_]\w*$/`
  (`WAL`, `NORMAL`, `ON`, …), or a quoted string literal, which is re-escaped by
  doubling internal `'`

Everything else is rejected with a `SQLiteError` (code `INVALID_PRAGMA`) naming the
offending key.

A closed list of the ~60 SQLite pragmas was rejected: it makes every legitimate
pragma outside the list unreachable and drifts with SQLite versions, for no
additional protection — no `;`, no parenthesis and no comment marker survives the
syntactic check either.

### 1.4 PRAGMAs applied once, at open

Today `worker/worker.ts:110` builds `PRAGMA k=v;` for every configured pragma and
`:196` prepends that string to **every** query. The JSDoc and the README both say
"applied on open". The documentation is right and the code is wrong.

New behaviour: pragmas execute inside `open()`, immediately after the database is
opened and **before `ready` is posted**. A failing pragma posts `open-error` naming
the pragma — the channel exists since wave 2. `allQueryPragmas` disappears from the
query path.

Implementation notes:

- Some pragmas return a row (`PRAGMA journal_mode=WAL` returns `wal`). The
  statements must be fully stepped and drained, not merely prepared.
- The wave-2 supervisor re-opens on worker restart, so pragmas are re-applied to a
  replacement worker automatically. No extra work.

### 1.5 Read PRAGMAs return to `read()`

A statement is a read pragma when the **whole string** is a single PRAGMA with no
assignment and no argument:

```
/^\s*PRAGMA\s+(\w+\.)?\w+\s*;?\s*$/i
```

Anchoring at `$` does the work for free: `PRAGMA journal_mode; DROP TABLE t` does not
match, and `PRAGMA journal_mode=WAL` does not either — the `=` breaks the match.

`isReadQuery` becomes:

> (opens with a read keyword **and** contains no write keyword anywhere)
> **or** (is a pure read pragma)

`PRAGMA` stays in `WRITE_KEYWORDS`, so the first clause is unaffected and a pragma
hidden after a semicolon still routes to the writer.

**Expected red:** `tests/browser/routing.test.ts` pins the current rejection of read
pragmas with a plain `it` and a comment naming B4. It turns red in this wave. That
red is the signal to rewrite it, in the same commit — along with `assertReadable`'s
JSDoc (`utils.ts:63-64`, `:72`) and the README's error-handling section.

---

## 2. B5 — atomic `output()`, honest `bulkWrite`

### 2.1 Sequence

1. Generate a staging name: `__bsq_staging_<uuid>`, from `crypto.randomUUID()` with
   `-` replaced by `_`. The table lives in `main` — a normal table, never `TEMP`.
2. Acquire a **lifetime lock** (§2.2) and run the **sweep** (§2.3) if this is the
   client's first `output()`.
3. `CREATE TABLE <staging>` with the schema, identifiers quoted per §1.2.
4. Populate through `bulkWrite`, unchanged: un-transacted batches, one lease per
   batch, worker released between batches. This property is load-bearing — D3
   depends on it, and `bulk.ts` must keep calling the **public** `write`.
5. On `close()`: flush, then one **short transaction** through the existing
   `transaction()` (which holds a single lease for its whole lifetime):
   - `DROP TABLE IF EXISTS <target>`
   - `ALTER TABLE <staging> RENAME TO <target>`
   - `CREATE [UNIQUE] INDEX …` for each requested index, **inside the same
     transaction, after the rename**, with final names.

   Indexes are built after the rename because SQLite has no `ALTER INDEX … RENAME`:
   indexes created on the staging table would keep `__bsq_staging_…` names forever,
   and building them with final names before the swap collides with the old table's
   indexes. The lock is held for the index build, which is small next to the row
   inserts.
6. `finally`: `DROP TABLE IF EXISTS <staging>` on every failure path, and release
   the lifetime lock.

### 2.2 The lifetime lock

Each `output()` holds `navigator.locks.request('bsq:staging:<file>:<uuid>')` for as
long as its staging table exists, releasing it only once the table has been renamed
away or dropped.

This is **not** mutual exclusion — nothing contends for that name. It is a liveness
marker: it is what lets another tab's sweep tell an in-flight staging table from an
orphan. A tab that is killed has its locks released by the browser, so its orphans
become collectable immediately, with no timestamp and no grace period.

The init mutex stays on the `SharedArrayBuffer`. Migrating it here would not remove
the SAB — the `ABORTING` flag lives there until BP-1 — so it would buy no visible
benefit while forcing a re-verification of the open path across the four consumer
smoke modes. Wave 4 migrates both at once, after its measurement.

### 2.3 The sweep

Runs at the client's **first `output()`**, not at `open()`: the writer is only
designated lazily on the first write, and a sweep at open would race the *n* workers.

Under `navigator.locks.request('bsq:sweep:<file>', { mode: 'exclusive' })`:

1. `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__bsq_staging_%'`
2. `navigator.locks.query()` — returns held and pending locks for the **whole
   origin**, i.e. across every tab.
3. Drop every staging table whose `bsq:staging:<file>:<uuid>` lock is not held.

Two tabs sweeping at once are serialised by the sweep lock; the second sees the
first's drops already applied.

The decision itself — table names plus held lock names in, names to drop out — is a
**pure function**, unit-tested in Node.

**Degradation:** if `navigator.locks` is unavailable, the sweep is skipped and the
logger says so. A sweep is opportunistic by nature; `output()` does not fail for its
absence.

### 2.4 `temp: true` is removed

Under the staging design a TEMP target is not incoherent the way `mem:resume-plan`
§1.1 states — if the target is TEMP the staging table can be TEMP too, both in the
`temp` database, and `ALTER TABLE … RENAME` works within a single database. The real
limitation is the one that already exists today: a TEMP table lives on one
connection and is invisible to the other pool workers, which is why the existing
characterization test forces `poolSize: 1`.

The option is nevertheless **removed**: one code path fewer, one option fewer, one
test fewer. `output()` always produces a persistent table. This is an API break, free
at `1.0.0-rc.3` with no consumer.

Removed with it: the `temp` field on `OutputOptions` (`bulk.ts:21`), its branch in
the `CREATE TABLE` (`bulk.ts:114`), the JSDoc mention at `client.ts:260` and
`bulk.ts:85`, and `tests/browser/output.test.ts:114-132`.

### 2.5 `bulkWrite` — fail fast, latched

Today `flush()` chains batches on a shared `writePromise`. After one rejection every
later `.then` is skipped — but the rows were already spliced out of the buffer, so
they vanish with no error reaching anyone. `output()`'s `createTablePromise.then(…)`
has the same hole with no `catch` at all.

New behaviour:

- The first rejection is **latched**. Later batches are not attempted.
- `enqueue()` throws immediately once the latch is set, rather than feeding rows into
  a dead sink.
- `close()` rejects with a `SQLiteError`, code **`BULK_WRITE_FAILED`**, carrying the
  original error as `cause` and two counters: `rowsWritten` and `rowsNotAttempted`.
- The same latch covers a failed `CREATE TABLE`.

Continuing on error and aggregating was rejected: under `output()` a failed batch
means the staging table is incomplete and must not be swapped in, so a "load what you
can" mode would put two semantics in one object.

`errors.ts` gains three codes: `INVALID_IDENTIFIER`, `INVALID_PRAGMA`,
`BULK_WRITE_FAILED`.

### 2.6 Visible behaviour change

Today `output()` runs DROP + CREATE eagerly at call time: the target exists, empty,
for the whole load. From now on the previous table stays intact and fully populated
until the swap.

That is exactly the `$out` guarantee being bought, but it is a visible change: a
concurrent reader mid-load now sees the **old** data instead of a partially filled
new table, and a target that did not exist appears only at `close()`.
`tests/browser/output.test.ts` must be updated accordingly.

---

## 3. B6 — the debug subsystem, wired

### 3.1 What wave 1 actually left behind

`mem:resume-plan` §1.3 says the instrumentation call sites already exist,
optional-chained into no-ops, so wiring is small. That is true of the worker and
query levels and **false of the request level**.

- `pool.ts:81-88` and `:247` hold two hooks frozen at `undefined` (the TS 7 trap:
  `undefined as (() => T) | undefined` is required to keep the callable union).
- **`createRequestDebugState` has no call site at all.** Per-request tracking —
  `acquireTime`, `releaseTime`, `affectedRows` — was lost when leases replaced the
  old acquire/release code. That level has to be recreated, not re-plugged.

### 3.2 Where the request level goes

Leases are taken in `queries.ts` and `transaction.ts`, never in `scheduler.ts`, which
must stay pure. So:

- request instrumentation sits at the acquisition points in the callers;
- queue depths come from a new **read-only** `stats()` on the scheduler
  (`{ read, write, available, leased }`), consumed by `debug.state.queue` through the
  same `Proxy` getter already used for `status`, so the value is never stale.

The scheduler learns nothing about debug; it exposes a counter.

### 3.3 The option

`debug?: string | boolean` on `CreateSQLiteClientOptions`:

| Value | Collection | Prefix |
|---|---|---|
| absent / `false` | off — `db.debug` is `undefined` | — |
| `true` | on | `clientPrefix` (`"${name ?? 'SQLite'} ${clientIndex}"`) |
| `string` | on | the string |

`client.ts:292` types `db.debug` as `unknown`; it becomes
`debug?: ClientDebugState`, so the type stops claiming a shape that is always
`undefined`.

### 3.4 Four fixes first, in their own commit

Per §1.3, before anything is wired:

1. **`worker.requests` is unbounded** — it is pushed to on every request and never
   trimmed, so wiring as-is grows memory with the client's total query count. Capped
   like `currentRequest.queries`. This is the blocking one.
2. **Off-by-one** — `if (length > MAX) shift()` peaks at 51 before trimming to 50.
   Becomes `>=`.
3. **`status: 'HAHA'`** (`debug.ts:158`) — unobservable behind the Proxy, but it
   ships. Replaced by a real initial value.
4. `Buffer` — already done, 2026-08-17.

### 3.5 The logger

A small `logger.ts`: `createLogger(prefix, enabled)` returning `{ info, warn, error }`
writing to `console.debug` / `console.warn` / `console.error`, each line prefixed
`[SQLite 1]`.

Called on **lifecycle events only**: worker created, `ready`, `open-error`, crash
(`onerror`), `messageerror`, supervisor restart and eviction, `close()`, and the
skipped sweep of §2.3. There is **no per-query log line** — query throughput belongs
in the state, not in the console.

The per-query `debug?: string` label (already in `SQLiteQueryOptions`) becomes the
request's tag in the state, not a console line.

Rendering a query with `debugSQLQuery` stays display-only, on demand, forever: it
concatenates user values into SQL.

---

## 4. Testing

### 4.1 A structural advantage to exploit

`createBulk({ write })` is already dependency-injected. With a fake `write`, **most of
B5 is testable in Node** in milliseconds: the latch and its counters, the
DROP/RENAME/INDEX sequence and its order, the failure paths, the sweep decision. This
is the scheduler lesson applied to `bulk.ts` — the browser is reserved for what
genuinely needs SQLite and OPFS.

### 4.2 Node unit tests

- `quoteIdent`: internal quotes, `\0` rejection, case preservation
- pragma validation: key shape, the three value forms, rejection message naming the key
- read-pragma routing predicate, in `tests/unit/routing.test.ts` — **explicit `for`
  loop, rstest 0.11.8 has no `it.each`**
- the sweep decision: table names + held lock names → names to drop
- `bulkWrite` latch: first error stops later batches, `enqueue()` throws after the
  latch, `close()` rejects with correct `rowsWritten` / `rowsNotAttempted`
- the emitted DDL sequence for `output().close()`, order included

### 4.3 Browser tests

- the target stays intact and populated throughout the load, then swaps at once
- a failure mid-load leaves the target unchanged and **no** staging table behind
- a hand-made orphan `__bsq_staging_…` is collected at the first `output()`
- `PRAGMA journal_mode` goes through `read()` again
- an invalid pragma surfaces as an `open-error` at open, not as an error on the first
  query
- `db.debug` is `undefined` without the option and populated with it

### 4.4 Falsifiability — the wave 1 rule, maintained

For every test written, name the line whose deletion turns it red. Seven wave-1 tests
passed identically with and without the behaviour they claimed to pin.

### 4.5 Existing tests that change — expected, not regressions

| Test | Why |
|---|---|
| `tests/browser/routing.test.ts` (pinned PRAGMA) | B4 lands; the pin is the signal |
| `tests/browser/output.test.ts:114-132` (`temp`) | option removed |
| `tests/browser/output.test.ts` (observation during load) | §2.6 |
| `tests/browser/bulk-write.test.ts:116` (silent drop) | B5 lands |

---

## 5. Verification and risks

### 5.1 Closing verification

`pnpm check`, `tsc --noEmit`, the full suite, **and `pnpm test:consumer`**. The last
one is not optional in this wave: the worker's open path changes (§1.4), and the four
consumer smoke modes are exactly what covers it.

Standing phase conditions apply — CI green, memories updated, git clean.

### 5.2 Risks flagged, not treated

1. **The final swap is a write transaction.** With no default pragmas the journal
   mode is still `DELETE`, so a concurrent reader can see `SQLITE_BUSY` during the
   swap. This is the behaviour of every write today, but the swap makes it visible on
   a path that used to be a series of small writes. Default pragmas (WAL + NORMAL +
   `busy_timeout`) are wave 5.
2. **`navigator.locks.query()` is what makes the sweep precise.** If it is missing,
   the sweep is skipped rather than made approximate (§2.3).
