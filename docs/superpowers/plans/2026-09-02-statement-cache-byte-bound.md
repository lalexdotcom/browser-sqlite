# Statement cache byte bound — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the statement cache's eviction criterion from a count of entries to a budget in bytes, so a worker's retained statements have a stated ceiling instead of an unbounded one.

**Architecture:** The bound stays where it already is — the pure module `src/worker/statement-cache.ts`, which prepares nothing and finalises nothing. It gains a running byte total and a second bound; `worker.ts` supplies each statement's weight from `sqlite3_stmt_status(stmt, SQLITE_STMTSTATUS_MEMUSED, 0)` at the one place it already calls `cache.set`. No public API changes.

**Tech Stack:** TypeScript, rslib, rstest (two projects: `unit` in Node, `browser` via Playwright on Chromium and Firefox), biome, wa-sqlite 1.1.1 (patched).

**Spec:** `docs/superpowers/specs/2026-09-02-statement-cache-byte-bound-design.md` — read it before Task 1. Its §2 is the rule this plan implements; its §1 is the measurement campaign that chose the numbers.

## Global Constraints

- **Serena's symbolic tools are primary for code.** `get_symbols_overview` / `find_symbol` to read, `replace_symbol_body` / `replace_content` to edit. Built-in Read/Edit on a code file only when a Serena tool has failed. Read/Edit are fine for `.md`.
- **Run `pnpm check` (biome, `--write`) after every modification.** It is configured and the project's convention requires it.
- **No public surface.** No change to `CreateSQLiteClientOptions`, no README change. `statementCacheBytes` travels on the `open` message only; `__unsafeTestStatementCacheBytes` is TEST-ONLY and lives on `InternalSQLiteClientOptions`, never on the public type.
- **`DEFAULT_STATEMENT_CACHE_BYTES = 8 * 1024 * 1024`** — 8 MB per worker. `DEFAULT_STATEMENT_CACHE_SIZE = 32` is unchanged and both bounds stay active (spec §3.2).
- **`SQLITE_STMTSTATUS_MEMUSED = 99`.** `_sqlite3_stmt_status` is exported by all three WASM builds and is NOT wrapped by the JS façade.
- **Falsifiability comments are the house style.** Every test in `tests/unit/statement-cache.test.ts` and `tests/browser/statement-cache.test.ts` carries a `// Falsifiability: <edit> and this is <other value>.` comment. A new test without one does not match the file it lives in.
- **The verification baseline to compare against:** `tsc --noEmit` clean, `pnpm build` clean, **543 tests, 0 failed files**, biome 13 warnings. Read `status` AND `failedFiles` from the report, not just the per-test counters.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `src/worker/statement-cache.ts` | The policy: LRU over `sql → {handle, weight}`, two bounds, spec §2's insertion rule. Still pure — no imports, no effects. |
| `tests/unit/statement-cache.test.ts` | The policy, in Node, against plain integers. Both bounds, and the accounting. |
| `src/worker/worker.ts` | Every effect: carries the Emscripten module to the query path, reads the weight, finalises what eviction returns. |
| `src/wa-sqlite.d.ts` | The one narrow declaration of `_sqlite3_stmt_status` on `WASQLiteModule`. |
| `src/types.ts` / `src/pool.ts` / `src/client.ts` | `statementCacheBytes` relayed from the client to the worker, and the default declared beside `DEFAULT_STATEMENT_CACHE_SIZE`. |
| `src/scheduler.ts` | `__unsafeTestStatementCacheBytes` on `InternalSQLiteClientOptions`, beside the existing `__unsafeTestWriterPolicy`. |
| `tests/browser/statement-cache.test.ts` | What only a real SQLite answers: real weights, real templates, the two-writer regression. |

Two tasks. Task 1 is the policy, inert — real weights would change nothing because no budget is
plumbed yet. Task 2 plumbs the budget AND feeds it the weights, in one task: plumbing alone is
not independently testable, since no assertion can tell a budget that arrived from one that did
not while every weight is `0`.

---

### Task 1: The policy — byte accounting in the pure module

