# RYOW-1 Commit-Propagation Barrier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read dispatched to any worker of a client observes every commit that has already resolved in the same browser tab, whatever the pool size.

**Architecture:** A per-database commit counter ("epoch") lives in the realm-wide symbol registry, so every client in the tab shares it. Each worker records the epoch it has absorbed. Before a leased worker serves anything, if it is behind, one discarded statement — `SELECT count(*) FROM sqlite_master` — opens a real read transaction on the file, which is the only thing measured to refresh a connection's cached page 1. The counter is incremented after a write commits and before the write's promise resolves.

**Tech Stack:** TypeScript, wa-sqlite over Web Workers, rstest (`unit` project = Node, `browser` project = Chromium), Biome.

**Spec:** `docs/superpowers/specs/2026-08-21-ryow-barrier-design.md` — read it before Task 1. Every task below argues from it.

## Global Constraints

- **Error direction.** Every ambiguity resolves toward one prelude too many. An extra prelude costs one worker round-trip; a missing one serves wrong data. Never trade the second for the first.
- **The barrier statement is one named constant**, `BARRIER_SQL`, defined once in `src/epochs.ts`. No call site inlines the SQL.
- **`__unsafeTestWriterPolicy` never appears** in the README, in any JSDoc, or in any type reachable from `src/index.ts` (which re-exports only `./client` and `./errors`).
- **Production behaviour of the scheduler must be unchanged** when no writer policy is supplied: the default predicate accepts every index.
- **Biome after every change:** `pnpm check` (it writes fixes). A pre-commit hook runs the full suite on every commit; expect ~10 s.
- **Language:** all code, comments, commit messages and docs in English.
- Every browser test that pins a race carries a `// Falsifiable: <the exact line to delete>` comment, matching the convention in `tests/browser/routing.test.ts`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/utils.ts` | gains `normalizeDatabaseFile` — the single definition of database identity | 1 |
| `src/epochs.ts` **(new)** | the realm-wide epoch registry, the `seen` advance rule, `BARRIER_SQL`. Pure, Node-testable, knows nothing about workers | 2 |
| `src/scheduler.ts` | gains the writer-designation predicate and `InternalSQLiteClientOptions`; the duplicated writer-first branch is factored out | 3 |
| `src/pool.ts` | `PoolWorker` gains `seen` and `epochTarget`; SQLite result codes are mapped to `SQLiteError` | 4, 7 |
| `src/client.ts` | normalizes the file name, owns the epoch instance, applies the barrier at the single acquisition site, bumps after `write()` | 1, 3, 4, 8 |
| `src/transaction.ts` | bumps after a read-write transaction; evicts a worker whose fallback `ROLLBACK` failed | 4, 8 |
| `src/errors.ts` | the `BUSY` code and the numeric `sqliteCode` | 7 |
| `src/worker/worker.ts` | carries wa-sqlite's numeric code across `postMessage` | 7 |
| `src/types.ts` | `WorkerMessageData` gains `sqliteCode` | 7 |
| `tests/unit/{utils,epochs,scheduler,errors,transaction}.test.ts` | pure logic | 1, 2, 3, 7, 8 |
| `tests/browser/barrier.test.ts` **(new)** | the three browser properties | 5, 6 |
| `tests/browser/output.test.ts` | the two pinned tests return to the default pool size | 9 |
| `README.md` + JSDoc | the guarantee, its limits, its cost | 11 |

---

### Task 1: Normalize the database file name at the client entry

The epoch registry is keyed by database. Two clients must not disagree about what "the same database" means. Four of the five shipped VFS already resolve the name through `new URL(name, 'file://')`; doing it once at the entry makes workers, VFS, lock names, the registry and `db.file` agree.

**Files:**
- Modify: `src/utils.ts` (append)
- Modify: `src/client.ts:366-380` (the `createSQLiteClient` entry)
- Test: `tests/unit/utils.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeDatabaseFile(file: string): string`, exported from `src/utils.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/utils.test.ts`:

```ts
describe('normalizeDatabaseFile', () => {
  // Falsifiable: return `file` unchanged from normalizeDatabaseFile and the
  // first three cases go red — which is exactly the epoch registry splitting
  // one database into several keys.
  it('collapses spellings that address the same OPFS file', () => {
    expect(normalizeDatabaseFile('data/file')).toBe('/data/file');
    expect(normalizeDatabaseFile('./data/file')).toBe('/data/file');
    expect(normalizeDatabaseFile('/data/file')).toBe('/data/file');
    expect(normalizeDatabaseFile('data\\file')).toBe('/data/file');
    expect(normalizeDatabaseFile('data/../file')).toBe('/file');
  });

  it('percent-encodes exactly as the VFS do', () => {
    expect(normalizeDatabaseFile('café')).toBe('/caf%C3%A9');
    expect(normalizeDatabaseFile('caf%C3%A9')).toBe('/caf%C3%A9');
  });

  it('keeps genuinely distinct names distinct', () => {
    expect(normalizeDatabaseFile('data//file')).toBe('/data//file');
    expect(normalizeDatabaseFile('SQLite')).not.toBe(
      normalizeDatabaseFile('sqlite'),
    );
  });

  it('is idempotent, so re-normalizing in the VFS changes nothing', () => {
    const once = normalizeDatabaseFile('./data/file');
    expect(normalizeDatabaseFile(once)).toBe(once);
  });
});
```

Add `normalizeDatabaseFile` to the existing import from `../../src/utils` at the top of the file.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm test:unit`
Expected: FAIL — `normalizeDatabaseFile is not a function`.

- [ ] **Step 3: Implement**

Append to `src/utils.ts`:

```ts
/**
 * The single definition of database identity.
 *
 * OPFS itself never sees this string: `getFileHandle` takes a *name*, not a
 * path, so each VFS resolves the path itself. Four of the five shipped VFS do
 * it with `new URL(zName, 'file://')` and `AccessHandlePoolVFS` with the same
 * parse against `'file://localhost/'` — identical `pathname`. Normalizing here
 * makes one string reach the workers, the VFS, the epoch registry and every
 * lock name, so two clients cannot disagree about what "the same database" is.
 *
 * Idempotent: the VFS re-parse of an already-normalized name is a no-op.
 */
export const normalizeDatabaseFile = (file: string): string =>
  new URL(file, 'file://').pathname;
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm test:unit`
Expected: PASS.

- [ ] **Step 5: Wire it into the client entry**

