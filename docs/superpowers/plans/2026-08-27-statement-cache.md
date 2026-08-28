# Prepared-statement cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop compiling every statement twice — keep a bounded, per-worker LRU of prepared statements keyed by the exact SQL string, so repeated SQL (`BARRIER_SQL`, every full `bulkWrite` batch) is compiled once per worker instead of once per execution.

**Architecture:** wa-sqlite's own generator keeps preparing, with `{ unscoped: true }` so it does not finalise what it yields; the worker takes over exactly one obligation, the statement's lifetime. A pure module in `src/worker/statement-cache.ts` does the bookkeeping and returns handles for the worker to finalise; `worker.ts` performs every effect. A single statement is distinguished from a multi-statement string by comparing `sqlite3_sql(stmt)` — the statement's own span of the input — against the input itself, before the first `step`.

**Tech Stack:** TypeScript, rstest (`pnpm test:unit`, `pnpm test:browser`), biome (`pnpm check`), wa-sqlite pinned at `github:rhashimoto/wa-sqlite#v1.1.2`. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-statement-cache-design.md` — read it first. §2 records three assumptions from `mem:follow-ups` that did not survive reading `sqlite-api.js`; §4.2 carries the one premise the whole design rests on and how it is falsified.

## Global Constraints

- **No public API change.** No `prepare()`, no consumer option, no README change (spec §3.2). `statementCacheSize` travels in the `open` message but is not exposed on `createSQLiteClient`.
- **The cache key is the exact SQL string** — no `trim`, no `toLowerCase`, no whitespace folding (spec §4.3). Normalisation exists only for the tail test of §4.2.
- **`clear_bindings` on every non-error exit is a correctness condition, not hygiene** (spec §2.3): `bind_collection` skips `undefined` values, so a reused statement would keep the previous execution's bindings.
- **A statement that errored is finalised and evicted, never reset** — `sqlite3_reset` returns the failed step's error code, so `sqlite.reset` throws on exactly the statements you must not reset.
- **English in code, comments, commits and docs.** French only in chat.
- **Serena's symbolic tools are primary for code edits.** Built-in Read/Edit are for `.md` and config only.
- **Every test names the line whose deletion makes it fail**, in a comment (`mem:lessons`). A reasoned claim is not enough: delete the line, observe red, restore, observe green, and report both.
- **Run `pnpm check` after every modification.** Read four fields from the test report — `status`, `failedFiles`, `failedTests`, `passedTests`. A file-level failure does not show in the per-test counters.
- **Every commit lands on green.** The pre-commit hook runs the whole suite and refuses a red tree, so a failing test and the code that satisfies it belong to the same commit (`mem:conventions`).
- **Baseline to hold:** 410 tests, 0 failed files, `tsc --noEmit` clean, `pnpm build` clean, biome 13 warnings with none in touched files.

**State of the working tree at plan time:** clean, on `feat/statement-cache`, one commit ahead of `main` carrying the spec. No source file has been touched.

## File Structure

- `src/worker/statement-cache.ts` — **new**. Pure LRU bookkeeping over `sql → handle`. Prepares nothing, finalises nothing, imports nothing.
- `src/worker/worker.ts` — the three-branch execution path, the lifetime discipline, the drain before `close`, the prepare counter.
- `src/types.ts` — `statementCacheSize` on the `open` message, `prepared` on the `done` message.
- `src/pool.ts` — carries `statementCacheSize` into the `open` postMessage; files `prepared` into the debug state.
- `src/client.ts` — `DEFAULT_STATEMENT_CACHE_SIZE`, passed to the pool worker deps.
- `src/debug.ts` — `prepared` on `QueryDebugState`.
- `tests/unit/statement-cache.test.ts` — **new**. The pure module, handles as integers.
- `tests/browser/statement-cache.test.ts` — **new**. Everything only a real SQLite can answer.
- `CHANGELOG.md` — the unreleased section.

---

### Task 1: the pure cache module

Bookkeeping only, with nothing wired to it. It exists, it is bounded, it is unit-tested, and no product code imports it yet.

**Files:**
- Create: `src/worker/statement-cache.ts`
- Test: `tests/unit/statement-cache.test.ts`

**Interfaces:**
- Produces: `export type StatementHandle = number`; `export type StatementCache`; `export const createStatementCache: (capacity: number) => StatementCache`, with methods `get(sql) → StatementHandle | 'uncacheable' | undefined`, `set(sql, handle) → StatementHandle[]`, `markUncacheable(sql) → StatementHandle[]`, `delete(sql) → StatementHandle | undefined`, `drain() → StatementHandle[]`.

**Deviation from the spec, deliberate:** spec §4.1 sketches `markUncacheable` with no return value. It returns the evicted handles here, for the same reason `set` does — marking inserts an entry, an insertion can evict a real handle, and a dropped handle is a leaked statement that nothing would ever finalise.

- [ ] **Step 1: Write the module**

```ts
/**
 * A per-worker LRU of prepared statements, keyed by the exact SQL string.
 *
 * Pure bookkeeping: this module prepares nothing and finalises nothing.
 * `worker.ts` owns every effect, which is what lets the policy be tested in
 * Node against plain integers in a subsystem whose remainder only runs in a
 * browser — the role `mem:architecture` describes for `scheduler.ts` and
 * `supervisor.ts`.
 */