**Files:**
- Modify: `src/worker/statement-cache.ts` (whole file)
- Modify: `src/worker/worker.ts:253` (construction) and its three `cache.set` / `cache.markUncacheable` call sites at `:332`, `:390`
- Test: `tests/unit/statement-cache.test.ts` (whole file)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type StatementHandle = number` (unchanged)
  - `export type StatementCacheBounds = { maxEntries: number; maxBytes: number }`
  - `export const createStatementCache: (bounds: StatementCacheBounds) => StatementCache`
  - `StatementCache.set: (sql: string, handle: StatementHandle, weight: number) => StatementHandle[]` — the weight is **required**, deliberately: an optional one invites the omission spec §2 warns about.
  - `get`, `markUncacheable`, `delete`, `drain` keep their existing signatures.

- [ ] **Step 1: Write the failing tests**

Replace `tests/unit/statement-cache.test.ts` entirely. The first eight tests are the existing ones, ported to the new signature through the `entriesOnly` helper; the seven after them are new.

```ts
import { describe, expect, it } from '@rstest/core';
import { createStatementCache } from '../../src/worker/statement-cache';

/**
 * The entry bound alone. `Number.POSITIVE_INFINITY` is not a magic value in
 * the module — it simply never satisfies `total >= maxBytes`, which is what
 * "this test is about the other bound" means.
 */
const entriesOnly = (maxEntries: number) =>
  createStatementCache({ maxEntries, maxBytes: Number.POSITIVE_INFINITY });