In `src/client.ts`, add `normalizeDatabaseFile` to the existing import from `./utils`, and normalize the positional parameter as the first statement of the function body — before `vfs`, `build`, `poolSize` are read, so nothing downstream can capture the raw string:

```ts
export const createSQLiteClient = (
  file: string,
  clientOptions?: CreateSQLiteClientOptions,
): SQLiteDB => {
  // One definition of database identity for the workers, the VFS, the epoch
  // registry, every lock name and the returned `db.file`.
  file = normalizeDatabaseFile(file);

  const vfs = clientOptions?.vfs ?? DEFAULT_VFS;
  // ... unchanged
```

If Biome objects to assigning a parameter, introduce `const dbFile = normalizeDatabaseFile(file);` and replace the remaining uses of `file` in the function body with `dbFile`.

- [ ] **Step 6: Run everything**

Run: `pnpm check && pnpm test`
Expected: 275 tests pass, plus the four new unit cases.

- [ ] **Step 7: Commit**

```bash
git add src/utils.ts src/client.ts tests/unit/utils.test.ts
git commit -m "feat(client): one normalized database name for workers, VFS, locks and epochs"
```

---

### Task 2: The epoch registry and the `seen` advance rule

Pure module, wired to nothing yet. Everything here is Node-testable, including the property that survives a duplicated module copy.

**Files:**
- Create: `src/epochs.ts`
- Test: `tests/unit/epochs.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BARRIER_SQL: string`
  - `type Epochs = { current: () => number; bump: () => number }`
  - `epochsFor(file: string): Epochs` — same `file` returns handles onto the same counter
  - `advanceSeen(seen: number, target: number, next: number): number`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/epochs.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { advanceSeen, epochsFor } from '../../src/epochs';

describe('epochsFor', () => {
  it('starts at zero and only goes up', () => {
    const e = epochsFor('/counts-up');
    expect(e.current()).toBe(0);
    expect(e.bump()).toBe(1);
    expect(e.bump()).toBe(2);
    expect(e.current()).toBe(2);
  });

  it('shares one counter between handles on the same database', () => {
    const a = epochsFor('/shared');
    const b = epochsFor('/shared');
    a.bump();
    expect(b.current()).toBe(1);
  });

  it('keeps distinct databases apart', () => {
    const a = epochsFor('/apart-a');
    const b = epochsFor('/apart-b');
    a.bump();
    expect(b.current()).toBe(0);
  });

  // Falsifiable: replace the globalThis symbol lookup with a module-level
  // `const registry = new Map()` and this goes red. That is the whole point of
  // the symbol: a bundler that loads two copies of this module (Vite
  // pre-bundling, two versions in a pnpm workspace, a dual ESM/CJS
  // resolution) must still find one counter, or two clients in one tab stop
  // seeing each other with no visible symptom.
  it('adopts a registry another module copy already installed', async () => {
    const key = Symbol.for('browser-sqlite.epochs.v1');
    const host = globalThis as unknown as Record<symbol, unknown>;
    host[key] = new Map([['/preseeded', { value: 41 }]]);

    const fresh = await import(`../../src/epochs?copy=${Date.now()}`);
    expect(fresh.epochsFor('/preseeded').current()).toBe(41);
  });
});

describe('advanceSeen', () => {
  // Falsifiable: return `next` unconditionally and the second case goes red.
  // That case is the only place in the design where an error yields stale data
  // instead of a wasted prelude.
  it('advances when our commit is the next epoch', () => {
    expect(advanceSeen(5, 5, 6)).toBe(6);
  });

  it('does not advance when another client committed during our lease', () => {
    expect(advanceSeen(5, 5, 7)).toBe(5);
  });

  it('does not advance a worker that never caught up', () => {
    expect(advanceSeen(-1, 3, 4)).toBe(-1);
  });
});
```

If the query-string dynamic import is not resolvable under rstest's Node project, replace that one case with: seed `host[key]`, then `delete require.cache`-free re-import via `await import('../../src/epochs')` executed **first** in the file (module state is created lazily on first `epochsFor` call, so seeding before any other test also proves adoption). Keep the falsifiability comment either way.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm test:unit`
Expected: FAIL — cannot resolve `../../src/epochs`.

- [ ] **Step 3: Implement**

Create `src/epochs.ts`:

```ts
/**
 * The commit epoch: a monotonic integer per database, counting commits
 * performed in this realm. Its absolute value means nothing — only the
 * comparison with a worker's `seen` does.
 *
 * The registry lives in the realm-wide symbol registry rather than in a module
 * variable on purpose. A module singleton is unique only when the bundler
 * loads one copy of the module; `Symbol.for` is unique per realm whatever the
 * bundler did. That is what makes "two clients in one tab see each other" true
 * by construction.
 *
 * The `v1` suffix separates incompatible shapes. Bump it ONLY if the shape
 * changes — bumping it per release recreates the fragmentation it prevents.
 */

/**
 * The statement the barrier runs and discards.
 *
 * Measured 2026-08-20 in the forced configuration: 6/6 correct. `SELECT 1`
 * touches no page and is 6/6 stale; `PRAGMA data_version` and
 * `PRAGMA schema_version` are 8/8 stale; so is waiting. Only a statement that
 * opens a real read transaction on the file refreshes the connection's cached
 * page 1 — and it must be a SEPARATE statement, because the one that triggers
 * the refresh still returns the stale result.
 */
export const BARRIER_SQL = 'SELECT count(*) FROM sqlite_master';

const REGISTRY_KEY = Symbol.for('browser-sqlite.epochs.v1');

type Cell = { value: number };
type Registry = Map<string, Cell>;

const registry = (): Registry => {
  const host = globalThis as unknown as Record<symbol, Registry | undefined>;
  const existing = host[REGISTRY_KEY];
  if (existing) return existing;
  const created: Registry = new Map();
  host[REGISTRY_KEY] = created;
  return created;
};

export type Epochs = {
  /** The number of commits observed in this realm for this database. */
  current: () => number;
  /** Records one commit and returns the new epoch. */
  bump: () => number;
};

/**
 * Handles onto the counter for `file`, which MUST already be normalized by
 * `normalizeDatabaseFile`. Entries are never removed: deleting one would
 * restart the counter at 0, and a worker still alive with `seen = 5` would
 * then read `5 > 0`, believe itself current forever, and serve stale data.
 */
export const epochsFor = (file: string): Epochs => {
  const map = registry();
  const existing = map.get(file);
  const cell: Cell = existing ?? { value: 0 };
  if (!existing) map.set(file, cell);
  return {
    current: () => cell.value,
    bump: () => {
      cell.value += 1;
      return cell.value;
    },
  };
};

/**
 * Where a worker's `seen` lands after the write it just served.
 *
 * `target` is the epoch captured when its lease was granted; `next` is the
 * epoch its own commit produced. Advancing only when `next === target + 1` is
 * what keeps this safe under concurrent clients: if another client committed
 * during our lease, `next` skipped, this connection never observed that
 * commit, and it must stay marked behind. Marking a connection current when it
 * is not is the only class of bug this design must make impossible.
 */
export const advanceSeen = (
  seen: number,
  target: number,
  next: number,
): number => (next === target + 1 ? next : seen);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/epochs.ts tests/unit/epochs.test.ts
git commit -m "feat(epochs): realm-wide commit counter and the seen-advance rule"
```