/** A `sqlite3_stmt` pointer. Opaque here: the cache only files it. */
export type StatementHandle = number;

/**
 * `null` marks SQL that must never be cached — a multi-statement string,
 * whose first statement would otherwise be replayed alone under the key of
 * the whole string. The marking shares the LRU with real entries on purpose:
 * kept apart, generated SQL would grow a second unbounded map beside the one
 * this bound exists to close.
 */
type Entry = StatementHandle | null;

export type StatementCache = {
  get: (sql: string) => StatementHandle | 'uncacheable' | undefined;
  /** Returns the handles evicted by this insertion; the caller finalises them. */
  set: (sql: string, handle: StatementHandle) => StatementHandle[];
  /** Returns the handles evicted by this marking; the caller finalises them. */
  markUncacheable: (sql: string) => StatementHandle[];
  delete: (sql: string) => StatementHandle | undefined;
  /** Empties the cache and returns every live handle, for close. */
  drain: () => StatementHandle[];
};

export const createStatementCache = (capacity: number): StatementCache => {
  const entries = new Map<string, Entry>();

  // A Map iterates in insertion order, so re-inserting is how an entry
  // becomes the most recently used and keys().next() is the least.
  const touch = (sql: string, entry: Entry) => {
    entries.delete(sql);
    entries.set(sql, entry);
  };

  const evict = (): StatementHandle[] => {
    const evicted: StatementHandle[] = [];
    while (entries.size > capacity) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      const entry = entries.get(oldest.value);
      entries.delete(oldest.value);
      if (typeof entry === 'number') evicted.push(entry);
    }
    return evicted;
  };

  return {
    get: (sql) => {
      const entry = entries.get(sql);
      if (entry === undefined) return undefined;
      touch(sql, entry);
      return entry === null ? 'uncacheable' : entry;
    },
    set: (sql, handle) => {
      touch(sql, handle);
      return evict();
    },
    markUncacheable: (sql) => {
      touch(sql, null);
      return evict();
    },
    delete: (sql) => {
      const entry = entries.get(sql);
      entries.delete(sql);
      return typeof entry === 'number' ? entry : undefined;
    },
    drain: () => {
      const live: StatementHandle[] = [];
      for (const entry of entries.values()) {
        if (typeof entry === 'number') live.push(entry);
      }
      entries.clear();
      return live;
    },
  };
};
```

- [ ] **Step 2: Write the tests**

```ts
import { describe, expect, it } from '@rstest/core';
import { createStatementCache } from '../../src/worker/statement-cache';