describe('statement cache — the entry bound', () => {
  it('returns a handle it was given', () => {
    const cache = entriesOnly(4);
    expect(cache.set('SELECT 1', 111, 0)).toEqual([]);
    // Falsifiability: delete the `entries.set` in `insert` and this is undefined.
    expect(cache.get('SELECT 1')).toBe(111);
  });

  it('evicts the least recently used, and hands it back to be finalised', () => {
    const cache = entriesOnly(2);
    cache.set('a', 1, 0);
    cache.set('b', 2, 0);
    // 'a' becomes the most recent, so 'b' is next out — not 'a', which
    // insertion order alone would have chosen.
    expect(cache.get('a')).toBe(1);
    // Falsifiability: delete `touch` from `get` and this returns [1].
    expect(cache.set('c', 3, 0)).toEqual([2]);
    expect(cache.get('b')).toBeUndefined();
  });

  it('reports SQL that must not be cached', () => {
    const cache = entriesOnly(4);
    expect(cache.markUncacheable('SELECT 1; SELECT 2')).toEqual([]);
    // Falsifiability: return `entry.handle` instead of 'uncacheable' in `get`
    // and this is null, which the worker would read as a handle.
    expect(cache.get('SELECT 1; SELECT 2')).toBe('uncacheable');
  });

  it('bounds the uncacheable markings with everything else', () => {
    const cache = entriesOnly(2);
    cache.markUncacheable('x');
    cache.markUncacheable('y');
    // Falsifiability: keep the markings in a separate collection and 'x'
    // survives for ever — the second unbounded map the design refuses.
    expect(cache.set('z', 9, 0)).toEqual([]);
    expect(cache.get('x')).toBeUndefined();
  });

  it('returns a handle evicted by a marking', () => {
    const cache = entriesOnly(1);
    cache.set('a', 1, 0);
    // Falsifiability: give `markUncacheable` no return value and handle 1 is
    // leaked — nothing would ever finalise it.
    expect(cache.markUncacheable('b')).toEqual([1]);
  });

  it('drains every live handle and empties', () => {
    const cache = entriesOnly(4);
    cache.set('a', 1, 0);
    cache.markUncacheable('b');
    cache.set('c', 3, 0);
    // Falsifiability: push `null` handles too and close would finalise a
    // marking as if it were a statement.
    expect(cache.drain().sort()).toEqual([1, 3]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.drain()).toEqual([]);
  });

  it('caches nothing at capacity 0', () => {
    const cache = entriesOnly(0);
    // Falsifiability: remove the entry-bound loop from `insert` and this
    // returns [] instead of [1] — the handle is inserted but never ejected.
    expect(cache.set('a', 1, 0)).toEqual([1]);
    expect(cache.get('a')).toBeUndefined();
  });

  it('forgets a deleted entry and returns its handle', () => {
    const cache = entriesOnly(4);
    cache.set('a', 1, 0);
    expect(cache.delete('a')).toBe(1);
    expect(cache.delete('a')).toBeUndefined();
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('statement cache — the byte bound', () => {
  it('replaces the weight of a key it already holds', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    cache.set('a', 1, 60);
    cache.set('a', 1, 60);
    // `settle` calls `set` on every successful exit, a cache hit included.
    // Falsifiability: add the weight instead of replacing it and the total is
    // 120, so this returns [1] and 'a' is gone.
    expect(cache.set('b', 2, 30)).toEqual([]);
    expect(cache.get('a')).toBe(1);
  });

  it('does not evict the entry it is replacing', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    cache.set('a', 1, 10);
    // The handle re-set is the SAME statement the worker is still holding.
    // Falsifiability: return the dropped handle as evicted and the worker
    // finalises the statement it just cached — the worst defect available here.
    expect(cache.set('a', 1, 10)).toEqual([]);
    expect(cache.get('a')).toBe(1);
  });

  it('admits an entry while the total is under the bound, and overshoots', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    cache.set('a', 1, 90);
    // 90 < 100 before the insertion, so 'b' goes in and the total reaches 180.
    // Falsifiability: test `total + weight > maxBytes` instead of `total >=
    // maxBytes` and this returns [1] — the shape that cannot hold two
    // bulkWrite templates.
    expect(cache.set('b', 2, 90)).toEqual([]);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
  });

  it('trims back under the bound before inserting', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    cache.set('a', 1, 90);
    cache.set('b', 2, 90);
    // The total is 180, so the LRU goes until it is under 100 — one eviction,
    // not two: 90 is already under.
    // Falsifiability: evict while `total > 0` and this returns [1, 2].
    expect(cache.set('c', 3, 10)).toEqual([1]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
  });

  it('accepts an entry heavier than the whole bound', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    // Falsifiability: add a "refuse to cache what does not fit" branch and
    // this returns [1] — every bulkWrite template becomes uncacheable at any
    // budget below 3.4 MB.
    expect(cache.set('big', 1, 4000)).toEqual([]);
    expect(cache.get('big')).toBe(1);
    // The next insertion is what pays for it: the total is over the bound, so
    // the cache is emptied before 'small' goes in.
    expect(cache.set('small', 2, 10)).toEqual([1]);
    expect(cache.get('big')).toBeUndefined();
  });

  it('gives a marking no weight', () => {
    const cache = createStatementCache({ maxEntries: 4, maxBytes: 100 });
    cache.set('a', 1, 90);
    cache.markUncacheable('m');
    // Falsifiability: give a marking any weight and the total crosses 100, so
    // this returns [1] and 'a' is evicted by a string that holds no statement.
    expect(cache.set('b', 2, 5)).toEqual([]);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('m')).toBe('uncacheable');
  });

  it('enforces the entry bound while the byte bound is slack', () => {
    const cache = createStatementCache({ maxEntries: 2, maxBytes: 1_000_000 });
    cache.set('a', 1, 1);
    cache.set('b', 2, 1);
    // Falsifiability: drop the entry-bound loop and this returns [] — the
    // churn the design keeps both bounds for.
    expect(cache.set('c', 3, 1)).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:unit -- statement-cache`

Expected: FAIL. `createStatementCache` takes a number, so every call passing an object is a type error and the byte tests fail on the third argument.

- [ ] **Step 3: Rewrite the pure module**

Replace `src/worker/statement-cache.ts` from the `Entry` type down. The header comment (lines 1–12) and the `markUncacheable` doc comment are unchanged and are not reproduced here — keep them.

```ts
/**
 * A cached statement and what it weighs. `handle: null` marks SQL that must
 * never be cached; a marking weighs nothing, so it can never evict a real
 * statement by its size alone.
 */
type Entry = { handle: StatementHandle | null; weight: number };

/**
 * The two bounds, both active. `maxEntries` answers the churn that generated
 * SQL produces; `maxBytes` answers the footprint of a `bulkWrite` template,
 * which is three orders of magnitude heavier than an ordinary statement
 * (`mem:measurements`).
 */
export type StatementCacheBounds = {
  maxEntries: number;
  maxBytes: number;
};

export type StatementCache = {
  get: (sql: string) => StatementHandle | 'uncacheable' | undefined;
  /**
   * Returns the handles evicted by this insertion; the caller finalises them.
   * `weight` is `SQLITE_STMTSTATUS_MEMUSED` and is required on purpose: an
   * optional one would silently account a statement as free.
   */
  set: (
    sql: string,
    handle: StatementHandle,
    weight: number,
  ) => StatementHandle[];
  /** Returns the handles evicted by this marking; the caller finalises them. */
  markUncacheable: (sql: string) => StatementHandle[];
  delete: (sql: string) => StatementHandle | undefined;
  /** Empties the cache and returns every live handle, for close. */
  drain: () => StatementHandle[];
};

export const createStatementCache = ({
  maxEntries,
  maxBytes,
}: StatementCacheBounds): StatementCache => {
  const entries = new Map<string, Entry>();
  /** The sum of every retained entry's weight. Never derived, always kept. */
  let total = 0;

  /** Removes an entry from the map AND from the total. */
  const drop = (sql: string): Entry | undefined => {
    const entry = entries.get(sql);
    if (entry === undefined) return undefined;
    entries.delete(sql);
    total -= entry.weight;
    return entry;
  };

  /** Drops the least recently used entry, collecting its handle if live. */
  const evictOldest = (evicted: StatementHandle[]) => {
    const oldest = entries.keys().next();
    if (oldest.done) return;
    const entry = drop(oldest.value);
    if (entry?.handle != null) evicted.push(entry.handle);
  };

  /**
   * The design's §2 rule.
   *
   * Dropping the key first is what makes a re-set REPLACE its weight rather
   * than add to it — `worker.ts`'s `settle` calls `set` on every successful
   * exit, a cache hit included. The dropped entry is deliberately NOT reported
   * as evicted: it is the same statement the caller is still holding, and
   * finalising it would destroy the statement being cached.
   *
   * The byte loop tests the total BEFORE the insertion and never looks at the
   * incoming weight, so an entry heavier than the whole budget is accepted and
   * the overshoot is exactly one entry — which is what keeps a 2.4 MB template
   * cacheable at any budget, and the peak at `maxBytes + largest statement`.
   */
  const insert = (sql: string, entry: Entry): StatementHandle[] => {
    drop(sql);

    const evicted: StatementHandle[] = [];
    while (total >= maxBytes && entries.size > 0) evictOldest(evicted);

    entries.set(sql, entry);
    total += entry.weight;

    while (entries.size > maxEntries) evictOldest(evicted);
    return evicted;
  };

  return {
    get: (sql) => {
      const entry = entries.get(sql);
      if (entry === undefined) return undefined;
      // A Map iterates in insertion order, so re-inserting is how an entry
      // becomes the most recently used and keys().next() is the least.
      entries.delete(sql);
      entries.set(sql, entry);
      return entry.handle === null ? 'uncacheable' : entry.handle;
    },
    set: (sql, handle, weight) => insert(sql, { handle, weight }),
    markUncacheable: (sql) => insert(sql, { handle: null, weight: 0 }),
    delete: (sql) => drop(sql)?.handle ?? undefined,
    drain: () => {
      const live: StatementHandle[] = [];
      for (const entry of entries.values()) {
        if (entry.handle !== null) live.push(entry.handle);
      }
      entries.clear();
      total = 0;
      return live;
    },
  };
};
```

- [ ] **Step 4: Keep `worker.ts` compiling, with the bound inert**

Three edits, all behaviour-preserving: weight `0` everywhere means `total` stays `0`, so the byte loop never fires and today’s behaviour is exactly preserved. Task 2 replaces the zeros.

At `src/worker/worker.ts:253`:

```ts
  const cache = createStatementCache({
    maxEntries: options.statementCacheSize ?? 0,
    // Task 2 replaces this with the plumbed budget. Until weights are real the
    // total is 0, so no finite value here would change anything.
    maxBytes: Number.POSITIVE_INFINITY,
  });
```

In `settle` (`src/worker/worker.ts:332`):

```ts
      for (const handle of cache.set(sql, stmt, 0)) {
        await sqlite.finalize(handle);
      }
```

`cache.markUncacheable(sql)` at `:390` is unchanged — its signature did not move.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:unit -- statement-cache`
Expected: PASS, 15 tests.

Then the whole suite, because `worker.ts` changed: `pnpm test`
Expected: **550 tests, 0 failed files** (543 baseline plus the seven new byte tests), `status`
green. The browser statement-cache tests must be untouched by this task — if any of them moved, the port was not behaviour-preserving.

- [ ] **Step 6: Format, typecheck, commit**

```bash
pnpm check
pnpm exec tsc --noEmit
git add src/worker/statement-cache.ts src/worker/worker.ts tests/unit/statement-cache.test.ts
git commit -m "refactor(cache): account statement weight in the pure module

The LRU keeps a running byte total and a second bound beside the entry
count. Nothing feeds it yet: worker.ts passes a weight of 0 and an
infinite budget, so behaviour is unchanged. Spec §2.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The budget travels, and is fed

Merged from what were two tasks. Plumbing alone is inert — no test can distinguish a budget
that arrived from one that did not while every weight is `0` — so a reviewer could not
meaningfully approve it on its own.

**Files:**
- Modify: `src/types.ts:51` (the `open` message)
- Modify: `src/pool.ts:135` (deps type), `:154` (destructuring), `:514` (postMessage)
- Modify: `src/client.ts:66` (the default), `:330` (the test-only read), `:1016` (pool worker deps)
- Modify: `src/scheduler.ts:41` (`InternalSQLiteClientOptions`)
- Modify: `src/wa-sqlite.d.ts:29` (`WASQLiteModule`)
- Modify: `src/worker/worker.ts:117` (`openedDB`'s type), `:131` (`OpenOptions`), `:216` (the resolved value), `:253` (construction), `:262` (the destructuring), `:332` (`settle`), `:678` (the `open` handler), plus a module-level helper
- Test: `tests/browser/statement-cache.test.ts`

**Interfaces:**
- Consumes: `createStatementCache({ maxEntries, maxBytes })` and `cache.set(sql, handle, weight)` from Task 1.
- Produces:
  - `statementCacheBytes?: number` on the `open` `ClientMessageData` variant and on `createPoolWorker`'s deps
  - `DEFAULT_STATEMENT_CACHE_BYTES = 8 * 1024 * 1024` (module constant in `src/client.ts`, exported from nothing)
  - `__unsafeTestStatementCacheBytes?: number` on `InternalSQLiteClientOptions`
  - `WASQLiteModule._sqlite3_stmt_status`

**Read before writing the tests.** Spec §3.1's `N − 1`: the rule drops the incoming key before
measuring, so two alternating templates evict each other only when the budget is below **one**
template. A falsifier set below their *sum* does nothing, and a test built on that assumption
passes for the wrong reason.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/statement-cache.test.ts`. `single` and `runsOf` are already defined at
the top of the file.

```ts
/** 5 columns → bulkWrite flushes every floor(32766 / 5) = 6553 rows. */
const BULK_COLUMNS = ['c0', 'c1', 'c2', 'c3', 'c4'];
/** Four batches: three full templates and one partial. */
const BULK_ROWS = 20_000;

const bulkRow = (i: number) => ({ c0: i, c1: i, c2: i, c3: i, c4: i });

const feed = async (bulk: ReturnType<
  Awaited<ReturnType<typeof createTestClient>>['bulkWrite']
>) => {
  for (let i = 0; i < BULK_ROWS; i++) await bulk.enqueue(bulkRow(i));
  return bulk.close();
};

/** Every INSERT batch the pool served, oldest first. */
const insertRuns = (db: Awaited<ReturnType<typeof createTestClient>>) =>
  (db.debug?.workers ?? [])
    .flatMap((w) => w.requests)
    .flatMap((r) => r.queries)
    .filter((q) => q.sql.startsWith('INSERT INTO'));

describe('the byte bound', () => {
  it('holds two statements at the default budget', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    const first = 'SELECT a FROM t';
    const second = 'SELECT a FROM t WHERE a = 1';
    await db.read(first);
    await db.read(second);
    await db.read(first);
    // THE CONTROL, and it is the one the 2026-09-02 campaign proved is
    // load-bearing: if the budget never reaches the worker it defaults to 0,
    // which evicts on every insertion of a DIFFERENT key, and the third read
    // compiles again.
    // Falsifiability: drop `statementCacheBytes` from the `open` postMessage
    // in pool.ts and this is 1.
    expect(runsOf(db, first)[1]?.prepared).toBe(0);
    await db.close();
  });

  it('evicts when the budget cannot hold the other entry', async () => {
    const db = await createTestClient({
      ...single,
      __unsafeTestStatementCacheBytes: 1,
    } as never);
    await db.write('CREATE TABLE t (a)');
    const first = 'SELECT a FROM t';
    await db.read(first);
    await db.read('SELECT a FROM t WHERE a = 1');
    await db.read(first);
    // A one-byte budget cannot hold the other statement, so each insertion
    // evicts its predecessor and the third read compiles.
    // Falsifiability: delete the byte loop from `insert` and this is 0.
    expect(runsOf(db, first)[1]?.prepared).toBe(1);
    await db.close();
  });

  it('retains a bulkWrite template across its batches', async () => {
    const db = await createTestClient(single);
    await db.write(`CREATE TABLE ta (${BULK_COLUMNS.join(',')})`);
    await feed(db.bulkWrite('ta', BULK_COLUMNS));
    const runs = insertRuns(db);
    // The full template weighs ~2.4 MB and is compiled once for three batches.
    // Falsifiability: return `undefined` unconditionally from `cache.get` and
    // every batch compiles.
    expect(runs.length).toBeGreaterThan(2);
    expect(runs[1]?.prepared).toBe(0);
    expect(runs[2]?.prepared).toBe(0);
    await db.close();
  });

  it('holds both templates of two concurrent bulkWrites', async () => {
    const db = await createTestClient(single);
    await db.write(`CREATE TABLE ta (${BULK_COLUMNS.join(',')})`);
    await db.write(`CREATE TABLE tb (${BULK_COLUMNS.join(',')})`);
    await Promise.all([
      feed(db.bulkWrite('ta', BULK_COLUMNS)),
      feed(db.bulkWrite('tb', BULK_COLUMNS)),
    ]);
    // Two writers interleave and their two FULL templates alternate. This is
    // the regression test for the measured +110 % on Firefox: a budget that
    // cannot hold them does not degrade the cache, it cancels it. Four
    // compilations is two full templates plus two partials.
    // Falsifiability: pass `__unsafeTestStatementCacheBytes: 2_000_000` —
    // below ONE template, which is what §3.1's `N − 1` requires — and this
    // climbs to one compilation per batch.
    const compiles = insertRuns(db).reduce((n, q) => n + q.prepared, 0);
    expect(compiles).toBeLessThanOrEqual(4);
    await db.close();
  });

  it('caches a template heavier than the whole budget', async () => {
    const db = await createTestClient({
      ...single,
      __unsafeTestStatementCacheBytes: 1024,
    } as never);
    await db.write(`CREATE TABLE ta (${BULK_COLUMNS.join(',')})`);
    await feed(db.bulkWrite('ta', BULK_COLUMNS));
    const runs = insertRuns(db);
    // The rule never refuses an entry and never reads the incoming weight: a
    // 2.4 MB template is admitted under a 1 KB budget, and because re-setting
    // it drops it first, nothing else is left to push the total over.
    // Falsifiability: add a "refuse to cache what does not fit" branch at the
    // top of `insert` and this is 1.
    expect(runs[1]?.prepared).toBe(0);
    await db.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:browser -- statement-cache`

Expected: FAIL on `evicts when the budget cannot hold the other entry` (the option is not
declared, so nothing evicts and `prepared` is 0). The other four pass already — they are the
regressions this task must not cause, and `holds two statements at the default budget` is the
one that will catch a broken postMessage in Step 3.

- [ ] **Step 3: Declare and relay the budget**

`src/types.ts`, in the `open` variant beside `statementCacheSize`:

```ts
      /** Bytes retained per worker; see `src/client.ts`. Internal. */
      statementCacheBytes?: number;
```

`src/pool.ts`, in the deps type beside `statementCacheSize?: number | undefined;`:

```ts
  statementCacheBytes?: number | undefined;
```

`src/pool.ts`, in the `const { … } = deps;` destructuring, after `statementCacheSize,`:

```ts
    statementCacheBytes,
```

`src/pool.ts`, in the `open` postMessage, after `statementCacheSize,`:

```ts
    statementCacheBytes,
```

`src/client.ts`, after `DEFAULT_STATEMENT_CACHE_SIZE`:

```ts
/**
 * Bytes retained per worker, `SQLITE_STMTSTATUS_MEMUSED`. Not a consumer
 * option, for the same reason as the entry count (spec §3.3).
 *
 * 8 MB is not a memory figure, it is a count of concurrent `bulkWrite`s
 * protected. The cache drops the key being re-set before it measures, so what
 * must fit is the sum of the OTHER entries: N alternating templates need
 * `(N - 1) x 3.4 MB`. 8 MB therefore covers three concurrent writers, with a
 * peak of this value plus the largest single statement — not a multiple of it.
 * A budget that cannot hold them does not degrade the cache, it cancels it
 * (+19 % Chromium, +110 % Firefox, measured 2026-09-02).
 */
const DEFAULT_STATEMENT_CACHE_BYTES = 8 * 1024 * 1024;
```

`src/scheduler.ts`, in `InternalSQLiteClientOptions` after `__unsafeTestWriterPolicy`:

```ts
  /**
   * TEST-ONLY, UNSUPPORTED. The byte bound has no falsifier without it: at a
   * fixed default nothing in the suite can tell a working bound from one that
   * never fires. Absent from the public options type on purpose.
   */
  __unsafeTestStatementCacheBytes?: number;
```

`src/client.ts`, beside the existing `testWriterPolicy` read (around `:330`):

```ts
  // TEST-ONLY, UNSUPPORTED. Read once here and validated, like the writer
  // policy above. See InternalSQLiteClientOptions in scheduler.ts.
  const testCacheBytes = (clientOptions as InternalSQLiteClientOptions)
    .__unsafeTestStatementCacheBytes;
  const statementCacheBytes =
    typeof testCacheBytes === 'number' && testCacheBytes >= 0
      ? testCacheBytes
      : DEFAULT_STATEMENT_CACHE_BYTES;
```

`src/client.ts`, in the `createPoolWorker` call beside `statementCacheSize`:

```ts
      statementCacheBytes,
```

`src/worker/worker.ts`, in `OpenOptions` beside `statementCacheSize`:

```ts
  statementCacheBytes?: number | undefined;
```

`src/worker/worker.ts`, the `open` message handler at `:678`:

```ts
      const {
        file,
        vfs,
        build,
        pragmas,
        statementCacheSize,
        statementCacheBytes,
      } = data;
      open(file, {
        vfs,
        build,
        pragmas,
        statementCacheSize,
        statementCacheBytes,
      });
```

`src/worker/worker.ts`, the construction at `:253`, replacing Task 1's placeholder:

```ts
  const cache = createStatementCache({
    maxEntries: options.statementCacheSize ?? 0,
    maxBytes: options.statementCacheBytes ?? 0,
  });
```

- [ ] **Step 4: Declare the status call, carry the module, read the weight**

`src/wa-sqlite.d.ts`, replacing `type WASQLiteModule = {};` (keep the comment block above it):

```ts
type WASQLiteModule = {
  /**
   * `sqlite3_stmt_status`. Exported by all three builds; the JS façade does
   * not wrap it, and it takes a pointer and returns a number, so `mapStmtToDB`
   * — a JS-side guard only — is not involved. Declared here rather than cast
   * at the call site: the twelve structural `any` in `src/` stay twelve.
   */
  _sqlite3_stmt_status: (stmt: number, op: number, resetFlag: number) => number;
};
```

`src/worker/worker.ts`, near the other module-level constants:

```ts
/**
 * `SQLITE_STMTSTATUS_MEMUSED`. Not in `sqlite-constants.js` — the façade does
 * not wrap the call that uses it.
 */
const SQLITE_STMTSTATUS_MEMUSED = 99;

/**
 * The statement's retained footprint, for the cache's byte bound.
 *
 * Read in `settle` rather than after `prepare` because `settle` is the only
 * place `cache.set` is called, so no branch needs a special case and no state
 * is threaded through the generator. Measured 2026-09-02: the value does not
 * move over a statement's life — after prepare, after binding 32 765 values,
 * after step, after reset — so where it is read cannot change it. Synchronous
 * and not an I/O call, so it suspends nothing on the Asyncify build.
 */
const stmtWeight = (module: WASQLiteModule, stmt: number) =>
  module._sqlite3_stmt_status(stmt, SQLITE_STMTSTATUS_MEMUSED, 0);
```

`src/worker/worker.ts:117`:

```ts
let openedDB:
  | Promise<{ sqlite: SQLiteAPI; module: WASQLiteModule; db: number }>
  | undefined;
```

`src/worker/worker.ts`, inside `open`'s `locks.withLock` callback, replacing `return { sqlite, db };` — `module` is already destructured by the enclosing `.then` and is in scope:

```ts
          return { sqlite, module, db };
```

`src/worker/worker.ts:262`, in `query`:

```ts
    const { sqlite, db, module } = await openedDB;
```

`src/worker/worker.ts`, in `settle`, replacing Task 1's zero:

```ts
      for (const handle of cache.set(sql, stmt, stmtWeight(module, stmt))) {
        await sqlite.finalize(handle);
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:browser -- statement-cache`
Expected: PASS, all five new tests plus the file's existing ones.

Then the whole suite, then Firefox — the cost this bound exists to avoid was measured there, at
+110 %:

```bash
pnpm test
TEST_BROWSER=firefox pnpm test:browser -- statement-cache
```

Expected: **555 tests, 0 failed files** on Chromium (550 after Task 1, plus five browser tests);
the statement-cache file green on Firefox.
Read `status` AND `failedFiles`, not only the per-test counters.

- [ ] **Step 6: Run the claimed falsifiers, then restore**

Not optional: the project's convention is that a claimed falsifier has been run. For each, make
the edit, confirm the named test goes red **and no other**, revert.

1. Drop `statementCacheBytes` from the `open` postMessage in `pool.ts` → `holds two statements at the default budget` reports 1.
2. Delete the byte loop (`while (total >= maxBytes …)`) from `insert` → `evicts when the budget cannot hold the other entry` reports 0.
3. `__unsafeTestStatementCacheBytes: 2_000_000` on `holds both templates of two concurrent bulkWrites` → `compiles` exceeds 4. **Verify it is 2 000 000 and not 4 000 000**: a budget above one template changes nothing, which is spec §3.1's whole point.
4. `if (entry.weight > maxBytes) return [entry.handle]` at the top of `insert` → `caches a template heavier than the whole budget` reports 1.

Then `git diff` and confirm it is empty of all four.

- [ ] **Step 7: Format, typecheck, build, commit**

```bash
pnpm check
pnpm exec tsc --noEmit
pnpm build
git add src/types.ts src/pool.ts src/client.ts src/scheduler.ts src/wa-sqlite.d.ts src/worker/worker.ts tests/browser/statement-cache.test.ts
git commit -m "feat(cache): bound the statement cache in bytes

Each retained statement is accounted at its SQLITE_STMTSTATUS_MEMUSED
weight, read in settle, against an 8 MB per-worker budget relayed on the
open message. A worker's cache now has a stated ceiling — the budget plus
the largest single statement — instead of 32 entries that can weigh
3.4 MB each. Spec §2, §3.1, §3.4, §3.5, §3.6.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 8: The CHANGELOG, in the words §4 requires**

Add to the unreleased section of `CHANGELOG.md` under `### Changed`. The wording is
load-bearing: a reader who expects a memory reduction will not find one.

```markdown
- The per-worker statement cache is now bounded in bytes (8 MB) as well as in
  entries (32). This makes the worst case finite and stated; it does not reduce
  the common footprint — one `bulkWrite` retained ~3 MB before and retains ~3 MB
  now. What it bounds is an application whose workers accumulate many large
  templates, where the entry bound alone allowed tens of megabytes. Internal:
  no option changes.
```

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): the byte bound buys a ceiling, not a saving

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After the last task

Not part of any task, and the user's call:

- `mem:follow-ups` — delete the statement-cache entry. It is the backlog, and the backlog no longer holds this.
- `mem:measurements` — the 2026-09-02 campaign stays; nothing to correct.
- Spec §8 remains open on purpose: the 8 MB default is derived from two measurements but has not been run at 8 MB, and the write designation's concentration on one worker is n=1.