---

### Task 3: The writer-designation predicate

The barrier's browser test needs the failing configuration to be deterministic: writer on `w1`, reads on `w0`. At startup chance it occurs ~3 runs in 10, and a test that fails 30 % of the time pins nothing. With the designation forbidden on index 0 the control is 8/8 stale.

**Files:**
- Modify: `src/scheduler.ts:86-101` (`takeAvailable`), `:86` area (`handOver`), `:155` area (`add`), plus the factory signature
- Modify: `src/client.ts:402` (the `createScheduler` call) and the entry
- Test: `tests/unit/scheduler.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type WriterPolicy = (index: number) => boolean` from `src/scheduler.ts`
  - `type InternalSQLiteClientOptions = CreateSQLiteClientOptions & { __unsafeTestWriterPolicy?: WriterPolicy }` from `src/scheduler.ts`
  - `createScheduler(opts)` gains `canDesignateWriter?: WriterPolicy`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/scheduler.test.ts`:

```ts
describe('scheduler — writer policy', () => {
  const makeBiased = (size = 2) => {
    const scheduler = createScheduler<TestWorker>({
      canDesignateWriter: (index) => index !== 0,
    });
    const workers = Array.from({ length: size }, (_, index) => ({ index }));
    for (const worker of workers) scheduler.add(worker);
    return { scheduler, workers };
  };

  it('designates the lowest index the policy accepts', async () => {
    const { scheduler } = makeBiased(3);
    const lease = await scheduler.acquire('write');
    expect(lease.worker.index).toBe(1);
  });

  it('leaves reads untouched by the policy', async () => {
    const { scheduler } = makeBiased(2);
    const lease = await scheduler.acquire('read');
    expect(lease.worker.index).toBe(0);
  });

  it('does not designate a refused worker that joins with a write queued', async () => {
    const scheduler = createScheduler<TestWorker>({
      canDesignateWriter: (index) => index !== 0,
    });
    const pending = scheduler.acquire('write');
    scheduler.add({ index: 0 });
    await flush();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    scheduler.add({ index: 1 });
    const lease = await pending;
    expect(lease.worker.index).toBe(1);
  });

  it('does not designate a refused worker that is handed back', async () => {
    const { scheduler } = makeBiased(2);
    const reader = await scheduler.acquire('read'); // takes w0
    const pending = scheduler.acquire('write'); // no free worker yet? w1 is free
    const writer = await pending;
    expect(writer.worker.index).toBe(1);
    reader.release();
    await flush();
    // w0 returning must not steal the designation.
    writer.release();
    await flush();
    const second = await scheduler.acquire('write');
    expect(second.worker.index).toBe(1);
  });

  it('accepts every index by default — production behaviour is unchanged', async () => {
    const { scheduler } = makeScheduler(2);
    const lease = await scheduler.acquire('write');
    expect(lease.worker.index).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm test:unit`
Expected: FAIL — the first case yields index 0; `canDesignateWriter` is not a recognised option.

- [ ] **Step 3: Implement in `src/scheduler.ts`**

Add the exported types near the top of the file:

```ts
import type { CreateSQLiteClientOptions } from './client';

/**
 * Decides whether a worker index may hold the write designation. The default
 * accepts every index, so production behaviour is exactly what it was.
 */
export type WriterPolicy = (index: number) => boolean;

/**
 * TEST-ONLY, UNSUPPORTED, removable without notice.
 *
 * The barrier's browser test needs the failing configuration — writer not on
 * the worker that serves the read — to be deterministic; at startup chance it
 * occurs ~3 runs in 10. This type is declared here, and NOT in `client.ts`,
 * because `src/index.ts` re-exports only `./client` and `./errors`: keeping it
 * out of that path keeps it out of the published `.d.ts` and out of every
 * consumer's autocompletion. `CreateSQLiteClientOptions` is pulled in with
 * `import type`, which is erased at build time and creates no runtime cycle.
 *
 * A predicate that refuses every index leaves writes queued forever — use it
 * with `poolSize >= 2`.
 */
export type InternalSQLiteClientOptions = CreateSQLiteClientOptions & {
  __unsafeTestWriterPolicy?: WriterPolicy;
};
```

Widen the factory signature:

```ts
createScheduler = <W extends { index: number }>(
  opts: {
    onIdle?: (worker: W) => void;
    canDesignateWriter?: WriterPolicy;
  } = {},
): Scheduler<W> => {
```

Immediately after `let currentWriterIndex = -1;`:

```ts
const canDesignate = opts.canDesignateWriter ?? (() => true);

/**
 * Serves the writer queue from `worker` when it may hold the designation.
 * Extracted because `handOver` and `add` carried this branch twice, and a
 * predicate that lives in only one of the two copies is a silent hole.
 */
const serveWriterFirst = (worker: W): boolean => {
  if (!writerQueue.length) return false;
  if (currentWriterIndex !== worker.index && currentWriterIndex !== -1)
    return false;
  // An already-designated writer is not re-judged; only a NEW designation is.
  if (currentWriterIndex === -1 && !canDesignate(worker.index)) return false;
  // Claim the designation before serving: without this, a later write
  // acquisition could designate a second writer while this one still runs.
  currentWriterIndex = worker.index;
  writerQueue.shift()?.resolve(worker);
  return true;
};
```

Replace the body of `handOver`:

```ts
const handOver = (worker: W) => {
  if (serveWriterFirst(worker)) return;

  if (readerQueue.length) {
    // Reads never alter the designation — rule 1.
    readerQueue.shift()?.resolve(worker);
    return;
  }

  available.add(worker.index);
  opts.onIdle?.(worker);
};
```

Replace the writer-first branch inside `add` with `if (serveWriterFirst(worker)) return;`, keeping the rest of `add` — including the fact that it does **not** call `onIdle`.

In `takeAvailable`, filter new designations:

```ts
const found = workers.find(
  (worker) =>
    worker !== undefined &&
    available.has(worker.index) &&
    (!write || canDesignate(worker.index)),
);
```

The early-return branch for an already-designated writer is unchanged.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm test:unit`
Expected: PASS, including the pre-existing scheduler cases.

- [ ] **Step 5: Read the option at the client entry**

In `src/client.ts`, import the types and replace line 402:

```ts
import {
  createScheduler,
  type InternalSQLiteClientOptions,
  type WriterPolicy,
} from './scheduler';
```

```ts
  // TEST-ONLY, UNSUPPORTED. Read once here, validated, and converted to a
  // typed internal value so no `any` travels further. Absent from the public
  // options type on purpose — see InternalSQLiteClientOptions in scheduler.ts.
  const testWriterPolicy = (clientOptions as InternalSQLiteClientOptions
    | undefined)?.__unsafeTestWriterPolicy;
  const writerPolicy: WriterPolicy | undefined =
    typeof testWriterPolicy === 'function' ? testWriterPolicy : undefined;

  const scheduler = createScheduler<PoolWorker>(
    writerPolicy ? { canDesignateWriter: writerPolicy } : {},
  );
```

Place the two `const` declarations next to the other option reads near the top of the function, and leave the `createScheduler` call where it is.

- [ ] **Step 6: Run everything**

Run: `pnpm check && pnpm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/scheduler.ts src/client.ts tests/unit/scheduler.test.ts
git commit -m "feat(scheduler): injectable writer-designation policy, off by default"
```

---

### Task 4: The barrier itself — the two hooks

**Files:**
- Modify: `src/pool.ts` (the `PoolWorker` type, and the object built in `createPoolWorker`)
- Modify: `src/client.ts` (`acquireInstrumented`, `write`, the `createTransaction` call)
- Modify: `src/transaction.ts` (the factory deps and the `finally`)
- Test: `tests/browser/barrier.test.ts` (new)

**Interfaces:**
- Consumes: `epochsFor`, `advanceSeen`, `BARRIER_SQL` (Task 2); `__unsafeTestWriterPolicy` (Task 3).
- Produces:
  - `PoolWorker` gains `seen: number` and `epochTarget: number`
  - `createTransaction` deps gain `afterWrite: (worker: PoolWorker) => void`

- [ ] **Step 1: Write the failing test**

Create `tests/browser/barrier.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * The failing configuration is forced, not waited for: with the designation
 * forbidden on index 0 at poolSize 2, the writer is always w1 and reads always
 * land on w0. Unforced, this configuration occurs ~3 runs in 10 and the test
 * would pin nothing. Control before the barrier: 8/8 stale.
 */
const forced = { poolSize: 2, __unsafeTestWriterPolicy: (i: number) => i !== 0 };

describe('commit-propagation barrier', () => {
  // Falsifiable: delete the `if (worker.seen < target)` block in
  // applyBarrier() in src/client.ts and this goes red every run.
  it('sees a schema swap committed by another worker', async () => {
    const db = await createTestClient(forced);

    await db.write('CREATE TABLE t (old_col)');
    await db.write('INSERT INTO t (old_col) VALUES (42)');

    // Primes w0: any earlier read on the connection that later serves the
    // read is what freezes its cached page 1. output()'s sweep guarantees one.
    await db.read('SELECT * FROM t');

    await db.transaction(async (tx) => {
      await tx.write('ALTER TABLE t RENAME COLUMN old_col TO new_col');
    });

    const rows = await db.read<{ new_col: number }>('SELECT * FROM t');
    expect(rows[0]?.new_col).toBe(42);
  });

  it('sees a table dropped and replaced with a different shape', async () => {
    const db = await createTestClient(forced);

    await db.write('CREATE TABLE t (old_col)');
    await db.write('INSERT INTO t (old_col) VALUES (1)');
    await db.read('SELECT * FROM t');

    await db.transaction(async (tx) => {
      await tx.write('DROP TABLE t');
      await tx.write('CREATE TABLE t (new_col)');
      await tx.write('INSERT INTO t (new_col) VALUES (42)');
    });

    const rows = await db.read<{ new_col: number }>('SELECT * FROM t');
    expect(rows[0]?.new_col).toBe(42);
  });
});
```

`createTestClient` takes `Omit<CreateSQLiteClientOptions, 'name'>`; widen it in `tests/browser/helpers.ts` to accept the internal option:

```ts
import type { InternalSQLiteClientOptions } from '../../src/scheduler';

export async function createTestClient(
  options?: Omit<InternalSQLiteClientOptions, 'name'>,
) {
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm test:browser`
Expected: FAIL on both cases — `expected undefined to be 42`, deterministically (not intermittently). If either passes, the forced configuration is not taking effect: check that `__unsafeTestWriterPolicy` reaches `createScheduler`.

- [ ] **Step 3: Give the worker its two fields**

In `src/pool.ts`, add to the `PoolWorker` type:

```ts
  /**
   * The commit epoch this connection has absorbed. Starts at -1: a worker
   * opens the file — and reads page 1 — BEFORE it enters the pool, and a
   * commit can land in between. At poolSize 2 that is the nominal startup
   * ordering, not a rare race, so a new worker is always treated as behind and
   * pays exactly one barrier statement in its lifetime.
   */
  seen: number;
  /** The epoch captured when the current lease was granted. */
  epochTarget: number;
```

In `createPoolWorker`, initialize both on the worker object next to `status`:

```ts
  worker.seen = -1;
  worker.epochTarget = 0;
```

(Match the surrounding assignment style; if `status` is set through an object literal cast, add the two fields there instead.)

- [ ] **Step 4: Apply the barrier at the single acquisition site**

In `src/client.ts`, import `{ advanceSeen, BARRIER_SQL, epochsFor }` from `./epochs`, and after `file` is normalized:

```ts
  const epochs = epochsFor(file);

  /**
   * The barrier. Runs on a leased worker, so nothing can interleave a
   * statement between it and the query the lease was taken for — the lease
   * supplies the atomicity of the pair for free.
   *
   * `target` is captured BEFORE the statement: if another client commits while
   * it is in flight, this connection did not observe that commit and must not
   * be credited with it.
   */
  const applyBarrier = async (worker: PoolWorker) => {
    const target = epochs.current();
    worker.epochTarget = target;
    if (worker.seen >= target) return;
    // Drained, not just dispatched: it is the opening AND closing of the read
    // transaction that refreshes page 1.
    await readWorker(worker, BARRIER_SQL);
    // Only on success — a failed barrier leaves the worker marked behind so
    // the next attempt re-posts it.
    worker.seen = target;
  };

  /** Records a commit. Called after the write, before its promise resolves. */
  const afterWrite = (worker: PoolWorker) => {
    worker.seen = advanceSeen(worker.seen, worker.epochTarget, epochs.bump());
  };
```

Wrap the existing `acquireInstrumented` so both paths go through the barrier, and so a failing barrier does not leak the lease:

```ts
  const acquireInstrumented = async (kind: 'read' | 'write') => {
    const lease = clientDebug
      ? await acquireWithDebug(kind)
      : await scheduler.acquire(kind);
    try {
      await applyBarrier(lease.worker);
    } catch (error) {
      // The caller never received the lease, so its try/finally cannot return
      // the worker. Release on the same path a normal caller would.
      void lease.worker.quiesce().then(
        () => lease.release(),
        () => lease.release(),
      );
      throw error;
    }
    return lease;
  };
```

Rename the current body of `acquireInstrumented` (the debug-stamping branch) to `acquireWithDebug`, keeping its logic byte for byte; it no longer needs its `if (!clientDebug)` short-circuit.

- [ ] **Step 5: Bump after a write**

In `write()` in `src/client.ts`, in the `finally`, **before** the existing `void ... quiesce()` line:

```ts
    } finally {
      // Before the void: release is asynchronous, so write() resolves first. A
      // read chained on this promise would otherwise acquire before the
      // increment, observe the old epoch, and skip the barrier — the exact bug
      // being fixed. In `finally`, so a failed write bumps too: that costs a
      // barrier statement, never a wrong read.
      afterWrite(lease.worker);
      void lease.worker.quiesce().then(
```

- [ ] **Step 6: Bump after a read-write transaction**

In `src/transaction.ts`, widen the deps and call it:

```ts
export const createTransaction =
  (deps: {
    scheduler: Scheduler<PoolWorker>;
    afterWrite: (worker: PoolWorker) => void;
  }) =>
```

```ts
    } finally {
      // Same reasoning as write(): before the void, because release is
      // asynchronous. A read-only transaction commits nothing and must not
      // bump.
      if (!readOnly) deps.afterWrite(worker);
      void lease.worker.quiesce().then(
```

And in `src/client.ts` at the `createTransaction` call:

```ts
  const transaction = createTransaction({
    scheduler: { ...scheduler, acquire: acquireInstrumented },
    afterWrite,
  });
```

- [ ] **Step 7: Run the test and watch it pass**

Run: `pnpm test:browser`
Expected: PASS, both cases.

- [ ] **Step 8: Verify falsifiability by hand**

Comment out the `if (worker.seen >= target) return;` guard's *inverse* — that is, make `applyBarrier` return immediately before running `readWorker` — and run `pnpm test:browser` three times. Expected: both cases red every time. Restore the code.

Record the observed result in the commit message.

- [ ] **Step 9: Run everything**

Run: `pnpm check && pnpm test`
Expected: all green, 275 pre-existing plus the new cases.

- [ ] **Step 10: Commit**

```bash
git add src/pool.ts src/client.ts src/transaction.ts tests/browser/barrier.test.ts tests/browser/helpers.ts
git commit -m "feat(client): commit-propagation barrier on the acquisition path"
```

---

### Task 5: Pin the barrier as *conditional*

This test does not check correctness; it checks the design's reason to exist. Without it, anyone could silence a flake by running the barrier unconditionally: every other test would stay green and the cost would return.

**Files:**
- Modify: `tests/browser/barrier.test.ts` (append)

**Interfaces:**
- Consumes: the debug surface already exposed by `createSQLiteClient({ debug: true })`.

Every statement a worker runs is recorded already: `createQueryDebugState(index, sql, params)` is called unconditionally inside `worker.query` (`src/pool.ts:271`), and `db.debug.workers[i].requests[j].queries[k].sql` is where it lands. The barrier runs on a leased worker after the request state exists, so it attaches to the current request with no new debug API. No change to `src/debug.ts` is needed.

- [ ] **Step 1: Write the failing test**

```ts
// Falsifiable: remove the `if (worker.seen >= target) return;` guard in
// applyBarrier() — the barrier still works, every other test stays green, and
// only this one goes red. That guard is the entire difference between a
// conditional barrier and a round-trip on every single query.
it('does not repeat the barrier on a worker that is already current', async () => {
  const db = await createTestClient({ ...forced, debug: true });

  await db.write('CREATE TABLE t (a)');
  await db.read('SELECT * FROM t'); // w0 pays its barrier here
  const before = countBarrierStatements(db);
  await db.read('SELECT * FROM t'); // w0 is current — must pay nothing
  expect(countBarrierStatements(db)).toBe(before);
});
```

with the helper and the import, in the same file:

```ts
import { BARRIER_SQL } from '../../src/epochs';

const countBarrierStatements = (db: { debug?: { workers: unknown[] } }): number =>
  ((db.debug?.workers ?? []) as {
    requests: { queries: { sql: string }[] }[];
  }[])
    .flatMap((worker) => worker.requests)
    .flatMap((request) => request.queries)
    .filter((query) => query.sql === BARRIER_SQL).length;
```

`db.debug` is typed, so drop the structural annotations if the real type flows cleanly — the cast is there only to keep the helper independent of `ClientDebugState` not being exported.

- [ ] **Step 3: Run it and confirm it passes for the right reason**

Run: `pnpm test:browser`
Expected: PASS. Then temporarily delete the `if (worker.seen >= target) return;` line and re-run: expected FAIL. Restore.

- [ ] **Step 4: Commit**

```bash
git add tests/browser/barrier.test.ts
git commit -m "test(barrier): pin that a current worker pays nothing"
```

---

### Task 6: The guarantee across two clients in one tab

The floor the user set: two clients in one tab must see each other. This is the test that exercises the `globalThis` registry and the name normalization end to end.

**Files:**
- Modify: `tests/browser/barrier.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
import { createSQLiteClient } from '../../src/client';

describe('barrier — two clients in one tab', () => {
  // Falsifiable: replace the globalThis symbol registry in src/epochs.ts with
  // a per-client counter and this goes red.
  it("client B observes client A's commit", async () => {
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
    const a = createSQLiteClient(dbName, forced);
    const b = createSQLiteClient(dbName, forced);
    onTestFinished(async () => {
      await a.close();
      await b.close();
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dbName, { recursive: true }).catch(() => {});
    });

    await a.write('CREATE TABLE t (a)');
    await b.read('SELECT * FROM t'); // primes B's reading worker
    await a.write('INSERT INTO t (a) VALUES (42)');

    const rows = await b.read<{ a: number }>('SELECT * FROM t');
    expect(rows[0]?.a).toBe(42);
  });

  // Falsifiable: delete the normalizeDatabaseFile call at the entry of
  // createSQLiteClient and this goes red — the two clients key two counters.
  it('treats two spellings of one file as one database', async () => {
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
    const a = createSQLiteClient(dbName, forced);
    const b = createSQLiteClient(`./${dbName}`, forced);
    onTestFinished(async () => {
      await a.close();
      await b.close();
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dbName, { recursive: true }).catch(() => {});
    });

    await a.write('CREATE TABLE t (a)');
    await b.read('SELECT * FROM t');
    await a.write('INSERT INTO t (a) VALUES (42)');

    const rows = await b.read<{ a: number }>('SELECT * FROM t');
    expect(rows[0]?.a).toBe(42);
  });
});
```

Import `onTestFinished` from `@rstest/core`. Follow whatever cleanup pattern `tests/browser/output.test.ts:319-330` already uses for its two-client case rather than inventing another.

- [ ] **Step 2: Run and verify**

Run: `pnpm test:browser`
Expected: PASS. Then verify falsifiability of the second case by removing the normalization line from `createSQLiteClient`; expected FAIL. Restore.

- [ ] **Step 3: Commit**

```bash
git add tests/browser/barrier.test.ts
git commit -m "test(barrier): two clients in one tab, including two spellings of one file"
```

---

### Task 7: `database is locked` becomes `SQLiteError` with code `BUSY`

wa-sqlite raises `SQLiteError(message, code)` with SQLite's numeric result code (`SQLITE_BUSY` = 5, `SQLITE_LOCKED` = 6), but the worker re-posts only `message` and `cause`, so the code dies at the `postMessage` boundary and `pool.ts` can only rebuild a bare `Error`.

**Files:**
- Modify: `src/errors.ts:6-28`
- Modify: `src/types.ts:50` (the `error` variant of `WorkerMessageData`)
- Modify: `src/worker/worker.ts:261-270`
- Modify: `src/pool.ts:221-223`
- Test: `tests/unit/errors.test.ts` (append)

**Interfaces:**
- Produces: `SQLiteErrorCode` gains `'BUSY'`; `SQLiteError` gains `readonly sqliteCode?: number`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/errors.test.ts`:

```ts
describe('SQLiteError — SQLite result codes', () => {
  it('carries the numeric code alongside the discriminant', () => {
    const error = new SQLiteError('BUSY', 'database is locked', {
      sqliteCode: 5,
    });
    expect(error.code).toBe('BUSY');
    expect(error.name).toBe('BUSY');
    expect(error.sqliteCode).toBe(5);
  });

  it('leaves sqliteCode undefined for errors this library raises itself', () => {
    expect(new SQLiteError('CLIENT_CLOSED', 'closed').sqliteCode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm test:unit`
Expected: FAIL — `'BUSY'` is not assignable to `SQLiteErrorCode`.

- [ ] **Step 3: Implement in `src/errors.ts`**

```ts
export type SQLiteErrorCode =
  | 'NOT_A_READ_QUERY'
  | 'CLIENT_CLOSED'
  | 'WORKER_CRASHED'
  | 'TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_OPTION'
  | 'INVALID_PRAGMA'
  | 'BULK_WRITE_FAILED'
  | 'BUSY';

export class SQLiteError extends Error {
  readonly code: SQLiteErrorCode;
  /**
   * SQLite's own numeric result code, present only when the failure came from
   * SQLite rather than from this library. `BUSY` covers both SQLITE_BUSY (5)
   * and SQLITE_LOCKED (6); this is how a caller tells them apart.
   */
  readonly sqliteCode?: number;

  constructor(
    code: SQLiteErrorCode,
    message: string,
    options?: { cause?: unknown; sqliteCode?: number },
  ) {
    super(message, options);
    this.code = code;
    this.name = code;
    if (options?.sqliteCode !== undefined) this.sqliteCode = options.sqliteCode;
  }
}
```

- [ ] **Step 4: Carry the code across the boundary**

`src/types.ts`, the `error` variant:

```ts
  | {
      type: 'error';
      callId: number;
      message: string;
      cause?: unknown;
      /** SQLite's numeric result code, when the failure came from SQLite. */
      sqliteCode?: number;
    }
```

`src/worker/worker.ts`, in the query `catch (e)` block, add one spread after the existing message/cause spread:

```ts
        } catch (e) {
          reply({
            type: 'error',
            callId,
            ...(typeof e === 'object'
              ? e instanceof Error
                ? { message: e.message, cause: cloneable(e.cause) }
                : { message: 'Unknown error', cause: e }
              : { message: `Unknown error (${e})` }),
            // wa-sqlite raises SQLiteError(message, code) with SQLite's numeric
            // result code. Without this the code dies at the postMessage
            // boundary and the client can only string-match the message.
            ...(typeof (e as { code?: unknown })?.code === 'number'
              ? { sqliteCode: (e as { code: number }).code }
              : {}),
          });
```

`src/pool.ts`, above `createPoolWorker`:

```ts
/** SQLITE_BUSY and SQLITE_LOCKED — the two ways a lock conflict reports. */
const BUSY_CODES = new Set([5, 6]);

/**
 * Mints a typed error only for lock conflicts. Every other SQLite failure
 * keeps today's shape — a plain Error carrying SQLite's message — so no
 * existing consumer's error handling changes.
 */
const workerError = (data: { message: string; cause?: unknown; sqliteCode?: number }) =>
  data.sqliteCode !== undefined && BUSY_CODES.has(data.sqliteCode)
    ? new SQLiteError('BUSY', data.message, {
        cause: data.cause,
        sqliteCode: data.sqliteCode,
      })
    : new Error(data.message, { cause: data.cause });
```

and in `case 'error':` replace `const error = new Error(data.message, { cause: data.cause });` with `const error = workerError(data);`.

- [ ] **Step 5: Run everything**

Run: `pnpm check && pnpm test`
Expected: all green. `SQLiteError extends Error`, so any existing test asserting `instanceof Error` on a query failure still passes.

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts src/types.ts src/worker/worker.ts src/pool.ts tests/unit/errors.test.ts
git commit -m "feat(errors): SQLITE_BUSY and SQLITE_LOCKED surface as SQLiteError('BUSY')"
```

---

### Task 8: Never return a worker to the pool with an open transaction

If `COMMIT` fails and the fallback `ROLLBACK` fails too, `done` stays `false` and the transaction is still open on that connection. The lease is released anyway. A read inside an open transaction reads that transaction's snapshot, so the barrier would run, succeed, mark the worker current, and the worker would still serve stale data — the only scenario in which this design lies silently.

**Files:**
- Modify: `src/transaction.ts:120-140`
- Modify: `src/client.ts` (the `createTransaction` call)
- Test: `tests/unit/transaction.test.ts` (new)

**Interfaces:**
- Consumes: `afterWrite` (Task 4).
- Produces: `createTransaction` deps gain `onPoisoned: (index: number, error: SQLiteError) => void`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/transaction.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import { createTransaction } from '../../src/transaction';

/** A worker whose statements can be made to fail by name. */
const fakeWorker = (failOn: string[]) => {
  const executed: string[] = [];
  return {
    index: 3,
    executed,
    // eslint-disable-next-line require-yield
    query: async function* (sql: string) {
      executed.push(sql);
      if (failOn.some((needle) => sql.startsWith(needle)))
        throw new SQLiteError('BUSY', `database is locked (${sql})`);
      yield [] as Record<string, unknown>[];
    },
    interrupt: () => {},
    quiesce: async () => {},
  };
};

const harness = (worker: ReturnType<typeof fakeWorker>) => {
  const poisoned: number[] = [];
  const scheduler = {
    acquire: async () => ({ worker, release: () => {} }),
  };
  const transaction = createTransaction({
    scheduler: scheduler as never,
    afterWrite: () => {},
    onPoisoned: (index: number) => poisoned.push(index),
  });
  return { transaction, poisoned };
};

describe('transaction — a poisoned connection is never re-lent', () => {
  // Falsifiable: delete the onPoisoned call in the catch of the fallback
  // rollback in src/transaction.ts and this goes red. Without it the worker
  // goes back to the pool with an open transaction, where the barrier would
  // refresh nothing and report success.
  it('evicts the worker when the fallback ROLLBACK also fails', async () => {
    const worker = fakeWorker(['COMMIT', 'ROLLBACK']);
    const { transaction, poisoned } = harness(worker);

    await expect(
      transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
      }),
    ).rejects.toBeInstanceOf(SQLiteError);

    expect(poisoned).toEqual([3]);
  });

  it('does not evict when the rollback succeeds', async () => {
    const worker = fakeWorker(['COMMIT']);
    const { transaction, poisoned } = harness(worker);

    await expect(transaction(async () => {})).rejects.toBeInstanceOf(SQLiteError);
    expect(poisoned).toEqual([]);
  });

  it('does not evict a transaction that committed cleanly', async () => {
    const worker = fakeWorker([]);
    const { transaction, poisoned } = harness(worker);

    await transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
    });
    expect(poisoned).toEqual([]);
  });
});
```

Adjust the fake's shape to whatever `readWorker`/`writeWorker` actually consume (`query` returning an async generator of `T[] | number`); run the test to find out rather than guessing, and keep the fake minimal.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm test:unit`
Expected: FAIL — `onPoisoned` is not a recognised dep, `poisoned` stays empty.

- [ ] **Step 3: Implement in `src/transaction.ts`**

```ts
export const createTransaction =
  (deps: {
    scheduler: Scheduler<PoolWorker>;
    afterWrite: (worker: PoolWorker) => void;
    /**
     * Called when a connection may still hold an open transaction. The worker
     * is evicted rather than repaired: a "dirty worker" state is one more
     * state the barrier would have to reason about, while a respawned
     * connection is transaction-free by construction.
     */
    onPoisoned: (index: number, error: SQLiteError) => void;
  }) =>
```

In the `catch (e)` block:

```ts
      if (!done) {
        try {
          await db.rollback();
        } catch {
          // A failed rollback must not replace the caller's error, which is the
          // one that explains what actually went wrong. But the connection may
          // now hold an open transaction, and a read inside one reads that
          // transaction's snapshot — the barrier would refresh nothing and
          // report success. Evict instead of hoping.
          deps.onPoisoned(
            worker.index,
            new SQLiteError(
              'WORKER_CRASHED',
              `Worker ${worker.index + 1} may hold an open transaction after a failed rollback.`,
              { cause: e },
            ),
          );
        }
      }
      throw e;
```

Import `SQLiteError` from `./errors`.

- [ ] **Step 4: Wire it in `src/client.ts`**

`handleDeath` is declared *after* the `createTransaction` call, so it must be reached lazily — passing the reference directly is a temporal-dead-zone `ReferenceError` at construction time:

```ts
  const transaction = createTransaction({
    scheduler: { ...scheduler, acquire: acquireInstrumented },
    afterWrite,
    // Wrapped, not passed by reference: handleDeath is declared further down
    // and would be in its temporal dead zone here.
    onPoisoned: (index, error) => handleDeath(index, error),
  });
```

- [ ] **Step 5: Run everything**

Run: `pnpm check && pnpm test`
Expected: all green, including the pre-existing `tests/browser/transaction.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/transaction.ts src/client.ts tests/unit/transaction.test.ts
git commit -m "fix(transaction): evict a worker whose fallback rollback failed"
```

---

### Task 9: Unpin the two `poolSize: 1` tests

The real evidence that the barrier works on the actual path rather than on a scenario written for it.

**Files:**
- Modify: `tests/browser/output.test.ts:37-41` and `:319-328`

- [ ] **Step 1: Remove the pins**

Delete `poolSize: 1` from `createTestClient({ poolSize: 1 })` at line 41, and from both `createSQLiteClient(dbName, { poolSize: 1 })` calls at lines 327-328. Replace the two explanatory comments — which currently say the pin removes cross-worker staleness as a variable — with one line each stating that the barrier now supplies the guarantee and naming this plan's barrier test as the place the property is pinned.

- [ ] **Step 2: Run the two tests twenty times**

Run: `for i in $(seq 1 20); do pnpm test:browser || break; done`
Expected: 20 consecutive green runs — the same bar that was used to pin them (the second test measured ~7.5 % failure before pinning, so anything less than 20 proves nothing).

Record the observed count in the commit message. If any run fails, STOP and report: the barrier does not cover `output()`'s real path, which invalidates Task 4's premise rather than this task's.

- [ ] **Step 3: Commit**

```bash
git add tests/browser/output.test.ts
git commit -m "test(output): back to the default pool size, the barrier covers it"
```

---

### Task 10: The prelude A/B measurement

Owed by the spec (§10.1). `sqlite_master` has its b-tree root on page 1, so `LIMIT 1` touches exactly the page that must be re-read and nothing else — but the dominant cost of a barrier is the `postMessage` round-trip, not the SQL, so the difference may well be noise. This is a measurement with a decision, not a refactor.

**Files:**
- Possibly modify: `src/epochs.ts` (the `BARRIER_SQL` constant only)
- Modify: `docs/superpowers/specs/2026-08-21-ryow-barrier-design.md` (§10.1, record the result)

- [ ] **Step 1: Measure the current constant**

Run `pnpm test:browser` six times with `BARRIER_SQL = 'SELECT count(*) FROM sqlite_master'` and record: pass count out of 6, and the reported duration of `tests/browser/barrier.test.ts`.

- [ ] **Step 2: Measure the candidate**

Change `BARRIER_SQL` to `'SELECT rowid FROM sqlite_master LIMIT 1'`. Run `pnpm test:browser` six times. Record the same two numbers.

- [ ] **Step 3: Decide**

Adopt the candidate **only if it is 6/6 correct**. If it is 6/6 and not measurably slower, keep it. If it is anything less than 6/6, revert to `count(*)` — the only form with a prior 6/6 measurement — and say so in the spec.

- [ ] **Step 3b: Measure what the conditional barrier saves**

Also owed by §10.1. On a read-dominated load — one write, then 50 reads at `poolSize: 2` with `debug: true` — record `countBarrierStatements` (Task 5's helper). Expected: at most `poolSize` per write, so ≤ 2, against 51 for an unconditional barrier. Write the two numbers into the spec beside the A/B table; they are what justifies the conditional design against the simpler one.

- [ ] **Step 4: Record both numbers in the spec**

Replace the "owed" paragraph in §10.1 with the measured table and the decision, so the next session does not re-run it.

- [ ] **Step 5: Commit**

```bash
git add src/epochs.ts docs/superpowers/specs/2026-08-21-ryow-barrier-design.md
git commit -m "perf(barrier): measure the two prelude forms, record the decision"
```

---

### Task 11: Documentation

**Files:**
- Modify: `README.md:215`, `README.md:228`
- Modify: JSDoc on `read`, `chunk`, `stream`, `first` in `src/client.ts`

- [ ] **Step 1: Rewrite the README caveat at line 215**

The mechanism paragraph already there is accurate and stays. Replace its conclusion — *"For a hard read-your-own-writes guarantee, issue the read inside the same `transaction()` as the write, or use `poolSize: 1`."* — with:

```markdown
**Read-your-own-writes is guaranteed within a tab.** Once a write has resolved,
any read issued afterwards — from that client or from any other client in the
same tab on the same database — observes it, whatever the pool size. A worker
that has not yet observed the latest commit runs one discarded statement that
opens a real read transaction before it serves the query; that costs one extra
worker round-trip on each worker's first statement after a write, and nothing
under read-only load. `poolSize: 1` and reading inside the same `transaction()`
remain valid, they are no longer required.

**It is not guaranteed across tabs.** A write in one tab may not be visible to a
read in another. No bound is claimed on how long that lasts.

**Nothing serializes writes between clients.** Two clients writing to one
database concurrently can fail on a lock; the failure surfaces as
`SQLiteError` with code `BUSY` and `sqliteCode` 5 or 6, and it is **not**
retried — no `busy_timeout` is applied. This was true before the guarantee
above existed; it matters now because the guarantee makes several clients on
one database a reasonable thing to do.
```

- [ ] **Step 2: Rewrite the bullet at line 228**

```markdown
- **Read-your-own-writes is guaranteed within a tab, not across tabs.** See the
  caveat under [Error handling](#error-handling).
```

- [ ] **Step 3: Update the four JSDoc blocks**

On `read`, `chunk`, `stream` and `first` in `src/client.ts`, replace the sentence stating that RYOW is not guaranteed across workers with one stating that it is guaranteed within the tab and not across tabs. Do **not** mention `__unsafeTestWriterPolicy` anywhere.

- [ ] **Step 4: Add `BUSY` to the error documentation**

Wherever the README lists `SQLiteErrorCode` values, add `BUSY` with one line: raised when SQLite reports a lock conflict (`SQLITE_BUSY` or `SQLITE_LOCKED`), carrying the numeric code on `sqliteCode`. If no such list exists, skip this step.

- [ ] **Step 5: Verify no leak of the test option**

Run: `grep -rn "__unsafeTestWriterPolicy" README.md src/client.ts` — expected: no match in `README.md`, and in `src/client.ts` only the single read site with its TEST-ONLY comment.

Run: `pnpm build && grep -rn "__unsafeTestWriterPolicy" dist/*.d.ts` — expected: no match.

- [ ] **Step 6: Run everything and commit**

```bash
pnpm check && pnpm test
git add README.md src/client.ts
git commit -m "docs: read-your-own-writes is guaranteed within a tab"
```

---

## Done criteria

- [ ] `pnpm check` clean, `tsc --noEmit` clean (via `pnpm build`), full suite green
- [ ] `tests/browser/barrier.test.ts` verified falsifiable by hand for each of its four cases
- [ ] The two previously pinned `output()` tests run at the default pool size, 20 consecutive green runs
- [ ] `grep -rn "__unsafeTestWriterPolicy" dist/` returns nothing
- [ ] §10.1 of the spec records the measured prelude decision
- [ ] Nothing in this plan touched cross-tab visibility, write mutual exclusion, the writer stickiness, or `COOP-1`
