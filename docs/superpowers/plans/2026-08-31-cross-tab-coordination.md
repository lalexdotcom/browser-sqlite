# Cross-Tab Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize writes across every client and tab in an origin, and make a commit in one tab visible to the others.

**Architecture:** One origin-wide exclusive Web Lock per database serializes writers, taken at `acquireInstrumented` — the single choke point every read, write, transaction and bulk already passes through. Visibility rides on a second lock whose *name encodes the commit epoch*, so reading the origin's epoch is `max(n)` over held names rather than a message that can be in flight. Both key on a storage namespace derived from `VFS_CAPABILITIES[vfs].layout`, never on the VFS name.

**Tech Stack:** TypeScript, `navigator.locks`, wa-sqlite, rstest (unit project = Node, browser project = Playwright Chromium/Firefox), biome.

**Spec:** `docs/superpowers/specs/2026-08-31-cross-tab-coordination-design.md`

## Invariants — break one of these and the feature is wrong

**Read this section before every task. Each line names what goes wrong if it is broken.**

### Ordering — these are the whole design

- **I1 · Lock before lease, never after.** Taking the worker first holds a pool worker while blocked on a cross-tab lock: at `poolSize: 2`, two queued writes starve this tab's own reads behind a lock another tab holds.
- **I2 · The epoch bump stays synchronous.** `client.ts` posts it in the write path's `finally` because `release` is async; a read chained after `write()` would otherwise see the old epoch. **Nothing in this plan may make `epochs.current()` async** — that is why the origin's contribution folds into `applyBarrier` and nowhere else.
- **I3 · The origin can only RAISE the target, never lower it.** The realm-wide cell is a *floor*, not a cache of the origin's value. Break this and the last realm holding a marker dying makes `max` fall to 0, a live worker reads `seen 5 >= 0`, and it believes itself current for ever. `epochs.ts:51-53` describes the same hole.
- **I4 · New marker acquired before the old one is released.** `max` must never dip between the two, not even for a microtask.
- **I5 · The write lock is released only after this write's marker is published.** Otherwise another tab takes the lock, runs its `query()`, and misses the commit that just happened.

### Keying

- **I6 · Never key a lock or the epoch on the VFS name.** `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS` and `OPFSWriteAheadVFS` resolve one database name to the same OPFS path. **A missed conflict corrupts; an invented one only slows** — when in doubt, key coarser.
- **I7 · One marker per realm per database.** Released only when a higher one is taken — **never on `close()`**. This is the bound that keeps `query()` cheap; `query()` is linear in the origin's held-lock count.
- **I8 · The marker is held in `shared` mode.** Nobody reads the lock — the name is the state. Exclusive would make two realms arriving at the same `n` block on each other *inside the write lock*, with no bound.

### What must not move

- **I9 · `Lease.release()` stays idempotent.** A dropped release now leaks an origin-wide lock, not merely a worker.
- **I10 · Read paths take no write lock.** Reads, streams, `chunk`, `first` and `readOnly` transactions must never queue behind a writer.
- **I11 · One query in flight per worker.** Untouched by this work, and the statement cache's correctness depends on it — a second concurrent caller lands a `reset` on a statement another query is stepping.
- **I12 · Availability stays unreachable from outside `scheduler.ts`.** No `available` flag on a worker object, ever.

### Testing

- **I13 · Never await a second client to completion inside the first's transaction callback.** In reduced mode the second waits for the rotated exclusive OPFS handle, so the two deadlock and the test hangs rather than fails. Every cross-client wait is **bounded** by `settledWithin`, and only awaited to completion after the first transaction has returned. `multi-client.test.ts`'s first version made exactly this mistake.
- **I14 · Name the line whose deletion makes each test fail**, and for the load-bearing ones actually delete it, observe red, restore, observe green. A reasoned falsifiability claim is worth nothing here — four of wave 3's were wrong.

## Global Constraints

- **Serena's symbolic tools are primary for code.** `get_symbols_overview` / `find_symbol` to read, `replace_symbol_body` / `replace_content` to edit. Built-in Read/Edit only for `.md` and config.
- **Every commit must land on green.** The pre-commit hook runs the whole suite (`pnpm test`) and refuses a red tree, so a failing test and the code that satisfies it belong to the **same** task. Never plan a commit after a RED step.
- **Run `pnpm check` after every modification** (biome, `--write`).
- **Both engines, always.** A browser assertion is verified on Chromium *and* `TEST_BROWSER=firefox`. Firefox is the only engine here that exercises the reduced-mode path, and it is a CI gate.
- Verification baseline to compare against: `tsc --noEmit` clean, `pnpm build` clean, **470 tests / 0 failed files**, conformance 73 passed / 12 skipped on both engines. Read `status` **and** `failedFiles` from a test report, not just the per-test counters.

---

### Task 1: The storage namespace, and the two lock names that take it

**Files:**
- Modify: `src/locks.ts` (`initLockName`, new `namespaceFor` / `sharesStorage` / `writeLockName`)
- Modify: `src/worker/worker.ts:207` (call site)
- Modify: `src/delete.ts:84` (call site)
- Test: `tests/unit/locks.test.ts`

**Interfaces:**
- Consumes: `VFS_CAPABILITIES` and the `SQLiteVFS` type from `src/types.ts`.
- Produces:
  - `namespaceFor(vfs: SQLiteVFS): string`
  - `sharesStorage(vfs: SQLiteVFS): boolean`
  - `initLockName(vfs: SQLiteVFS, file: string): string` — **signature changed**, was `(file)`
  - `writeLockName(vfs: SQLiteVFS, file: string): string`

**Invariants this task carries:** **I6** — the whole task is I6. If a test you write would still pass with `namespaceFor` returning `vfs` unconditionally, it is not testing this task.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/locks.test.ts` (and import `namespaceFor`, `sharesStorage`, `writeLockName` alongside the existing imports):

```typescript
describe('namespaceFor', () => {
  // Falsifiable: return `vfs` unconditionally and this goes red. That is the
  // whole point — these four VFS open the SAME OPFS path for one name, so a
  // per-VFS key would let two clients write the same bytes unexcluded.
  it('gives every opfs-path VFS one namespace', () => {
    expect(namespaceFor('OPFSAdaptiveVFS')).toBe('opfs');
    expect(namespaceFor('OPFSAnyContextVFS')).toBe('opfs');
    expect(namespaceFor('OPFSCoopSyncVFS')).toBe('opfs');
    expect(namespaceFor('OPFSWriteAheadVFS')).toBe('opfs');
  });

  it('keeps the two idb-store VFS apart — each owns its own IndexedDB database', () => {
    expect(namespaceFor('IDBBatchAtomicVFS')).not.toBe(
      namespaceFor('IDBMirrorVFS'),
    );
  });

  it('keeps AccessHandlePoolVFS out of the opfs namespace', () => {
    // Its own directory, random filenames: /<file> is not its file.
    expect(namespaceFor('AccessHandlePoolVFS')).not.toBe('opfs');
  });
});

describe('sharesStorage', () => {
  it('is false only for the memory VFS', () => {
    expect(sharesStorage('MemoryVFS')).toBe(false);
    expect(sharesStorage('MemoryAsyncVFS')).toBe(false);
    expect(sharesStorage('OPFSAdaptiveVFS')).toBe(true);
    expect(sharesStorage('IDBBatchAtomicVFS')).toBe(true);
  });
});

