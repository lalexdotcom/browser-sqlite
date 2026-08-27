# Bulk back-pressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a producer feeding `bulkWrite()` or `output()` await `enqueue()` and be slowed to the speed of the database, instead of growing memory with batches in flight.

**Architecture:** `enqueue()` returns a promise. Under the cap it is a shared, already-resolved constant, so the hot path allocates nothing; at or above the cap it is a single deferred shared by every caller, resolved as soon as a batch settles and the queue drops back below. A counter tracks rows handed to a batch that has not settled; the abort releases a waiter so a producer parked on a pool that never frees a worker can still be abandoned.

**Tech Stack:** TypeScript, rstest (`pnpm test:unit`), biome (`pnpm check`). No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-bulk-backpressure-design.md` — read it first; it carries the four decisions and why each alternative was rejected.

## Global Constraints

- **No new browser API below the floor.** `LIB_FLOOR` is Chrome 92 / Firefox 95 / Safari 15.4 (`scripts/render-vfs-matrix.ts`). Nothing in this plan needs an API above it.
- **The internal write chain must never reject** (B5). A rejection skips the later `.then()` links and drops already-spliced rows in silence.
- **The returned promise must never reject** (spec decision 4). Ignoring it is documented as legal, and a rejected promise nobody awaits is an `unhandledrejection`.
- **English in code, comments, commits and docs.** French only in chat.
- **Serena's symbolic tools are primary for code edits.** Built-in Read/Edit are for `.md` and config only.
- **Every test names the line whose deletion makes it fail**, in a comment (`mem:lessons`). Claiming falsifiability is not enough — delete the line, observe red, restore.
- **Run `pnpm check` after every modification**, and read four fields from the test report — `status`, `failedFiles`, `failedTests`, `passedTests`.
- **Baseline to beat:** 397 tests, 0 failed files, `tsc --noEmit` clean, biome 13 warnings with none in touched files.

**State of the working tree at plan time:** the tests of Tasks 1–4 are already written in `tests/unit/bulk.test.ts`, and `src/api.ts` already carries the Task 1 type changes. Nothing in `src/bulk.ts` has been touched. An executor starting from that tree runs the RED verification first and skips the writing step where the test is already there.

## File Structure

- `src/api.ts` — the public types. `queueSize` on both option bags, `enqueue` returning `Promise<void>` on both writer types.
- `src/bulk.ts` — the whole mechanism. `createBulk` is already the single home of `bulkWrite` and `output`; nothing new is created.
- `tests/unit/bulk.test.ts` — every test. None of this needs a browser.
- `README.md`, `CHANGELOG.md` — the consumer-facing half.

---

### Task 1: `enqueue()` returns a promise

The surface change, with no back-pressure behind it yet. A caller may await; nothing ever defers.

**Files:**
- Modify: `src/api.ts` (`SQLiteBulkWriteOptions`, `SQLiteOutputOptions`, `SQLiteBulkWriter`, `SQLiteOutputWriter`)
- Modify: `src/bulk.ts` (module constant, `bulkWrite`'s `enqueue`, `output`'s options pass-through)
- Test: `tests/unit/bulk.test.ts`

**Interfaces:**
- Produces: `type EnqueueRow<ROW> = (data: ROW) => Promise<void>`; `SQLiteBulkWriteOptions = OptionsWithSignal<{ queueSize?: number }>`; `SQLiteOutputOptions<SCHEMA>` gains `queueSize?: number`; module constant `ADMITTED: Promise<void>` in `src/bulk.ts`.

- [ ] **Step 1: Write the failing test**

In `tests/unit/bulk.test.ts`, after the existing describes. The `gatedRecorder`, `watch` and `ticks` helpers are defined once here and used by every later task.

```typescript
/**
 * A recorder whose writes settle only when the test says so — the only way to
 * observe a queue that is full, since a write that resolves immediately empties
 * it before the next enqueue can see it.
 */
const gatedRecorder = () => {
  const sql: string[] = [];
  const gates: (() => void)[] = [];
  const write = (statement: string) => {
    sql.push(statement);
    return new Promise<{ result: any[]; affected: number }>((resolve) => {
      gates.push(() => resolve({ result: [], affected: 1 }));
    });
  };
  const read = async () => [] as any[];
  const transaction = async <T>(cb: (db: any) => Promise<T>) =>
    cb({
      write: async () => ({ result: [], affected: 0 }),
      read: async () => [],
    });

  return {
    sql,
    /** Settles the oldest write still in flight. */
    settleOne: () => gates.shift()?.(),
    deps: { read, write, transaction } as any,
  };
};