describe('statement cache', () => {
  it('returns a handle it was given', () => {
    const cache = createStatementCache(4);
    expect(cache.set('SELECT 1', 111)).toEqual([]);
    // Falsifiability: delete `touch(sql, handle)` in `set` and this is undefined.
    expect(cache.get('SELECT 1')).toBe(111);
  });

  it('evicts the least recently used, and hands it back to be finalised', () => {
    const cache = createStatementCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    // 'a' becomes the most recent, so 'b' is next out — not 'a', which
    // insertion order alone would have chosen.
    expect(cache.get('a')).toBe(1);
    // Falsifiability: delete `touch` from `get` and this returns [1].
    expect(cache.set('c', 3)).toEqual([2]);
    expect(cache.get('b')).toBeUndefined();
  });

  it('reports SQL that must not be cached', () => {
    const cache = createStatementCache(4);
    expect(cache.markUncacheable('SELECT 1; SELECT 2')).toEqual([]);
    // Falsifiability: return `entry` instead of 'uncacheable' in `get` and
    // this is null, which the worker would read as a handle.
    expect(cache.get('SELECT 1; SELECT 2')).toBe('uncacheable');
  });

  it('bounds the uncacheable markings with everything else', () => {
    const cache = createStatementCache(2);
    cache.markUncacheable('x');
    cache.markUncacheable('y');
    // Falsifiability: keep the markings in a separate collection and 'x'
    // survives for ever — the second unbounded map the design refuses.
    expect(cache.set('z', 9)).toEqual([]);
    expect(cache.get('x')).toBeUndefined();
  });

  it('returns a handle evicted by a marking', () => {
    const cache = createStatementCache(1);
    cache.set('a', 1);
    // Falsifiability: give `markUncacheable` no return value and handle 1 is
    // leaked — nothing would ever finalise it.
    expect(cache.markUncacheable('b')).toEqual([1]);
  });

  it('drains every live handle and empties', () => {
    const cache = createStatementCache(4);
    cache.set('a', 1);
    cache.markUncacheable('b');
    cache.set('c', 3);
    // Falsifiability: push `null` entries too and close would finalise a
    // marking as if it were a statement.
    expect(cache.drain().sort()).toEqual([1, 3]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.drain()).toEqual([]);
  });

  it('caches nothing at capacity 0', () => {
    const cache = createStatementCache(0);
    // Falsifiability: use `>=` instead of `>` in the evict loop and this
    // throws on an empty map instead of returning the handle.
    expect(cache.set('a', 1)).toEqual([1]);
    expect(cache.get('a')).toBeUndefined();
  });

  it('forgets a deleted entry and returns its handle', () => {
    const cache = createStatementCache(4);
    cache.set('a', 1);
    expect(cache.delete('a')).toBe(1);
    expect(cache.delete('a')).toBeUndefined();
    expect(cache.get('a')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the unit tests**

Run: `pnpm test:unit`
Expected: PASS, and the four fields read — `status: "pass"`, `failedFiles: 0`, 418 tests, 0 failed.

- [ ] **Step 4: Verify each falsifiability comment**

For each of the six comments above: make the named edit, run `pnpm test:unit`, observe the named test red, restore, observe green. Report both observations. A comment whose experiment stays green is deleted along with its claim, not reworded (`mem:lessons`).

- [ ] **Step 5: Format and commit**

```bash
pnpm check
git add src/worker/statement-cache.ts tests/unit/statement-cache.test.ts
git commit -m "feat(worker): a bounded LRU of prepared statements, wired to nothing yet"
```

---

### Task 2: the prepare counter

The instrument, added before the thing it will measure. With no cache yet it reports one compilation per statement executed — which is also how the multi-statement premise of Task 3 gets falsified.

**Files:**
- Modify: `src/types.ts` (the `done` variant of `WorkerMessageData`)
- Modify: `src/worker/worker.ts` (`open`'s closure, `query`, the `query` message case)
- Modify: `src/pool.ts:294-305` (the `done` case)
- Modify: `src/debug.ts:89-97` (`QueryDebugState`), `src/debug.ts:208-220` (`createQueryDebugState`)
- Test: `tests/browser/statement-cache.test.ts` (new file)

**Interfaces:**
- Produces: `{ type: 'done'; callId: number; affected: number; prepared: number }`; `QueryDebugState.prepared: number`.
- Consumes: nothing from Task 1.

- [ ] **Step 1: Write the failing test**

Create `tests/browser/statement-cache.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * `poolSize: 1` throughout this file. At the default size two executions of
 * the same SQL can land on two workers and compile once each — correct, and
 * unreadable as an assertion about caching.
 */
const single = { poolSize: 1, debug: true } as const;

/**
 * Every recorded execution of `sql`, oldest first. Selected by SQL rather
 * than by position: the barrier runs its own statement on the same worker,
 * so `queries.at(-1)` is not reliably the query the test just issued.
 */
const runsOf = (db: Awaited<ReturnType<typeof createTestClient>>, sql: string) =>
  (db.debug?.workers ?? [])
    .flatMap((w) => w.requests)
    .flatMap((r) => r.queries)
    .filter((q) => q.sql === sql);

describe('prepare counter', () => {
  it('reports one compilation for one statement', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    // Falsifiability: stop incrementing `prepared` in worker.ts's query loop
    // and this is 0.
    expect(runsOf(db, 'CREATE TABLE t (a)')[0]?.prepared).toBe(1);
    await db.close();
  });

  it('reports one compilation per statement of a multi-statement string', async () => {
    const db = await createTestClient(single);
    const sql = 'CREATE TABLE t (a); CREATE TABLE u (b)';
    await db.write(sql);
    // The premise Task 3 rests on, measured rather than assumed: wa-sqlite's
    // generator yields one statement per statement of the string.
    // Falsifiability: increment `prepared` once per query instead of once per
    // yielded statement and this is 1.
    expect(runsOf(db, sql)[0]?.prepared).toBe(2);
    await db.close();
  });
});
```

`db.debug` is `ClientDebugState | undefined` — it is only populated when the
`debug` option is set, which `single` does.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:browser -- statement-cache`
Expected: FAIL — `prepared` is `undefined`, the property does not exist yet.

- [ ] **Step 3: Add `prepared` to the wire protocol**

In `src/types.ts`, the `done` variant becomes:

```ts
  | {
      type: 'done';
      callId: number;
      affected: number;
      /**
       * Statements compiled while serving this query — zero on a cache hit.
       * Rides the same message as `affected` rather than opening a channel:
       * the effect this instruments is a count, not a duration (`mem:lessons`,
       * "for a sub-millisecond effect, count the round trips").
       */
      prepared: number;
    }
```

- [ ] **Step 4: Count in the worker**

In `src/worker/worker.ts`, inside `open`'s closure and next to `reply`, add:

```ts
  // One query at a time per worker (a worker holds one lease), so a single
  // counter cannot interleave. Reset by the `query` case, read by its reply.
  let prepared = 0;
```

In `query`, increment once per statement the generator yields:

```ts
    for await (const stmt of sqlite.statements(db, sql)) {
      prepared++;
      if (params?.length) {
```

In the `query` message case, reset it beside `gate.reset(...)`:

```ts
          gate.reset(callId, options?.credits ?? DEFAULT_CREDIT_WINDOW);
          prepared = 0;
```

and carry it on the reply:

```ts
            reply({ type: 'done', callId, affected, prepared });
```

- [ ] **Step 5: File it in the pool and the debug state**

In `src/debug.ts`, `QueryDebugState` gains `prepared: number;` and `createQueryDebugState` initialises it to `0` beside `affectedRows: 0`.

In `src/pool.ts`, the `done` case, beside the existing `affectedRows` assignment:

```ts
            state.currentRequest.currentQuery.affectedRows = affected;
            state.currentRequest.currentQuery.prepared = data.prepared;
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test:browser -- statement-cache`, then `pnpm test`
Expected: both PASS. Read `status` and `failedFiles`, not only the counters.

- [ ] **Step 7: Verify the two falsifiability comments**

Make each named edit, observe the named test red, restore, observe green. Report both.

- [ ] **Step 8: Format and commit**

```bash
pnpm check
git add src/types.ts src/worker/worker.ts src/pool.ts src/debug.ts tests/browser/statement-cache.test.ts
git commit -m "feat(worker): a query reports how many statements it compiled"
```

---

### Task 3: the cache, wired

The whole mechanism, and it cannot be split: reuse without the reset discipline is a data-corruption bug, and reuse without the drain makes `close` return `SQLITE_BUSY` into a `catch` that swallows it.

**Files:**
- Modify: `src/client.ts:53` (the constant), `src/client.ts:313` (the pool worker deps)
- Modify: `src/pool.ts:134` (deps type), `src/pool.ts:146` (destructure), `src/pool.ts:485-493` (the `open` postMessage)
- Modify: `src/types.ts` (the `open` variant of `ClientMessageData`)
- Modify: `src/worker/worker.ts` (`OpenOptions`, `open`, `query`, the `close` case)
- Test: `tests/browser/statement-cache.test.ts`

**Interfaces:**
- Consumes: `createStatementCache`, `StatementHandle` from Task 1; `prepared` from Task 2.
- Produces: `DEFAULT_STATEMENT_CACHE_SIZE = 32` exported from nothing (module constant in `src/client.ts`); `statementCacheSize?: number` on the `open` message and on `PoolWorkerDeps`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/statement-cache.test.ts`:

```ts
describe('statement cache', () => {
  it('compiles repeated SQL once', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    await db.read('SELECT * FROM t');
    await db.read('SELECT * FROM t');
    const runs = runsOf(db, 'SELECT * FROM t');
    expect(runs[0]?.prepared).toBe(1);
    // Falsifiability: return `undefined` unconditionally from `cache.get` and
    // this is 1.
    expect(runs[1]?.prepared).toBe(0);
    await db.close();
  });

  it('caches every shape that is one statement', async () => {
    const db = await createTestClient(single);
    // The cachable rows of spec §4.2, each executed twice.
    for (const sql of [
      'SELECT 1',
      'SELECT 1;',
      'SELECT 1\n  WHERE 1=1',
      'SELECT 1; ',
    ]) {
      await db.read(sql);
      await db.read(sql);
      // Falsifiability: drop the trailing-semicolon stripping from
      // `isSingleStatement` and the second and fourth entries are 1.
      expect(runsOf(db, sql)[1]?.prepared).toBe(0);
    }
    await db.close();
  });

  it('never caches a multi-statement string', async () => {
    const db = await createTestClient(single);
    const sql = 'SELECT 1; SELECT 2';
    await db.read(sql);
    await db.read(sql);
    // The false positive of spec §4.2, and the worst defect available here:
    // if `sqlite3_sql` returned the whole input rather than the statement's
    // own span, this string would be cached and every later execution would
    // run `SELECT 1` alone.
    // Falsifiability: replace the comparison in `isSingleStatement` with
    // `true` and this is 0.
    expect(runsOf(db, sql)[1]?.prepared).toBe(2);
    await db.close();
  });

  it('does not carry a binding from one execution to the next', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    const insert = 'INSERT INTO t (a) VALUES (?)';
    await db.write(insert, [7]);
    // bind_collection skips an `undefined` value, so on a reused statement
    // the previous execution's binding would survive (spec §2.3).
    await db.write(insert, [undefined]);
    const rows = await db.read<{ a: number | null }>(
      'SELECT a FROM t ORDER BY rowid',
    );
    // Falsifiability: delete the `clear_bindings` call in `settle` and the
    // second row is 7.
    expect(rows.map((r) => r.a)).toEqual([7, null]);
    await db.close();
  });

  it('closes cleanly after caching statements', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    await db.read('SELECT * FROM t');
    // SQLite refuses to close a connection holding live statements, and the
    // close path's catch would swallow the SQLITE_BUSY.
    // Falsifiability: delete the drain in worker.ts's close case and this
    // rejects, or the close resolves on a database that never closed.
    await expect(db.close()).resolves.toBeUndefined();
  });

  it('caches a statement abandoned by first()', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1), (2)');
    const sql = 'SELECT a FROM t';
    await db.first(sql);
    await db.first(sql);
    // first() breaks out of the row loop after one row — a normal, hot exit.
    // Falsifiability: assign `keep` after `yield* run(stmt)` instead of before
    // it and this is 1, because the early break skips the assignment
    // (spec §5.1).
    expect(runsOf(db, sql)[1]?.prepared).toBe(0);
    await db.close();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test:browser -- statement-cache`
Expected: the six new tests FAIL. The two from Task 2 still pass.

- [ ] **Step 3: Plumb the capacity from the client to the worker**

`src/client.ts`, beside `DEFAULT_POOL_SIZE`:

```ts
/**
 * Statements retained per worker. Not a consumer option (spec §3.2): the
 * value is declared here rather than in the worker so that exposing it later
 * is one options line, not a move.
 */
const DEFAULT_STATEMENT_CACHE_SIZE = 32;
```

At `src/client.ts:313`, beside `pragmas`:

```ts
          statementCacheSize: DEFAULT_STATEMENT_CACHE_SIZE,
```

`src/pool.ts:134`, in the deps type, beside `pragmas`:

```ts
  statementCacheSize?: number;
```

`src/pool.ts:146`, in the destructure, add `statementCacheSize`. In the `open` postMessage at `src/pool.ts:485-493`, add `statementCacheSize,`.

`src/types.ts`, the `open` variant, beside `pragmas`:

```ts
      /** Statements retained per worker; see `src/client.ts`. Internal. */
      statementCacheSize?: number;
```

`src/worker/worker.ts`, `OpenOptions` gains `statementCacheSize?: number`, and the `open` message case forwards it:

```ts
      const { file, vfs, build, pragmas, statementCacheSize } = data;
      open(file, { vfs, build, pragmas, statementCacheSize });
```

- [ ] **Step 4: Create the cache in `open`**

In `src/worker/worker.ts`, add the import:

```ts
import { SQLITE_PREPARE_PERSISTENT, SQLITE_ROW } from 'wa-sqlite/src/sqlite-constants.js';
import { createStatementCache } from './statement-cache';
```

and inside `open`, next to the `prepared` counter added in Task 2:

```ts
  const cache = createStatementCache(options.statementCacheSize ?? 0);
```

A missing value means no cache rather than a second default: one default, declared in `client.ts`.

- [ ] **Step 5: Add the single-statement test as a module-level function**

In `src/worker/worker.ts`, at module level beside `cloneable`:

```ts
/**
 * Whether `sql` compiled to exactly one statement, decided from the text
 * `sqlite3_sql` returns for the first statement — its own span of the input,
 * not the whole input. Asked before the first `step`, because `first()` and an
 * aborted read both leave the generator early and would never learn a count.
 *
 * Normalisation is edge whitespace and one trailing semicolon, applied
 * identically to both sides, which are two views of the same text: nothing is
 * case-folded, and an interior newline sits in the same place on both sides.
 * A false negative costs a compilation; a false positive would replay only
 * the first statement of a multi-statement string, so the failure direction
 * is the safe one.
 */
const isSingleStatement = (sql: string, statementText: string) => {
  const normalize = (s: string) => s.trim().replace(/;+$/, '').trim();
  return normalize(sql) === normalize(statementText);
};
```

- [ ] **Step 6: Rewrite `query`'s three branches**

Replace the body of `query` in `src/worker/worker.ts` with:

```ts
  query = async function* (
    sql: string,
    params: unknown[],
    options?: SQLOptions,
  ) {
    if (!openedDB) throw new Error('No DB opened');

    const { sqlite, db } = await openedDB;
    const { chunkSize = 1 } = options ?? {};

    const buffer: Record<string, unknown>[] = [];

    /** Binds and streams one statement. Never finalises: the caller owns it. */
    const run = async function* (stmt: number) {
      if (params?.length) {
        sqlite.bind_collection(stmt, params as any);
      }
      const cols = sqlite.column_names(stmt) as string[];

      while (true) {
        if (gate.isStopped()) break;

        const result = await sqlite.step(stmt);
        if (gate.isStopped()) break;

        if (result === SQLITE_ROW) {
          const row = sqlite.row(stmt);
          buffer.push(Object.fromEntries(cols.map((key, i) => [key, row[i]])));

          if (buffer.length >= chunkSize) {
            yield buffer.splice(0, chunkSize);
          }
        } else {
          while (buffer.length) {
            yield buffer.splice(0, chunkSize);
          }
          break;
        }
      }
    };

    /**
     * The exit discipline, on every path out of a retained statement:
     * `reset` ends the statement's implicit transaction, which is what keeps
     * a cached statement from holding a read transaction open and poisoning
     * the barrier; `clear_bindings` is the correctness condition of reuse.
     * A statement that errored is finalised instead — `sqlite3_reset` returns
     * the failed step's code, so resetting it throws.
     */
    const settle = async (stmt: number, failed: boolean) => {
      if (failed) {
        cache.delete(sql);
        await sqlite.finalize(stmt);
        return;
      }
      try {
        await sqlite.reset(stmt);
        sqlite.clear_bindings(stmt);
      } catch {
        cache.delete(sql);
        await sqlite.finalize(stmt);
        return;
      }
      for (const handle of cache.set(sql, stmt)) {
        await sqlite.finalize(handle);
      }
    };

    const cached = cache.get(sql);

    if (typeof cached === 'number') {
      let failed = false;
      try {
        yield* run(cached);
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        await settle(cached, failed);
      }
    } else if (cached === 'uncacheable') {
      // Today's path, untouched: the generator finalises what it yields.
      for await (const stmt of sqlite.statements(db, sql)) {
        prepared++;
        yield* run(stmt);
      }
    } else {
      let keep: number | undefined;
      let live: number | undefined;
      let single: boolean | undefined;
      let failed = false;
      try {
        for await (const stmt of sqlite.statements(db, sql, {
          unscoped: true,
          flags: SQLITE_PREPARE_PERSISTENT,
        })) {
          prepared++;
          single ??= isSingleStatement(sql, sqlite.sql(stmt));
          // Assigned BEFORE the rows are streamed: first() breaks out of the
          // loop, and an assignment after `yield*` would never run.
          if (single) keep = stmt;
          else live = stmt;

          yield* run(stmt);

          if (!single) {
            await sqlite.finalize(stmt);
            live = undefined;
          }
        }
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        if (keep !== undefined) {
          await settle(keep, failed);
        } else if (live !== undefined) {
          // An early exit from a multi-statement string.
          await sqlite.finalize(live);
        }
        if (single === false) {
          for (const handle of cache.markUncacheable(sql)) {
            await sqlite.finalize(handle);
          }
        }
      }
    }

    yield sqlite.changes(db);
  }
```

- [ ] **Step 7: Drain before closing**

In `src/worker/worker.ts`, the `close` message case, between `await idleUntilQueryEnds()` and `sqlite.close(db)`:

```ts
        try {
          const { sqlite, db } = await openedDB!;
          // SQLite refuses to close a connection carrying live statements,
          // and the catch below would swallow the SQLITE_BUSY. idleUntilQueryEnds
          // has already returned, so the in-flight query's statement is reset
          // and filed: nothing here is in use.
          for (const handle of cache.drain()) {
            await sqlite.finalize(handle);
          }
          await sqlite.close(db);
        } catch {
```

- [ ] **Step 8: Run everything**

Run: `pnpm test:browser -- statement-cache`, then `pnpm test`, then `pnpm build` and `npx tsc --noEmit`
Expected: all PASS — 410 baseline plus 8 unit (Task 1) and 8 browser (Tasks 2-3) — `failedFiles: 0`, `status: "pass"`, build and typecheck clean.

- [ ] **Step 9: Verify the six falsifiability comments**

Each named edit, red, restore, green, reported. The multi-statement one in particular: with `isSingleStatement` forced to `true`, confirm the test goes red — that experiment is the whole defence of spec §4.2.

- [ ] **Step 10: Format and commit**

```bash
pnpm check
git add src/client.ts src/pool.ts src/types.ts src/worker/worker.ts tests/browser/statement-cache.test.ts
git commit -m "feat(worker): repeated SQL is compiled once per worker"
```

---

### Task 4: column names read after the first row

A defect in the existing code that the cache widens from the duration of a prepare to the lifetime of a worker. Its test is only falsifiable once Task 3 has landed, which is why it is here and not first.

**Files:**
- Modify: `src/worker/worker.ts` (`run`, inside `query`)
- Test: `tests/browser/statement-cache.test.ts`

**Interfaces:**
- Consumes: everything from Task 3. Produces nothing new.

- [ ] **Step 1: Write the failing test**

```ts
  it('sees a column added after the statement was cached', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1)');
    await db.read('SELECT * FROM t');
    await db.write('ALTER TABLE t ADD COLUMN b');
    const rows = await db.read<Record<string, unknown>>('SELECT * FROM t');
    // The cached statement re-prepares itself during step() when the schema
    // has moved. Column names read before that step describe the old table
    // while row() returns the new one — correct values under wrong keys.
    // Falsifiability: move `column_names` back above the loop and `b` is
    // missing from the returned row.
    expect(Object.keys(rows[0] ?? {})).toEqual(['a', 'b']);
    await db.close();
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:browser -- statement-cache`
Expected: FAIL — the row has only `a`.

- [ ] **Step 3: Move the read**

In `run`, delete the `const cols = …` line above the loop and read lazily on the first row:

```ts
    const run = async function* (stmt: number) {
      if (params?.length) {
        sqlite.bind_collection(stmt, params as any);
      }
      // Read after the first ROW, never before: a cached statement re-prepares
      // itself inside step() when the schema has moved, so names read earlier
      // can describe the pre-ALTER table while row() returns the post-ALTER
      // one. It also stops every INSERT from paying for a column list it has
      // no use for — a write returns DONE and never has columns.
      let cols: string[] | undefined;

      while (true) {
        if (gate.isStopped()) break;

        const result = await sqlite.step(stmt);
        if (gate.isStopped()) break;

        if (result === SQLITE_ROW) {
          cols ??= sqlite.column_names(stmt) as string[];
          const row = sqlite.row(stmt);
          buffer.push(Object.fromEntries(cols.map((key, i) => [key, row[i]])));

          if (buffer.length >= chunkSize) {
            yield buffer.splice(0, chunkSize);
          }
        } else {
          while (buffer.length) {
            yield buffer.splice(0, chunkSize);
          }
          break;
        }
      }
    };
```

- [ ] **Step 4: Run everything**

Run: `pnpm test:browser -- statement-cache`, then `pnpm test`
Expected: PASS, four fields read.

- [ ] **Step 5: Verify the falsifiability comment**

Move `column_names` back above the loop, observe red, restore, observe green. Report both.

- [ ] **Step 6: Format and commit**

```bash
pnpm check
git add src/worker/worker.ts tests/browser/statement-cache.test.ts
git commit -m "fix(worker): column names are read from the statement that produced the row"
```

---

### Task 5: measure, and write the numbers down

The campaign of spec §8. Nothing here ships in the package: the harness lives in the scratchpad so that it runs unchanged against a worktree of `main`.

**Files:**
- Create: `<scratchpad>/prepare-bench.test.ts` — a browser test file copied into `tests/browser/` to run and deleted afterwards, never committed. It must run against `main` too, so it may import nothing this branch adds beyond `db.debug`.
- Modify: `CHANGELOG.md` (unreleased section)

**Interfaces:**
- Consumes: `prepared` from Task 2, the cache from Task 3.

- [ ] **Step 1: Build the harness**

Three workloads, each run against one client:

1. **repeated identical reads** — `SELECT a FROM t WHERE a = ?` over a seeded table, 2 000 executions, timed as a whole.
2. **`bulkWrite`** — 100 000 rows, five columns, timed as a whole.
3. **`tx.bulkWrite`** — the same 100 000 rows inside `db.transaction()`.

Instruments, all read after the workload:

```js
// Statement footprint. SQLITE_STMTSTATUS_MEMUSED is 99 and is not exported
// by wa-sqlite's constants, but _sqlite3_stmt_status is in the wasm build.
const bytes = module._sqlite3_stmt_status(stmt, 99, 0);
const heap = module._sqlite3_memory_used();
```

Report per run: total ms, `prepared` summed over the client's debug queries, statement bytes for the `bulkWrite` template and for the repeated read, each beside the length of its SQL string, and `_sqlite3_memory_used()` before and after the cache is warm.

- [ ] **Step 2: Take the "before"**

```bash
git worktree add /tmp/bsq-main main
```

Install and run the same harness there. On `main` the `prepared` counter does not exist: record the prepare count as **structural** — one compilation per execution by construction of the generator — and say so in those words rather than as a reading (spec §8.3). The footprint numbers have no "before" at all: `main` finalises its statements, there is nothing to weigh.

- [ ] **Step 3: Take the "after" on four cells**

Two engines × two builds, per spec §8.1:

```bash
TEST_BROWSER=chromium  # and firefox
```

with one VFS from the `sync` column and `OPFSAdaptiveVFS`, which leads with `async`. `jspi` is not measured — Chromium only, so no cross-engine comparison exists — and is recorded as not measured rather than left to look covered.

Three runs per cell. `mem:lessons`: one run per device reads like reproduction and is not, and Firefox clamps `performance.now()` to 1 ms by default, so a difference near that floor is noise, not a gain.

- [ ] **Step 4: Write the numbers down**

Into `mem:measurements`, with date and method, as a gain per cell (workload × VFS/build × engine) with the milliseconds saved per execution beside it — the percentage does not transfer between cells, the saving does (spec §8.3). Into `CHANGELOG.md`, unreleased section, one entry. Nothing into the README (spec §3.2).

State the `bulkWrite` result as a signal-to-noise ratio if it is small: each batch is its own transaction, so commit cost can drown the compilation saving, and the gap between workloads 2 and 3 prices those commits.

- [ ] **Step 5: Clean up and commit**

```bash
git worktree remove /tmp/bsq-main
pnpm check
git add CHANGELOG.md
git commit -m "docs(changelog): repeated SQL is compiled once per worker"
```

The scratchpad harness is not committed.

---

## Closure

Not a task — the procedure of `mem:conventions`, run by the session that finishes this branch:

1. Merge `feat/statement-cache` into `main` with `--no-ff` and a body explaining the change, once CI is green, memories are updated and the tree is clean.
2. Write the memories: the measurements into `mem:measurements`; delete the "No prepared-statement cache" bullet and the whole "The prepared-statement cache — discussed 2026-08-27, not built" section from `mem:follow-ups`; add to `mem:architecture` the new file and the line count changes; anything in `mem:lessons` that this branch paid for.
3. Commit what is outstanding, asking about anything not obvious.
4. Delete the branch locally and on the remote, after proving containment with `git merge-base --is-ancestor feat/statement-cache main`.