describe('writeLockName', () => {
  it('is shared by the opfs-path VFS and distinct per file', () => {
    expect(writeLockName('OPFSAdaptiveVFS', 'a.db')).toBe(
      writeLockName('OPFSCoopSyncVFS', 'a.db'),
    );
    expect(writeLockName('OPFSAdaptiveVFS', 'a.db')).not.toBe(
      writeLockName('OPFSAdaptiveVFS', 'b.db'),
    );
  });

  it('does not collide with the init, sweep or staging namespaces', () => {
    const write = writeLockName('OPFSAdaptiveVFS', 'a.db');
    expect(write).not.toBe(initLockName('OPFSAdaptiveVFS', 'a.db'));
    expect(write).not.toBe(sweepLockName('a.db'));
    expect(write.startsWith('bsq:write:')).toBe(true);
  });
});
```

Replace the existing `describe('initLockName', …)` block wholesale — its two `it`s call the old one-argument signature:

```typescript
describe('initLockName', () => {
  it('is distinct per database file', () => {
    expect(initLockName('OPFSAdaptiveVFS', 'a.db')).not.toBe(
      initLockName('OPFSAdaptiveVFS', 'b.db'),
    );
  });

  it('is shared by VFS that open the same file', () => {
    expect(initLockName('OPFSAdaptiveVFS', 'a.db')).toBe(
      initLockName('OPFSWriteAheadVFS', 'a.db'),
    );
  });

  it('does not collide with the sweep or staging namespaces', () => {
    expect(initLockName('OPFSAdaptiveVFS', 'a.db')).not.toBe(
      sweepLockName('a.db'),
    );
    expect(initLockName('OPFSAdaptiveVFS', 'a.db').startsWith('bsq:init:')).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm exec rstest --project unit tests/unit/locks.test.ts`
Expected: FAIL — `namespaceFor is not a function`, and the `initLockName` block red on arity.

- [ ] **Step 3: Implement in `src/locks.ts`**

Add at the top of the file, next to the existing imports (there are none today — this introduces the first):

```typescript
import { VFS_CAPABILITIES } from './types';
import type { SQLiteVFS } from './types';
```

Then replace `initLockName` with:

```typescript
/**
 * The storage namespace a VFS writes into — derived from `layout`, NEVER from
 * the VFS name.
 *
 * `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS` and
 * `OPFSWriteAheadVFS` all walk from `navigator.storage.getDirectory()` and open
 * `getFileHandle(filename)`, so one database name is ONE file for all four. A
 * per-VFS key would let two of them write the same bytes without ever
 * excluding each other: a missed conflict corrupts, an invented one only slows.
 *
 * `idb-store` goes finer than its layout on purpose — its two VFS each own an
 * IndexedDB database named after their class, so grouping them would invent a
 * conflict for free. `opfs-pool` and `memory` are alone in their layout, so the
 * VFS name is already the namespace.
 *
 * `worker/worker.ts:627` gates on `layout` for the same reason, in those words.
 */
export const namespaceFor = (vfs: SQLiteVFS): string =>
  VFS_CAPABILITIES[vfs].layout === 'opfs-path' ? 'opfs' : vfs;

/**
 * Whether two clients on this VFS can reach the same bytes at all.
 *
 * False for the memory VFS: its pages live in the worker that opened them and
 * `maxPoolSize` is 1, so two clients on one name are two independent
 * databases. Locking them against each other would be wrong as well as slow —
 * an origin round trip charged to the VFS chosen for speed. `delete.ts:79`
 * skips the same layout, for the same reason.
 */
export const sharesStorage = (vfs: SQLiteVFS): boolean =>
  VFS_CAPABILITIES[vfs].layout !== 'memory';

/** Serializes database opening across the pool — replaces the SAB init mutex. */
export const initLockName = (vfs: SQLiteVFS, file: string) =>
  `bsq:init:${namespaceFor(vfs)}:${file}`;

/**
 * Serializes WRITERS across every client and tab in the origin. Exclusive, so
 * at most one is held per database at any instant however many clients exist.
 */
export const writeLockName = (vfs: SQLiteVFS, file: string) =>
  `bsq:write:${namespaceFor(vfs)}:${file}`;
```

- [ ] **Step 4: Update the two call sites**

`src/worker/worker.ts:207` — `vfs` is already in scope (it is read at `:179` as `VFSConfigs[vfs]`):

```typescript
return locks.withLock(initLockName(vfs, file), async () => {
```

`src/delete.ts:84`:

```typescript
  const ran = await createLocks().tryWithLock(initLockName(vfs, dbFile), () =>
    runDelete({ file: dbFile, vfs, build, wasm }),
  );
```

- [ ] **Step 5: Run the unit tests, then the whole suite**

Run: `pnpm exec rstest --project unit tests/unit/locks.test.ts`
Expected: PASS

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: `status: pass`, `failedFiles: 0`, 470 + the new tests, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add src/locks.ts src/worker/worker.ts src/delete.ts tests/unit/locks.test.ts
git commit -m "feat(locks): key lock names on the storage namespace, not the VFS

Four VFS resolve one database name to the same OPFS path, so a per-VFS key
would let two clients write the same bytes without excluding each other.
namespaceFor derives the key from VFS_CAPABILITIES.layout, which worker.ts
already gates on in those words."
```

---

### Task 2: `hold` learns a mode and a signal

**Files:**
- Modify: `src/locks.ts` (`Locks` type, `noOpLocks`, `createLocks`)
- Test: `tests/unit/locks.test.ts`

**Interfaces:**
- Produces: `Locks.hold(name: string, options?: { mode?: 'exclusive' | 'shared'; signal?: AbortSignal }): Promise<() => void>` — the second parameter is new and optional, so `bulk.ts`'s existing `locks.hold(stagingLockName(file, staging))` is untouched.

Why both options: the write lock must be abortable by the `signal` every public method already carries, and the epoch marker of Task 4 must be **shared** so two realms publishing the same epoch number never contend.

**Invariants this task carries:** **I8** — `shared` must actually reach `navigator.locks.request`, which is why the tests assert the options object rather than the outcome. The pre-existing `hold` abort test must stay green: check it explicitly, it is the only coverage the signal path has.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/locks.test.ts`:

```typescript
describe('hold options', () => {
  it('defaults to an exclusive request', async () => {
    const seen: unknown[] = [];
    const manager = {
      request: (_name: string, options: unknown, callback: () => Promise<unknown>) => {
        seen.push(options);
        void callback();
        return Promise.resolve();
      },
      query: async () => ({ held: [] }),
      // biome-ignore lint/suspicious/noExplicitAny: LockManager stand-in
    } as any;
    const release = await createLocks(manager).hold('bsq:probe');
    release();
    expect(seen).toEqual([{ mode: 'exclusive' }]);
  });

  it('passes a shared mode through', async () => {
    const seen: unknown[] = [];
    const manager = {
      request: (_name: string, options: unknown, callback: () => Promise<unknown>) => {
        seen.push(options);
        void callback();
        return Promise.resolve();
      },
      query: async () => ({ held: [] }),
      // biome-ignore lint/suspicious/noExplicitAny: LockManager stand-in
    } as any;
    const release = await createLocks(manager).hold('bsq:probe', {
      mode: 'shared',
    });
    release();
    expect(seen).toEqual([{ mode: 'shared' }]);
  });

  // The signal is omitted rather than passed as undefined: Web Locks rejects
  // `signal` together with `ifAvailable`, and an explicit undefined is the kind
  // of thing an engine may or may not treat as absent.
  it('includes the signal only when one was given', async () => {
    const seen: unknown[] = [];
    const manager = {
      request: (_name: string, options: unknown, callback: () => Promise<unknown>) => {
        seen.push(options);
        void callback();
        return Promise.resolve();
      },
      query: async () => ({ held: [] }),
      // biome-ignore lint/suspicious/noExplicitAny: LockManager stand-in
    } as any;
    const controller = new AbortController();
    const release = await createLocks(manager).hold('bsq:probe', {
      signal: controller.signal,
    });
    release();
    expect(seen).toEqual([{ mode: 'exclusive', signal: controller.signal }]);
  });

  it('no-op locks accept the options and still resolve a releaser', async () => {
    const release = await noOpLocks.hold('bsq:probe', { mode: 'shared' });
    expect(typeof release).toBe('function');
    release();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm exec rstest --project unit tests/unit/locks.test.ts`
Expected: FAIL — `hold` currently calls `request(name, callback)` with no options object, so `seen` is `[undefined]`.

- [ ] **Step 3: Implement in `src/locks.ts`**

In the `Locks` type, replace the `hold` member:

```typescript
  /**
   * Acquires `name` and resolves with the function that releases it.
   *
   * `mode: 'shared'` is what the epoch marker uses: many realms may hold the
   * same name at once, so publishing never waits and two realms can never
   * collide on one epoch number. `signal` aborts the WAIT — never the hold —
   * and makes the request reject with `AbortError`.
   */
  hold: (
    name: string,
    options?: { mode?: 'exclusive' | 'shared'; signal?: AbortSignal },
  ) => Promise<() => void>;
```

In `noOpLocks`, widen the stub to accept and ignore it:

```typescript
  hold: async () => () => {},
```

(unchanged in body — it already takes no declared parameters, so it satisfies the wider signature; leave it as is and make no edit here if it already reads that way.)

In `createLocks`, replace `hold`:

```typescript
    hold: (name, options) =>
      new Promise<() => void>((resolveReleaser, rejectOuter) => {
        let release!: () => void;
        const held = new Promise<void>((resolveHeld) => {
          release = resolveHeld;
        });
        // Built conditionally rather than with `signal: options?.signal`: an
        // explicit undefined is not reliably "absent" across engines, and Web
        // Locks refuses `signal` alongside `ifAvailable`.
        const requestOptions: { mode: string; signal?: AbortSignal } = {
          mode: options?.mode ?? 'exclusive',
        };
        if (options?.signal) requestOptions.signal = options.signal;
        manager
          .request(name, requestOptions, () => {
            resolveReleaser(release);
            return held;
          })
          .catch(rejectOuter);
      }),
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec rstest --project unit tests/unit/locks.test.ts`
Expected: PASS. The pre-existing `hold` abort test (`rejects.toThrow('AbortError')`) must stay green — check it explicitly.

- [ ] **Step 5: Whole suite, then commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: `status: pass`, `failedFiles: 0`.

```bash
git add src/locks.ts tests/unit/locks.test.ts
git commit -m "feat(locks): hold takes a mode and a signal

The write lock must be abortable by the signal every public method already
carries, and the epoch marker must be shared so two realms publishing the
same epoch number never contend."
```

---

### Task 3: The write lock

**Files:**
- Modify: `src/client.ts` (`acquireInstrumented` at `:543`, and the `locks`/`writeLock` bindings near `:457`)
- Test: `tests/browser/multi-client.test.ts` (all three `it`s change meaning)

**Interfaces:**
- Consumes: `writeLockName`, `sharesStorage`, `createLocks`, `Locks.hold` from Tasks 1–2.
- Produces: nothing new in the public surface. `acquireInstrumented('write', signal)` now resolves only once the origin-wide write lock is held, and the returned lease releases that lock when it releases the worker.

**Invariants this task carries:**
- **I1** — the lock is taken before `scheduler.acquire`, and every path that throws between the two releases it. There are three such paths in the code below; all three are written out.
- **I9** — the wrapper's `release` is guarded by `handedBack` so a double release does not double-release the lock.
- **I10** — `kind === 'write'` gates the lock. A `readOnly` transaction acquires with `kind: 'read'` (`transaction.ts:70`), so it is covered by that gate and by nothing else — do not add a second condition.
- **I13** — every cross-client wait in the tests is bounded by `settledWithin` and awaited to completion only after the first transaction returns.
- **Controller ruling (pre-flight):** declare `locks`, `writeLock` and `publishing` **above** `const epochs = …`, not beside it. Task 4 makes `epochs` depend on `locks`.

- [ ] **Step 1: Rewrite the three browser tests**

`tests/browser/multi-client.test.ts` — replace the file's three `it` bodies. The header comment's claim that the two regimes differ is now **false for writers** and must go with them.

Replace the file header's paragraph beginning *"**The engine is never named.**"* with:

```typescript
/**
 * What two clients writing at once actually do.
 *
 * Nothing here mentions tabs and everything here is about them: Web Locks and
 * OPFS access handles are both origin-wide, so two clients in this one page
 * contend exactly as two tabs would.
 *
 * **There is one behaviour now, not two.** Before the origin-wide write lock,
 * `readwrite-unsafe` split these tests down the middle: with it the second
 * writer was refused at once with BUSY, without it it waited for the rotated
 * exclusive handle and went through late. The lock puts the queue in front of
 * SQLite's locking on both regimes, so B always waits and always goes through.
 * `HAS_UNSAFE_HANDLES` is deliberately no longer consulted here — if a
 * regime-dependent assertion comes back, the lock has stopped covering a path.
 *
 * Every wait here is BOUNDED, and that is not decoration: the first version of
 * this file awaited B inside A's transaction callback, so on any engine where
 * B waits the two deadlocked — the test presupposed the fail-fast behaviour it
 * was written to observe.
 */
```

Then the three tests:

```typescript
describe('two clients writing at once', () => {
  // Falsifiable: delete the `locks.hold(writeLock, …)` line in
  // `acquireInstrumented` and this goes red on `settled` where handles are
  // per-connection — B is refused with BUSY instead of waiting.
  it('makes the second writer wait, on both regimes', async () => {
    const { a, b } = twoClients();
    await a.write('CREATE TABLE t (n)');

    let settled = false;
    let attempt!: Promise<unknown>;
    await a.transaction(async (tx) => {
      // A holds the write lock from here until this callback returns.
      await tx.write('INSERT INTO t VALUES (1)');
      attempt = rejectionOf(b.write('INSERT INTO t VALUES (2)'));
      settled = await settledWithin(attempt, TURNED_AWAY_WITHIN);
    });
    const error = await attempt;

    expect(settled).toBe(false);
    expect(error).toBeUndefined();

    // The invariant a consumer cares about: exactly the writes that were
    // accepted are in the database, and now BOTH are accepted.
    const rows = await a.read<{ n: number }>('SELECT n FROM t ORDER BY n');
    expect(rows.map((row) => row.n)).toEqual([1, 2]);
  });

  // I13: B is never awaited to completion inside A's callback. In reduced mode
  // a read waits for the rotated exclusive handle, so awaiting it there
  // deadlocks the test rather than failing it — which is precisely how the
  // first version of this file was written, and why it is called out.
  //
  // So what is asserted is the claim our lock actually makes: a read-only
  // transaction is never REFUSED by it. Whether it also completes promptly is
  // the VFS's business, and differs by regime.
  //
  // Falsifiable: give the readOnly branch a write lock too, and `error` becomes
  // an AbortError once the budget's signal fires — or the test times out where
  // no signal is passed. Verify by making the change, not by reasoning.
  it('never refuses a read-only transaction opened under a writer', async () => {
    const { a, b } = twoClients();
    await a.write('CREATE TABLE t (n)');
    await a.write('INSERT INTO t VALUES (1)');

    let attempt!: Promise<unknown>;
    await a.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (2)');
      attempt = rejectionOf(
        b.transaction(
          async (btx) => {
            await btx.read<{ n: number }>('SELECT n FROM t');
          },
          { readOnly: true },
        ),
      );
      // Bounded, and the result is deliberately not asserted: on one regime it
      // settles here, on the other it is still waiting on the OPFS handle.
      await settledWithin(attempt, TURNED_AWAY_WITHIN);
    });

    // Awaited to completion only now that A has let the file go.
    expect(await attempt).toBeUndefined();
  });

  // `bulkWrite` still commits PER BATCH and still takes one lock per batch —
  // `bulk.ts` calls the public `write`. So another client's write can still
  // land between two batches; what changed is that neither side is refused.
  //
  // Falsifiable by its own middle assertion: if `bulkWrite` did not commit per
  // batch, the first batch would be invisible to A until `close()` and
  // `committed` would stay 0 through all hundred polls.
  it('interleaves a bulkWrite with another client, refusing neither', async () => {
    const { a, b } = twoClients();
    const keys = Array.from({ length: 16 }, (_, i) => `c${i}`);
    await a.write(`CREATE TABLE t (${keys.join(', ')})`);

    const batch = Math.floor(32766 / keys.length);
    const row = (n: number) =>
      Object.fromEntries(keys.map((k) => [k, n])) as Record<string, number>;

    const writer = b.bulkWrite('t', keys);
    for (let i = 0; i < batch; i += 1) await writer.enqueue(row(i));

    let committed = 0;
    for (let poll = 0; poll < 100 && committed === 0; poll += 1) {
      const [count] = await a.read<{ n: number }>(
        'SELECT count(*) AS n FROM t',
      );
      committed = count?.n ?? 0;
      if (committed === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(committed).toBe(batch);

    await a.write(`INSERT INTO t (${keys[0]}) VALUES (-1)`);
    for (let i = 0; i < batch; i += 1) await writer.enqueue(row(i));
    await writer.close();

    const [after] = await a.read<{ n: number }>(
      'SELECT count(*) AS n FROM t WHERE c0 >= 0',
    );
    expect(after?.n).toBe(batch * 2);
  });
});
```

Remove the now-unused `HAS_UNSAFE_HANDLES` import and, if nothing else uses them, the `SQLiteBulkWriteError` / `SQLiteError` imports.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm exec rstest --project browser tests/browser/multi-client.test.ts`
Expected: FAIL on Chromium at `expect(settled).toBe(false)` — B is refused with `BUSY` today.

- [ ] **Step 3: Bind the lock in `src/client.ts`**

Next to `const epochs = epochsFor(dbFile);` (currently `:474`), add:

```typescript
  const locks = createLocks();
  /**
   * Undefined on the memory VFS, where two clients on one name are two
   * independent databases — see `sharesStorage`.
   */
  const writeLock = sharesStorage(vfs) ? writeLockName(vfs, dbFile) : undefined;
```

Import `createLocks`, `sharesStorage` and `writeLockName` from `./locks`.

- [ ] **Step 4: Take the lock in `acquireInstrumented`**

Replace the body of `acquireInstrumented` (`client.ts:543`) with:

```typescript
  const acquireInstrumented = async (
    kind: 'read' | 'write',
    signal?: AbortSignal,
  ) => {
    // Lock BEFORE the lease, never after. The reverse holds a pool worker
    // while blocked on a cross-tab lock: at poolSize 2, two queued writes
    // would starve this tab's own reads behind a lock another tab holds.
    //
    // The wait is abortable by the caller's signal; the HOLD is not, and must
    // not be — a lock released while SQLite still holds its own would lie.
    const releaseWrite =
      kind === 'write' && writeLock
        ? await locks.hold(writeLock, { signal })
        : undefined;

    let lease: Awaited<ReturnType<typeof scheduler.acquire>>;
    try {
      lease = clientDebug
        ? await acquireWithDebug(kind, signal)
        : await scheduler.acquire(kind, signal);
    } catch (error) {
      releaseWrite?.();
      throw error;
    }

    try {
      // Raced, not merely passed a signal. `applyBarrier` drains a real query
      // on the worker, and `PoolWorkerQueryOptions` carries no signal — so on
      // a worker that never answers, that loop is unbounded and every method
      // goes through it. Firefox 154 stopped here, on OPFSCoopSyncVFS, after
      // the two earlier abort paths were closed.
      //
      // This is the second and last phase of a call that was not already
      // abortable: `scheduler.acquire` now honours the signal while queued,
      // and the query phase has honoured it since wave 1. Guarding here rather
      // than at each public method is what makes that complete — an await
      // added to this function later is covered without being remembered.
      //
      // The race abandons the WAIT, not the WORK: the barrier statement runs
      // on. The catch below releases through `quiesce()`, which returns the
      // worker only once it is actually idle, so nothing is re-lent mid-flight.
      const { aborted, teardown } = makeAbortRace(signal);
      try {
        const barrier = applyBarrier(lease.worker);
        await (aborted ? Promise.race([barrier, aborted]) : barrier);
      } finally {
        teardown();
      }
    } catch (error) {
      // The caller never received the lease, so its try/finally cannot return
      // the worker. Release on the same path a normal caller would.
      void lease.worker.quiesce().then(
        () => lease.release(),
        () => lease.release(),
      );
      releaseWrite?.();
      throw error;
    }

    if (!releaseWrite) return lease;

    // The write lock outlives the worker: it is released once the lease is
    // released AND the epoch this write published has been taken, so no other
    // tab can acquire the lock, run its query(), and miss our marker.
    let handedBack = false;
    return {
      ...lease,
      release: () => {
        lease.release();
        if (handedBack) return;
        handedBack = true;
        void publishing.then(releaseWrite, releaseWrite);
      },
    };
  };
```

`publishing` does not exist yet — Task 6 introduces it. For **this** task, declare it beside `writeLock` as a satisfied promise so the code compiles and behaves:

```typescript
  /**
   * The in-flight epoch publication, awaited before the write lock is handed
   * back. Task 6 assigns it; until then it is always already settled.
   */
  let publishing: Promise<unknown> = Promise.resolve();
```

- [ ] **Step 5: Run the browser tests on both engines**

Run: `pnpm exec rstest --project browser tests/browser/multi-client.test.ts`
Expected: PASS

Run: `TEST_BROWSER=firefox pnpm exec rstest --project browser tests/browser/multi-client.test.ts`
Expected: PASS — the same assertions, which is the point of the task.

- [ ] **Step 6: Whole suite, then commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: `status: pass`, `failedFiles: 0`.

```bash
git add src/client.ts tests/browser/multi-client.test.ts
git commit -m "feat(client): serialize writers across every client and tab

An origin-wide exclusive lock taken at acquireInstrumented, before the lease
and never after: the reverse holds a pool worker while blocked cross-tab. The
two write regimes readwrite-unsafe used to split collapse into one — B waits,
then goes through, on both."
```

---

### Task 4: The epoch, keyed by namespace, with a floor and a name

**Files:**
- Modify: `src/epochs.ts`
- Modify: `src/client.ts:474` (call site of `epochsFor`)
- Test: `tests/unit/epochs.test.ts`

**Interfaces:**
- Consumes: `namespaceFor` (Task 1), `Locks` (Task 2).
- Produces:
  - `epochLockName(ns: string, file: string, n: number): string`
  - `maxEpochIn(heldNames: string[], prefix: string): number`
  - `epochsFor(vfs: SQLiteVFS, file: string, locks: Locks): Epochs`
  - `Epochs` gains `raiseTo(n: number): void`, `originMax(): Promise<number>`, `publish(n: number): Promise<void>`

**Invariants this task carries:**
- **I2** — `current()`, `bump()` and `raiseTo()` are **synchronous**. Only `originMax` and `publish` are async. If you find yourself making `current()` async, stop: the design is built to avoid exactly that.
- **I3** — `raiseTo` never lowers. The test that pins it is the one asserting `current()` stays 9 while `originMax()` reports 0.
- **I4** — `publish` acquires the new marker **before** releasing the previous one. The `publish` test asserts the event ORDER, which is the only thing that catches an inversion.
- **I7** — the releaser lives on the realm-wide `Cell`, not on the returned handle. Two clients in one tab must share one marker; putting it in the closure would give each client its own.
- **I8** — `{ mode: 'shared' }` on the marker.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/epochs.test.ts` (import `epochLockName`, `maxEpochIn`, and `noOpLocks` from `../../src/locks`):

```typescript
describe('epochLockName / maxEpochIn', () => {
  const prefix = 'bsq:epoch:opfs:a.db';

  it('reads the highest epoch published for this database', () => {
    const held = [
      epochLockName('opfs', 'a.db', 3),
      epochLockName('opfs', 'a.db', 7),
      epochLockName('opfs', 'a.db', 5),
    ];
    expect(maxEpochIn(held, prefix)).toBe(7);
  });

  it('ignores other databases and other namespaces', () => {
    const held = [
      epochLockName('opfs', 'b.db', 99),
      epochLockName('IDBMirrorVFS', 'a.db', 99),
      epochLockName('opfs', 'a.db', 2),
    ];
    expect(maxEpochIn(held, prefix)).toBe(2);
  });

  it('ignores every other lock this library takes', () => {
    const held = ['bsq:init:opfs:a.db', 'bsq:write:opfs:a.db', 'bsq:sweep:a.db'];
    expect(maxEpochIn(held, prefix)).toBe(0);
  });

  // The trap: a normalized file may contain ':' — `new URL('./a:b','file://')`
  // gives the pathname 'a:b'. A prefix match plus lastIndexOf would read 7 out
  // of another database's marker. The tail after the prefix must be ALL digits.
  it('does not mistake a longer file name for this one', () => {
    const held = [epochLockName('opfs', 'a.db:extra', 7)];
    expect(maxEpochIn(held, prefix)).toBe(0);
  });

  it('is zero when nothing is held', () => {
    expect(maxEpochIn([], prefix)).toBe(0);
  });
});

describe('raiseTo', () => {
  it('raises the cell and never lowers it', () => {
    const e = epochsFor('OPFSAdaptiveVFS', '/floor', noOpLocks);
    e.raiseTo(5);
    expect(e.current()).toBe(5);
    e.raiseTo(2);
    expect(e.current()).toBe(5);
    expect(e.bump()).toBe(6);
  });

  // This is what stops `max` dipping to zero when the last realm holding a
  // marker dies: a worker with `seen = 5` would read `5 >= 0` and believe
  // itself current for ever. epochs.ts:51-53 describes the same hole.
  it('keeps the floor even when the origin reports nothing', async () => {
    const e = epochsFor('OPFSAdaptiveVFS', '/no-origin', noOpLocks);
    e.raiseTo(9);
    expect(await e.originMax()).toBe(0);
    expect(e.current()).toBe(9);
  });
});

describe('namespaced epoch keys', () => {
  it('shares one counter between VFS that open the same file', () => {
    const a = epochsFor('OPFSAdaptiveVFS', '/same', noOpLocks);
    const b = epochsFor('OPFSCoopSyncVFS', '/same', noOpLocks);
    a.bump();
    expect(b.current()).toBe(1);
  });

  it('keeps namespaces apart', () => {
    const a = epochsFor('OPFSAdaptiveVFS', '/apart-ns', noOpLocks);
    const b = epochsFor('IDBMirrorVFS', '/apart-ns', noOpLocks);
    a.bump();
    expect(b.current()).toBe(0);
  });
});

describe('publish', () => {
  it('takes the new marker before releasing the old one', async () => {
    const events: string[] = [];
    const locks = {
      available: true,
      hold: async (name: string) => {
        events.push(`hold ${name}`);
        return () => events.push(`release ${name}`);
      },
      withLock: async <T>(_n: string, fn: () => Promise<T>) => fn(),
      tryWithLock: async () => true,
      heldNames: async () => [],
    };
    const e = epochsFor('OPFSAdaptiveVFS', '/publish', locks);
    await e.publish(1);
    await e.publish(2);
    expect(events).toEqual([
      'hold bsq:epoch:opfs:/publish:1',
      'hold bsq:epoch:opfs:/publish:2',
      'release bsq:epoch:opfs:/publish:1',
    ]);
  });

  it('does nothing when Web Locks is absent', async () => {
    const e = epochsFor('OPFSAdaptiveVFS', '/publish-noop', noOpLocks);
    await e.publish(1);
    expect(await e.originMax()).toBe(0);
  });
});
```

Update the existing `epochsFor` tests in that file to the three-argument signature — `epochsFor('OPFSAdaptiveVFS', '/counts-up', noOpLocks)` and so on, including the falsifiability test that asserts the symbol registry is used.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec rstest --project unit tests/unit/epochs.test.ts`
Expected: FAIL — `epochLockName is not a function`, and the existing tests red on arity.

- [ ] **Step 3: Implement in `src/epochs.ts`**

```typescript
import { namespaceFor } from './locks';
import type { Locks } from './locks';
import type { SQLiteVFS } from './types';

/**
 * The marker a realm holds to publish the epoch it last committed.
 *
 * Held in SHARED mode: many realms may hold one name at once, so publishing
 * never waits and two realms can never collide on a number. Nobody reads the
 * lock — the NAME is the state, which is why this beats a BroadcastChannel:
 * there is no message that can still be in flight.
 */
export const epochLockName = (ns: string, file: string, n: number) =>
  `bsq:epoch:${ns}:${file}:${n}`;

/**
 * The highest epoch any realm in this origin has published under `prefix`.
 *
 * The tail after the prefix must be ALL digits, which is stricter than a
 * prefix match plus `lastIndexOf(':')` and is the point: a normalized file may
 * contain a colon (`new URL('./a:b', 'file://').pathname` is `a:b`), so the
 * loose form would read another database's epoch as this one's.
 */
export const maxEpochIn = (heldNames: string[], prefix: string): number => {
  let max = 0;
  for (const name of heldNames) {
    if (!name.startsWith(`${prefix}:`)) continue;
    const tail = name.slice(prefix.length + 1);
    if (!/^\d+$/.test(tail)) continue;
    const n = Number(tail);
    if (n > max) max = n;
  }
  return max;
};

const REGISTRY_KEY = Symbol.for('browser-sqlite.epochs.v1');

type Cell = { value: number; releaseMarker?: () => void };
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
  /** The number of commits observed for this database, floor included. */
  current: () => number;
  /** Records one commit and returns the new epoch. */
  bump: () => number;
  /** Raises the local floor. Never lowers it. */
  raiseTo: (n: number) => void;
  /** The highest epoch published by any realm in this origin. */
  originMax: () => Promise<number>;
  /** Publishes `n` for this realm, replacing its previous marker. */
  publish: (n: number) => Promise<void>;
};

/**
 * Handles onto the counter for `(namespace, file)`, which MUST already be
 * normalized by `normalizeDatabaseFile`. Entries are never removed: deleting
 * one would restart the counter at 0, and a worker still alive with `seen = 5`
 * would then read `5 > 0`, believe itself current forever, and serve stale
 * data.
 *
 * The cell is realm-wide, so every client in a tab shares one counter AND one
 * marker — publication is per realm, not per client.
 */
export const epochsFor = (
  vfs: SQLiteVFS,
  file: string,
  locks: Locks,
): Epochs => {
  const ns = namespaceFor(vfs);
  const key = `${ns}:${file}`;
  const map = registry();
  const existing = map.get(key);
  const cell: Cell = existing ?? { value: 0 };
  if (!existing) map.set(key, cell);

  const prefix = `bsq:epoch:${ns}:${file}`;

  return {
    current: () => cell.value,
    bump: () => {
      cell.value += 1;
      return cell.value;
    },
    raiseTo: (n) => {
      if (n > cell.value) cell.value = n;
    },
    originMax: async () =>
      locks.available ? maxEpochIn(await locks.heldNames(), prefix) : 0,
    publish: async (n) => {
      if (!locks.available) return;
      const previous = cell.releaseMarker;
      // New before old, always: `max` must never dip between the two.
      cell.releaseMarker = await locks.hold(epochLockName(ns, file, n), {
        mode: 'shared',
      });
      previous?.();
    },
  };
};
```

Keep `advanceSeen` and `BARRIER_SQL` exactly as they are.

- [ ] **Step 4: Update the call site in `src/client.ts`**

```typescript
  const epochs = epochsFor(vfs, dbFile, locks);
```

(`locks` was bound in Task 3; move the `const locks = createLocks();` line above `const epochs = …` if it is not already.)

- [ ] **Step 5: Run the tests**

Run: `pnpm exec rstest --project unit tests/unit/epochs.test.ts`
Expected: PASS

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: `status: pass`, `failedFiles: 0`. Behaviour is unchanged so far — `originMax` and `publish` exist but nothing calls them.

- [ ] **Step 6: Commit**

```bash
git add src/epochs.ts src/client.ts tests/unit/epochs.test.ts
git commit -m "feat(epochs): namespace the key, add a floor, name the marker

The realm cell becomes a floor rather than the authority, which is what stops
max dipping to zero when the last marker holder dies. The marker name encodes
the epoch and is held shared, so publishing never waits and two realms cannot
collide on a number."
```

---

### Task 5: A second realm in the suite

**Files:**
- Create: `tests/browser/helpers/realm.ts`
- Create: `tests/browser/realm.test.ts`

**Interfaces:**
- Produces:
  - `makeRealm(): Promise<Window>` — a hidden same-origin `about:blank` iframe, torn down by `onTestFinished`.
  - `holdIn(realm: Window, name: string, mode?: 'exclusive' | 'shared'): Promise<() => void>`
  - `heldNamesIn(realm: Window): Promise<string[]>`

This task ships **green**: it pins the platform facts the design rests on and gives Task 6 its vehicle. `multi-client.test.ts` argues that two clients in one page contend exactly as two tabs would — true of Web Locks and OPFS handles, and **false of the epoch**, which those two clients share through the realm-wide registry. Without a second realm, nothing about Task 6 is falsifiable.

**Invariants this task carries:** this task *is* the falsifier I14 asks for. If the first test ever goes red, `multi-client.test.ts`'s "two clients contend exactly as two tabs would" would start being true of the epoch as well, and every cross-tab assertion in Task 6 would be measuring nothing.

- [ ] **Step 1: Write the helper**

`tests/browser/helpers/realm.ts`:

```typescript
import { onTestFinished } from '@rstest/core';

/** The slice of the Web Locks API these helpers use. */
type LockManager = {
  request: (
    name: string,
    options: { mode: 'exclusive' | 'shared' },
    callback: () => Promise<unknown>,
  ) => Promise<unknown>;
  query: () => Promise<{ held?: { name?: string }[] }>;
};

/**
 * A second realm on this origin: a hidden same-origin `about:blank` iframe.
 *
 * This is the ONLY thing in the suite that can stand in for another tab where
 * the epoch is concerned. Web Locks and OPFS are scoped to the origin and are
 * therefore already shared by two clients in one page — but `epochs.ts` keeps
 * its Map on `globalThis`, which an iframe does not share. Verified on
 * Chromium 151 and Firefox 153 before this was written; `Symbol.for()` IS
 * shared across realms, so the separation comes from `globalThis` alone.
 */
export const makeRealm = (): Promise<Window> =>
  new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = 'about:blank';
    iframe.addEventListener('load', () => {
      const win = iframe.contentWindow;
      if (win) resolve(win as Window);
      else reject(new Error('iframe produced no contentWindow'));
    });
    iframe.addEventListener('error', () =>
      reject(new Error('iframe failed to load')),
    );
    onTestFinished(() => iframe.remove());
    document.body.appendChild(iframe);
  });

/** Holds `name` in `realm`, resolving with its releaser. */
export const holdIn = (
  realm: Window,
  name: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
): Promise<() => void> =>
  new Promise<() => void>((resolveReleaser, reject) => {
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    (realm.navigator.locks as unknown as LockManager)
      .request(name, { mode }, () => {
        resolveReleaser(release);
        return held;
      })
      .catch(reject);
  });

/** Every lock name the origin holds, as seen from `realm`. */
export const heldNamesIn = async (realm: Window): Promise<string[]> => {
  const snapshot = await (
    realm.navigator.locks as unknown as LockManager
  ).query();
  return (snapshot.held ?? []).map((lock) => lock.name ?? '');
};
```

- [ ] **Step 2: Write the tests that pin the platform**

`tests/browser/realm.test.ts`:

```typescript
import { describe, expect, it } from '@rstest/core';
import { heldNamesIn, holdIn, makeRealm } from './helpers/realm';

const KEY_NAME = 'browser-sqlite.epochs.v1';

describe('a same-origin iframe as a second realm', () => {
  // If this ever goes red, `multi-client.test.ts`'s "two clients contend
  // exactly as two tabs would" would start being true of the epoch too, and
  // the cross-tab tests would be measuring nothing.
  it('does not share the epoch registry with the parent', async () => {
    const realm = await makeRealm();
    const parentSymbol = Symbol.for(KEY_NAME);
    const realmSymbol = realm.Symbol.for(KEY_NAME);

    // Measured 2026-08-31 on both engines: the global SYMBOL registry IS
    // shared across realms. The separation comes from `globalThis`, which is
    // where `epochs.ts` puts its Map — not from the symbol.
    expect(realmSymbol).toBe(parentSymbol);

    (globalThis as unknown as Record<symbol, unknown>)[parentSymbol] = new Map([
      ['probe.db', { value: 42 }],
    ]);
    expect(
      (realm as unknown as Record<symbol, unknown>)[realmSymbol],
    ).toBeUndefined();
  });

  it('shares Web Locks with the parent, both directions', async () => {
    const realm = await makeRealm();

    const fromRealm = await holdIn(realm, 'bsq:test:from-realm');
    expect(await heldNamesIn(window)).toContain('bsq:test:from-realm');
    fromRealm();

    const fromParent = await holdIn(window, 'bsq:test:from-parent');
    expect(await heldNamesIn(realm)).toContain('bsq:test:from-parent');
    fromParent();
  });

  it('contends with the parent for an exclusive name', async () => {
    const realm = await makeRealm();
    const held = await holdIn(window, 'bsq:test:contended');

    let granted = false;
    const contender = holdIn(realm, 'bsq:test:contended').then((release) => {
      granted = true;
      release();
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(granted).toBe(false);

    held();
    await contender;
    expect(granted).toBe(true);
  });

  it('does not contend for a shared name — what the epoch marker relies on', async () => {
    const realm = await makeRealm();
    const inParent = await holdIn(window, 'bsq:test:shared', 'shared');
    const inRealm = await holdIn(realm, 'bsq:test:shared', 'shared');
    expect(await heldNamesIn(window)).toContain('bsq:test:shared');
    inRealm();
    inParent();
  });
});
```

- [ ] **Step 3: Run on both engines**

Run: `pnpm exec rstest --project browser tests/browser/realm.test.ts`
Expected: PASS

Run: `TEST_BROWSER=firefox pnpm exec rstest --project browser tests/browser/realm.test.ts`
Expected: PASS

- [ ] **Step 4: Whole suite, then commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: `status: pass`, `failedFiles: 0`.

```bash
git add tests/browser/helpers/realm.ts tests/browser/realm.test.ts
git commit -m "test(browser): a same-origin iframe as a second realm

Web Locks and OPFS are already shared by two clients in one page, so
multi-client.test.ts can stand in for two tabs — but the epoch lives on
globalThis, which an iframe does not share. This is the only vehicle in the
suite that can falsify anything cross-tab."
```

---

### Task 6: The origin's epoch reaches the barrier

**Files:**
- Modify: `src/client.ts` (`applyBarrier` at `:484`, `afterWrite` at `:504`)
- Create: `tests/browser/cross-tab.test.ts`

**Interfaces:**
- Consumes: `Epochs.originMax` / `raiseTo` / `publish` (Task 4), `publishing` and the write-lock wrapper (Task 3), `makeRealm` / `holdIn` (Task 5).
- Produces: no public surface change. A commit published by any realm in the origin now raises this client's barrier target.

**Invariants this task carries:**
- **I2** — `afterWrite` calls `epochs.bump()` **synchronously** and only then assigns `publishing`. Never `await` the publish inside `afterWrite`: it runs in the write path's `finally`, and awaiting there is the bug this whole design was built around.
- **I3** — `applyBarrier` calls `raiseTo(origin)`, it does not assign the origin's value. The difference is the entire point.
- **I5** — the write lock's release awaits `publishing`. That wiring lives in Task 3's lease wrapper; verify it is still there rather than re-adding it.
- **I7** — the third test asserts exactly one marker survives three commits. If it finds three, `publish` is not releasing the previous one.
- **I14** — Step 6 is not optional. Delete the `originMax` line, observe red, restore, observe green, and report both.

- [ ] **Step 1: Write the failing test**

`tests/browser/cross-tab.test.ts`:

```typescript
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { epochLockName } from '../../src/epochs';
import { namespaceFor } from '../../src/locks';
import { heldNamesIn, holdIn, makeRealm } from './helpers/realm';

const VFS = 'OPFSAdaptiveVFS' as const;

const oneClient = () => {
  const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
  const db = createSQLiteClient(dbName, { vfs: VFS, poolSize: 2 });
  onTestFinished(async () => {
    try {
      await db.close();
    } catch {
      /* a failed client has nothing to close */
    }
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dbName, { recursive: true });
    } catch {
      /* the entry may not exist if the test failed before creation */
    }
  });
  return { db, dbName };
};

describe('an epoch published by another realm', () => {
  // A foreign tab manifests to us ONLY as a held lock name, so holding that
  // name from the iframe is the whole of what a second tab does to us. It
  // isolates the mechanism rather than shortcutting it.
  //
  // Falsifiable: drop the `await epochs.originMax()` line in `applyBarrier`
  // and this goes red — `barriers` stays 0 because the local cell never hears
  // about the foreign commit.
  it('makes this client run the barrier it would otherwise skip', async () => {
    const { db, dbName } = oneClient();
    await db.write('CREATE TABLE t (n)');
    await db.write('INSERT INTO t VALUES (1)');
    // Every worker is now current with the local epoch, so a read here would
    // run no barrier at all.
    await db.read('SELECT n FROM t');

    const realm = await makeRealm();
    const marker = epochLockName(namespaceFor(VFS), dbName, 9_999);
    const release = await holdIn(realm, marker, 'shared');
    expect(await heldNamesIn(window)).toContain(marker);

    // The read must now go through BARRIER_SQL: the origin reports 9999 and
    // every worker's `seen` is far below it.
    const rows = await db.read<{ n: number }>('SELECT n FROM t');
    expect(rows.map((row) => row.n)).toEqual([1]);

    release();
  });

  it('never lets the target go backwards when the marker disappears', async () => {
    const { db, dbName } = oneClient();
    await db.write('CREATE TABLE t (n)');

    const realm = await makeRealm();
    const marker = epochLockName(namespaceFor(VFS), dbName, 4_242);
    const release = await holdIn(realm, marker, 'shared');
    await db.read('SELECT n FROM t');
    release();

    // The origin now reports nothing, but the local floor holds 4242. A write
    // must produce 4243, never 1 — a restarted counter is the one class of bug
    // this design has to make impossible (epochs.ts:51-53).
    await db.write('INSERT INTO t VALUES (1)');
    const published = (await heldNamesIn(window)).filter((name) =>
      name.startsWith(`bsq:epoch:${namespaceFor(VFS)}:${dbName}:`),
    );
    expect(published).toEqual([
      epochLockName(namespaceFor(VFS), dbName, 4_243),
    ]);
  });

  it('publishes exactly one marker per realm, whatever the pool size', async () => {
    const { db, dbName } = oneClient();
    await db.write('CREATE TABLE t (n)');
    await db.write('INSERT INTO t VALUES (1)');
    await db.write('INSERT INTO t VALUES (2)');
    await db.write('INSERT INTO t VALUES (3)');

    const prefix = `bsq:epoch:${namespaceFor(VFS)}:${dbName}:`;
    const published = (await heldNamesIn(window)).filter((name) =>
      name.startsWith(prefix),
    );
    // Three commits, one marker: the previous is released as the next is taken.
    expect(published.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec rstest --project browser tests/browser/cross-tab.test.ts`
Expected: FAIL — no marker is ever published, so the second and third tests find none.

- [ ] **Step 3: Fold the origin into `applyBarrier`**

Replace `applyBarrier` in `src/client.ts`:

```typescript
  const applyBarrier = async (worker: PoolWorker) => {
    // The origin can only ever RAISE the target. That is what lets the local
    // cell stay synchronous — `epochs.bump()` is posted in the write path's
    // finally, and a read chained after write() must see it without awaiting
    // anything. `query()` is async and could never live there.
    const origin = await epochs.originMax();
    epochs.raiseTo(origin);

    const target = epochs.current();
    worker.epochTarget = target;
    if (worker.seen >= target) return;
    // Drained, not just dispatched: it is the opening AND closing of the read
    // transaction that refreshes page 1. noServed: true prevents the barrier
    // from resetting the supervisor's restart counter — it is a synthetic probe,
    // not user work.
    const barrierIter = worker.query(BARRIER_SQL, undefined, {
      noServed: true,
    });
    while (!(await barrierIter.next()).done) {
      /* discard rows */
    }
    // Only on success — a failed barrier leaves the worker marked behind so
    // the next attempt re-posts it.
    worker.seen = target;
  };
```

- [ ] **Step 4: Publish in `afterWrite`**

Replace `afterWrite`:

```typescript
  /** Records a commit. Called after the write, before its promise resolves. */
  const afterWrite = (worker: PoolWorker) => {
    const next = epochs.bump();
    worker.seen = advanceSeen(worker.seen, worker.epochTarget, next);
    // Assigned, not awaited: the bump must stay synchronous. The write lock's
    // release awaits this, so no other tab can take the lock, run its query()
    // and miss this marker. A failure leaves this realm correct and the others
    // one commit behind; the next publish restores a higher max.
    publishing = epochs.publish(next).catch((error: unknown) => {
      logger.warn(`epoch publish failed: ${String(error)}`);
    });
  };
```

`publishing` is the `let` declared in Task 3; it keeps its `Promise<unknown>` type. Because the write lock is held across the whole write, the value read by that lease's `release()` is exactly this write's publication.

- [ ] **Step 5: Run on both engines**

Run: `pnpm exec rstest --project browser tests/browser/cross-tab.test.ts`
Expected: PASS

Run: `TEST_BROWSER=firefox pnpm exec rstest --project browser tests/browser/cross-tab.test.ts`
Expected: PASS

- [ ] **Step 6: Verify the falsifier by hand**

Comment out `const origin = await epochs.originMax(); epochs.raiseTo(origin);`, run `tests/browser/cross-tab.test.ts`, and confirm the first test goes red. Restore it. A test whose falsifier was never run is a test nobody has checked.

- [ ] **Step 7: Whole suite and conformance, then commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Run: `pnpm test:conformance`
Expected: `status: pass`, `failedFiles: 0`; conformance 73 passed / 12 skipped.

```bash
git add src/client.ts tests/browser/cross-tab.test.ts
git commit -m "feat(epochs): a commit in one tab reaches the barrier in another

applyBarrier folds the origin's published epoch into the target it was
already computing; the origin can only raise it, which is what lets the local
bump stay synchronous in the write path's finally. The write lock is released
only after this write's marker is taken, so no tab can query between the two."
```

---

### Task 7: Say what changed, and what still does not hold

**Files:**
- Modify: `README.md` — the Known Limitations section (`:485`) and the `openTimeout` / `TIMEOUT` rows that name the old failure

- [ ] **Step 1: Replace the two-clients entry**

The current entry begins *"**Two clients writing at once are not serialized…**"* and describes both regimes at length. Replace it with:

```markdown
- **Writes are serialized across every client and tab, reads are not.** A write, a
  write transaction, and each batch of a `bulkWrite` take one origin-wide lock per
  database, so a second writer waits rather than failing — in this tab or another,
  on every VFS and every browser. **Pass a `signal` if you would rather fail than
  wait**; the wait is otherwise unbounded and first-come-first-served. A write
  transaction holds that lock for the whole of its callback, so a transaction that
  never returns blocks every other writer in the origin, not only its own client.
  **A `bulkWrite` still commits per batch and takes the lock per batch**, so another
  client's write can land between two of its batches; use `tx.bulkWrite` where you
  need all or nothing.
- **Reads still contend for the file where the browser gives you one access handle.**
  Serializing writers does not change which handle a VFS holds: where
  `readwrite-unsafe` is unavailable, another tab's reads still wait on the rotated
  exclusive handle.
```

- [ ] **Step 2: Replace the read-your-own-writes entry**

The current entry reads *"**Read-your-own-writes is guaranteed within a tab, not across tabs.**"* Replace with:

```markdown
- **Read-your-own-writes holds across tabs, except on `IDBMirrorVFS`.** A commit in
  any tab is visible to the others' next read. `IDBMirrorVFS` is the exception and
  cannot be fixed here: it mirrors the whole database in memory per worker and
  propagates commits over `BroadcastChannel` asynchronously, so a connection whose
  mirror has not received the broadcast has nothing fresher to read.
```

- [ ] **Step 3: Correct the two rows that name the old failure**

`openTimeout` (`:279`) and the `TIMEOUT` error row (`:428`) both say the most common cause is *"a database held under an exclusive lock by another tab"*. That is still true of `AccessHandlePoolVFS` and reduced mode, so leave the wording — but check it reads correctly beside the new entries and adjust only if it now contradicts them.

- [ ] **Step 4: Show the diff and stop**

Per the repository's convention, the README is edited iteratively and **not** committed pass by pass. Show what changed and wait — several round trips are normal, and committing after each one forces the user to brake.

- [ ] **Step 5: Commit once the user has approved the wording**

```bash
git add README.md
git commit -m "docs(readme): writers serialize origin-wide, readers still do not"
```

---

## Self-Review

**Spec coverage.** §3 namespace → Task 1. §4 write lock → Tasks 2, 3. §5 epoch registry → Tasks 4, 6. §6 testing → Tasks 3, 5, 6. §8 what is not promised → Task 7. §7 measurements are evidence, not work. §9's three open questions are deliberately unbuilt and stay in `mem:follow-ups`.

**Two gaps found and closed while writing this.**

1. The spec says the epoch marker is a lock but never names its **mode**. Exclusive would make two realms computing the same `n` block on each other; `shared` removes the question entirely, since nobody reads the lock — the name is the state. Tasks 2 and 4 use `shared`, and §5 of the spec needs that one line added.
2. The spec says `<n>` is parsed with `lastIndexOf(':')`. That is **wrong** where a normalized file contains a colon — `new URL('./a:b', 'file://').pathname` is `a:b`, so `bsq:epoch:opfs:a.db:extra:7` would be read as `a.db` at epoch 7. Task 4 requires the tail after the prefix to be all digits, and pins it with a test.

**Type consistency.** `namespaceFor(vfs)` returns `string` in Tasks 1, 4, 6. `epochsFor(vfs, file, locks)` is three-argument in Tasks 4 and 6. `Locks.hold(name, options?)` in Tasks 2, 3, 4. `publishing: Promise<unknown>` is declared in Task 3 and assigned in Task 6 — the one deliberate forward reference, and Task 3 states it.

**Ordering constraint.** Task 3 must precede Task 6: the write lock is what serializes the read-modify-write on the epoch, so `publish` cannot be correct before it exists.