/** Tracks whether a promise has settled, without awaiting it. */
const watch = (promise: Promise<unknown>) => {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
};

/** Lets every queued microtask run. */
const ticks = async (n = 3) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe('bulkWrite back-pressure', () => {
  // maxVariables 2 with one key → 2 rows per batch, so the derived default
  // queueSize is 4 rows.
  const bulkFactory = (maxVariables: number, deps: any) =>
    createBulk({
      file: 'app.db',
      locks: noOpLocks,
      logger: noopLogger,
      maxVariables,
    })(deps);

  it('resolves without deferring while the queue is under the cap', async () => {
    const { deps } = gatedRecorder();
    const { bulkWrite } = bulkFactory(2, deps);
    const bulk = bulkWrite('t', ['a']);

    const first = watch(bulk.enqueue({ a: 1 }));
    const second = watch(bulk.enqueue({ a: 2 })); // flushes 2 rows, cap is 4
    await ticks();

    expect(first()).toBe(true);
    expect(second()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- bulk`
Expected: FAIL with `Cannot read properties of undefined (reading 'then')` — `enqueue()` returns nothing, so `watch()` cannot subscribe.

- [ ] **Step 3: Write minimal implementation**

In `src/api.ts`, replace the two writer types:

```typescript
/**
 * Buffers a row, flushing automatically when the buffer fills.
 *
 * Awaiting the returned promise applies back-pressure: it is already resolved
 * while fewer than `queueSize` rows are queued for writing, and resolves once
 * a batch settles when they are not. Ignoring it is legal, and leaves the load
 * unbounded exactly as it was before the option existed — the bound is an
 * offer, not a guarantee.
 *
 * It never rejects. A failed batch surfaces at the next `enqueue()`, which
 * throws, and at `close()`, which rejects.
 */
type EnqueueRow<ROW> = (data: ROW) => Promise<void>;

export type SQLiteBulkWriter<KEYS extends string> = {
  enqueue: EnqueueRow<Record<KEYS, any>>;
  /** Flushes what remains and resolves with the total affected row count. */
  close: () => Promise<number>;
};

export type SQLiteOutputWriter<SCHEMA extends Schema> = {
  enqueue: EnqueueRow<SQLiteOutputRow<SCHEMA>>;
  close: () => Promise<number>;
};
```

and the two option bags:

```typescript
/**
 * Options `bulkWrite()` accepts.
 *
 * `queueSize` bounds how far the producer may run ahead of the database. Rows
 * are handed over in batches of at most 32 766 bound values; a batch that has
 * been handed over but not yet written is held in memory until it is, and
 * nothing caps how many of those accumulate unless you await `enqueue()`.
 *
 * The default is two batches' worth, derived from the column count — about
 * 13 100 rows for 5 columns, 2 180 for 30 — so the memory bounded is roughly
 * the same from one table to the next. A value smaller than one batch is legal
 * and means one INSERT in flight, the least the batching allows.
 */
export type SQLiteBulkWriteOptions = OptionsWithSignal<{
  /** Rows queued for writing above which `enqueue()` defers. */
  queueSize?: number;
}>;

export type SQLiteOutputOptions<SCHEMA extends Schema> = OptionsWithSignal<{
  indexes?: Index<SCHEMA>[];
  /** Rows queued for writing above which `enqueue()` defers. See `SQLiteBulkWriteOptions`. */
  queueSize?: number;
}>;
```

In `src/bulk.ts`, add the module constant beside `DROP_STAGING_TIMEOUT`:

```typescript
/**
 * Returned by every `enqueue()` that does not have to wait. Shared rather than
 * created per call: the hot path allocates nothing.
 */
const ADMITTED = Promise.resolve();
```

Change `bulkWrite`'s options type from `OptionsWithSignal` to `SQLiteBulkWriteOptions` (add it to the `import type` block from `./api`), and return the constant from `enqueue`:

```typescript
        enqueue: (data: { [K in KEYS]: any }) => {
          if (closed) throw failClosed();
          signal?.throwIfAborted();
          if (failure) throw fail();
          buffer.push(data);
          if (buffer.length >= maxBufferSize) flush();
          return ADMITTED;
        },
```

In `output()`, pass the option through to the inner writer:

```typescript
        { signal: options?.signal, queueSize: options?.queueSize },
```

`output()`'s own `enqueue` is `(data) => enqueue(data as any)` — an expression body, so it already returns the promise. Do not touch it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- bulk` — expected PASS.
Run: `npx tsc --noEmit` — expected clean.
Run: `pnpm check` — expected 13 warnings, none in `src/bulk.ts` or `src/api.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts src/bulk.ts tests/unit/bulk.test.ts
git commit -m "feat(bulk): enqueue() returns a promise"
```

---

### Task 2: the queue, the cap and the deferral

**Files:**
- Modify: `src/bulk.ts` (`bulkWrite`: `queueSize`, `queuedRows`, `room`, `flush`, `enqueue`)
- Test: `tests/unit/bulk.test.ts`

**Interfaces:**
- Consumes: `ADMITTED` from Task 1.
- Produces: module helper `makeRoom(): { promise: Promise<void>; resolve: () => void }`; the closure-local `releaseRoom()` that Task 4 subscribes to the signal.

- [ ] **Step 1: Write the failing test**

Add inside the `describe('bulkWrite back-pressure')` block:

```typescript
  // Falsifiable: return ADMITTED unconditionally and this goes red — the
  // fourth enqueue would settle with nothing written.
  it('defers once the queue is full, and resolves when a batch settles', async () => {
    const { deps, settleOne } = gatedRecorder();
    const { bulkWrite } = bulkFactory(2, deps);
    const bulk = bulkWrite('t', ['a']);

    bulk.enqueue({ a: 1 });
    bulk.enqueue({ a: 2 }); // queued: 2
    bulk.enqueue({ a: 3 });
    const fourth = watch(bulk.enqueue({ a: 4 })); // queued: 4, at the cap
    await ticks();
    expect(fourth()).toBe(false);

    settleOne(); // queued falls back to 2
    await ticks();
    expect(fourth()).toBe(true);
  });

  // Falsifiable: hard-code the default and this goes red — both writers would
  // defer at the same row count regardless of their width.
  it('derives the default cap from the column count', async () => {
    const narrow = gatedRecorder();
    const wide = gatedRecorder();
    // maxVariables 4: one column → 4 rows per batch, cap 8;
    // two columns → 2 rows per batch, cap 4.
    const one = bulkFactory(4, narrow.deps).bulkWrite('t', ['a']);
    const two = bulkFactory(4, wide.deps).bulkWrite('t', ['a', 'b']);

    let lastNarrow!: () => boolean;
    let lastWide!: () => boolean;
    for (let i = 0; i < 4; i++) {
      lastNarrow = watch(one.enqueue({ a: i }));
      lastWide = watch(two.enqueue({ a: i, b: i }));
    }
    await ticks();

    // Four rows: the wide writer has flushed two batches and reached its cap;
    // the narrow one has flushed one batch and is at half of its own.
    expect(lastWide()).toBe(false);
    expect(lastNarrow()).toBe(true);
  });

  it('honours an explicit cap smaller than a single batch', async () => {
    const { deps } = gatedRecorder();
    const { bulkWrite } = bulkFactory(2, deps);
    const bulk = bulkWrite('t', ['a'], { queueSize: 1 });

    const first = watch(bulk.enqueue({ a: 1 })); // buffered, nothing queued
    const second = watch(bulk.enqueue({ a: 2 })); // flushes 2 rows ≥ 1
    await ticks();

    expect(first()).toBe(true);
    expect(second()).toBe(false);
  });

  it('applies the cap to output() as well', async () => {
    const { deps } = gatedRecorder();
    const { output } = bulkFactory(2, deps);
    const out = output('products', { a: 'INTEGER' }, { queueSize: 1 });

    const first = watch(out.enqueue({ a: 1 }));
    const second = watch(out.enqueue({ a: 2 }));
    await ticks();

    expect(first()).toBe(true);
    expect(second()).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- bulk`
Expected: four failures, each `expected true to be false` on the promise that should have deferred. Nothing defers yet.

- [ ] **Step 3: Write minimal implementation**

Module helper in `src/bulk.ts`, beside `ADMITTED`:

```typescript
/** A promise and the handle that resolves it. */
const makeRoom = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
```

In `bulkWrite`, beside `maxBufferSize`:

```typescript
      // Two batches' worth by default. A batch is at most `maxVariables` bound
      // values whatever the table, so this bounds about the same memory whether
      // the caller loads 2 columns or 30 — which was the whole merit of
      // counting in batches, without imposing the word on the consumer.
      const queueSize = options?.queueSize ?? 2 * maxBufferSize;
```

Beside the other mutable state:

```typescript
      /** Rows handed to a batch that has not settled yet. */
      let queuedRows = 0;
      /** Shared by every enqueue() parked while the queue is full. */
      let room: { promise: Promise<void>; resolve: () => void } | undefined;

      const releaseRoom = () => {
        room?.resolve();
        room = undefined;
      };
```

In `flush()`, count the batch in and wrap the existing chain body in `try`/`finally` — the body itself does not change:

```typescript
      const flush = () => {
        const toInsert = [...buffer];
        buffer.length = 0;
        queuedRows += toInsert.length;
        writePromise = writePromise.then(async (currentAffected) => {
          try {
            // ...existing body, unchanged, every return kept as it is...
          } finally {
            // Every exit passes here — success, latched failure, and the batch
            // an abort skipped. One missed decrement and enqueue() never
            // resolves again.
            queuedRows -= toInsert.length;
            if (queuedRows < queueSize) releaseRoom();
          }
        });
      };
```

In `enqueue`, replace the unconditional `return ADMITTED`:

```typescript
          if (queuedRows < queueSize) return ADMITTED;
          // One deferred for every caller while the queue is full: enqueue() is
          // not concurrent-safe today and this does not make it so.
          room ??= makeRoom();
          return room.promise;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- bulk` — expected PASS, and the Task 1 test still green.
Run: `npx tsc --noEmit` and `pnpm check` — expected clean.

- [ ] **Step 5: Verify falsifiability, then commit**

Delete `if (queuedRows < queueSize) return ADMITTED;`'s guard by returning `ADMITTED` unconditionally, run `pnpm test:unit -- bulk`, observe the four failures, restore, observe green. Then:

```bash
git add src/bulk.ts tests/unit/bulk.test.ts
git commit -m "feat(bulk): the producer may be slowed to the database's speed"
```

---

### Task 3: a failed batch resolves, it does not reject

The invariant most likely to be broken by a later well-meaning edit, so it gets its own test and its own commit.

**Files:**
- Test: `tests/unit/bulk.test.ts`
- Modify: `src/bulk.ts` only if the test fails.

**Interfaces:**
- Consumes: the `failingRecorder(failAt)` helper already defined in this test file.

- [ ] **Step 1: Write the failing test**

```typescript
  // Falsifiable: reject the returned promise on failure and this goes red.
  // A promise the caller is allowed to ignore must never reject — that is one
  // unhandledrejection per failed load.
  it('resolves rather than rejecting when a batch fails', async () => {
    const { deps } = failingRecorder(0);
    const { bulkWrite } = bulkFactory(2, deps);
    const bulk = bulkWrite('t', ['a'], { queueSize: 1 });

    bulk.enqueue({ a: 1 });
    await expect(bulk.enqueue({ a: 2 })).resolves.toBeUndefined();

    // The failure still surfaces where it always did.
    expect(() => bulk.enqueue({ a: 3 })).toThrow(SQLiteBulkWriteError);
    await expect(bulk.close()).rejects.toBeInstanceOf(SQLiteBulkWriteError);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- bulk`
Expected: FAIL before Task 2 exists. **After Task 2 it may already pass** — the `finally` decrements on the failure path too, and the chain never rejects. That is the correct outcome, not a reason to weaken the test: it pins an invariant the code satisfies by construction. Record in the commit message that it passed on arrival.

- [ ] **Step 3: Write minimal implementation**

None expected. If the test fails, the cause is a decrement missing from a failure path in `flush()`'s `finally` — fix it there, not in the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- bulk` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/bulk.test.ts
git commit -m "test(bulk): a failed batch resolves the promise it never rejects"
```

---

### Task 4: the abort releases a waiter

**Files:**
- Modify: `src/bulk.ts` (`bulkWrite`: the signal listener, `close`)
- Test: `tests/unit/bulk.test.ts`

**Interfaces:**
- Consumes: `releaseRoom()` from Task 2.

- [ ] **Step 1: Write the failing test**

```typescript
  // Falsifiable: drop the abort listener that releases the waiter and this
  // hangs — a producer parked on a pool that never frees a worker could not be
  // abandoned, which is the hole ABORT-1 paid for three times.
  it('releases a waiting enqueue() when the signal fires', async () => {
    const { deps } = gatedRecorder();
    const { bulkWrite } = bulkFactory(2, deps);
    const controller = new AbortController();
    const reason = new Error('load abandoned');
    const bulk = bulkWrite('t', ['a'], {
      queueSize: 1,
      signal: controller.signal,
    });

    bulk.enqueue({ a: 1 });
    const waiting = watch(bulk.enqueue({ a: 2 })); // flushes, never settles
    await ticks();
    expect(waiting()).toBe(false);

    controller.abort(reason);
    await ticks();
    expect(waiting()).toBe(true);

    expect(() => bulk.enqueue({ a: 3 })).toThrow(reason);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- bulk`
Expected: FAIL at `expect(waiting()).toBe(true)` — the batch is gated and never settles, so nothing releases the waiter.

- [ ] **Step 3: Write minimal implementation**

In `bulkWrite`, right after `releaseRoom` is defined:

```typescript
      // The abort must release a producer parked on enqueue(): the batch it
      // waits for may never settle — the pool can stay empty on a VFS that
      // rotates one exclusive handle — and the release is what lets its next
      // enqueue() throw signal.reason. Removed by close(), so a signal the
      // caller keeps does not collect one listener per writer.
      signal?.addEventListener('abort', releaseRoom, { once: true });
```

and in `close()`, wrap the body so the listener goes on every exit:

```typescript
        close: async () => {
          if (closed) throw failClosed();
          try {
            if (buffer.length) flush();
            const affected = await writePromise;
            // Ordered ahead of the failure check for the same reason: a batch
            // skipped by the abort is not a batch that failed.
            signal?.throwIfAborted();
            if (failure) throw fail();
            closed = true;
            return affected;
          } finally {
            signal?.removeEventListener('abort', releaseRoom);
          }
        },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit` — expected PASS, whole unit project.
Run: `npx tsc --noEmit` and `pnpm check` — expected clean.

- [ ] **Step 5: Verify falsifiability, then commit**

Comment out the `addEventListener` line, run the test, observe it fail at the release assertion, restore, observe green. Then:

```bash
git add src/bulk.ts tests/unit/bulk.test.ts
git commit -m "fix(bulk): an abort releases a producer parked on enqueue()"
```

---

### Task 5: the consumer-facing half

**Files:**
- Modify: `README.md` (the `bulkWrite` and `output` option tables and the prose above them)
- Modify: `CHANGELOG.md` (`### Added`, in the unreleased section)

**Interfaces:**
- Consumes: the final name and default from Task 1's types. Copy them exactly — `queueSize`, default `2 × floor(32766 / columns)`.

- [ ] **Step 1: Write the README paragraph and table rows**

In the `### *client*.bulkWrite` section, after the paragraph about `{ signal }`:

```markdown
Await `enqueue()` to be slowed to the speed of the database. It resolves immediately while fewer than `queueSize` rows are queued for writing, and only defers beyond that — so a producer that awaits every row never holds more than that many unwritten rows in memory. Ignoring the returned promise is legal and loads exactly as before: the bound is an offer, not a guarantee.
```

and in both option tables — `bulkWrite`'s and `output`'s:

```markdown
| `queueSize` | `number` | 2 batches | Rows queued for writing above which `enqueue()` defers. A batch is `floor(32766 / columns)` rows. |
```

- [ ] **Step 2: Write the CHANGELOG entry**

Under `### Added`, after the `bulkWrite()` / `output()` signal entry:

```markdown
- **`enqueue()` returns a promise, and `{ queueSize }` bounds the load.** A
  producer that awaits it is slowed to the speed of the database; one that
  ignores it loads exactly as before. Only the buffer was ever bounded — the
  chain of batches handed over and not yet written was not, so a JavaScript
  loop against OPFS writes grew memory with batches in flight. The default is
  two batches' worth, derived from the column count, so the memory bounded is
  about the same from one table to the next. The promise never rejects: a
  failed batch still surfaces at the next `enqueue()`, which throws, and at
  `close()`, which rejects.
```

- [ ] **Step 3: Verify the docs match the code**

Run: `grep -n "queueSize" README.md CHANGELOG.md src/api.ts` and confirm the default described matches `2 * maxBufferSize` in `src/bulk.ts`. A README that states a default the code does not have is the drift `mem:lessons` names twice.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test` — expected `status: pass`, `failedFiles: 0`, at least 404 tests.
Run: `pnpm build` — expected clean.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(bulk): queueSize, and what awaiting enqueue() buys"
```

---

## Self-review

**Spec coverage.** §3 decision 1 → Task 1. Decision 2 and 3 → Task 2 (`queueSize` in rows, default derived, explicit value used as given — no clamping code exists anywhere in the plan). Decision 4 → Task 3. §5 mechanism → Task 2, including the shared `ADMITTED` and the single deferred. §5 "the abort must release the waiter" → Task 4. §6 verification, seven tests → Tasks 1 (1), 2 (2, 3, 4, 7), 3 (5), 4 (6). §2 non-goals need no task: no `drain()`, no timed flush, no `maxBufferBytes` appears here. §7 is deliberately out of scope.

**Placeholders.** None: every step carries the code it asks for.

**Type consistency.** `queueSize` is the option in `src/api.ts`, in `bulk.ts`, in both tests and in both docs. `queuedRows` is the counter, `room` the deferred, `releaseRoom()` the release, `makeRoom()` the factory, `ADMITTED` the shared resolved promise — each named once and used under that name in every later task.
