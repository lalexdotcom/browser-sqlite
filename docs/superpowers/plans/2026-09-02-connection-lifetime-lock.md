# Connection Lifetime Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `deleteDatabase` destroying data under a live connection, on every VFS.

**Architecture:** Every client holds `bsq:conn:<ns>:<file>` for its whole lifetime — `shared` normally, `exclusive` where `VFS_CAPABILITIES[vfs].exclusiveConnection` is declared, not at all on the memory VFS. `deleteDatabase` requests the same name exclusively with `ifAvailable` and refuses with a new `DATABASE_IN_USE` code when any client holds it. The `AccessHandlePoolVFS` guard shipped on 2026-09-01 stops being a special case and becomes the exclusive mode of this one lock.

**Tech Stack:** TypeScript, `navigator.locks`, wa-sqlite, rstest (unit project = Node, browser project = Playwright Chromium/Firefox), biome.

**Spec:** `docs/superpowers/specs/2026-09-02-connection-lifetime-lock-design.md`

## Invariants — break one and the feature is wrong

**Read this before every task. Each line names what goes wrong if it is broken.**

- **I1 · `deleteDatabase` never queues for a lock.** Both its acquisitions use `ifAvailable`. A client takes `bsq:conn` then `bsq:init`; the delete takes them in the opposite order. **That inversion is only harmless because neither delete request ever waits.** A blocking acquisition on either name reintroduces a deadlock cycle.
- **I2 · A client's `shared` request does NOT use `ifAvailable`; it waits.** The only thing it can queue behind is a delete holding the name exclusively, and waiting that out is correct. Making it fail fast would make a client constructed during a delete throw for no reason.
- **I3 · Only the exclusive mode defers worker startup.** The deferral exists because on Firefox a worker that opens OPFS handles while another client holds them crashes before the guard can fire. Extending it to shared mode would change the startup path for eight of nine VFS — the path GATE-1 and three abort defects were paid for. **The gate is `capability.exclusiveConnection`, not `connLockPromise !== undefined`.**
- **I4 · A client constructed mid-delete is safe because of `bsq:init`, not because of `bsq:conn`.** The delete holds `bsq:init` across `runDelete`, and a worker takes it — blocking — before `open_v2`. Do not remove `bsq:init` from either side thinking `bsq:conn` covers it. It does not: `bsq:conn` shared excludes nothing between clients, and `bsq:init` is released the moment an open finishes.
- **I5 · The same lock refusing gives the same code everywhere.** `bsq:conn` refused is `DATABASE_IN_USE`, in the client and in the delete. `bsq:init` refused stays `BUSY`. A caller branches on `code`.
- **I6 · Memory VFS take no connection lock**, and `deleteDatabase` already returns early for `layout === 'memory'`. Two clients there are two independent databases with nothing to exclude, and a lock would be an origin round trip charged to the VFS chosen for speed.
- **I7 · Falsifiability is verified by experiment, never by argument.** Delete the line, observe red, restore, observe green, report both. Five reasoned falsifiability claims in this repository have turned out false when actually tested, and one of them was in this branch's own previous plan.
- **I8 · No test may depend on a wall-clock race.** This branch lost a full cycle to a test whose cleanup raced a timer under load. Wait on a condition or an observable state, never on a delay.

## Global Constraints

- **Serena's symbolic tools are primary for code.** `get_symbols_overview` / `find_symbol` to read, `replace_symbol_body` / `replace_content` to edit. Built-in Read/Edit only for `.md` and config. Never `rename_symbol` in the same session as a `replace_symbol_body` on the same file.
- **Every commit must land green.** The pre-commit hook runs the whole suite and refuses a red tree, so a failing test and the code that satisfies it belong to the **same** task.
- **Run `pnpm check` and `pnpm exec tsc --noEmit` after every modification.**
- **Both engines, always:** `pnpm exec rstest --project browser <file>` and the same with `TEST_BROWSER=firefox` prefixed. Firefox is a CI gate and takes different code paths.
- **A test report is green only when `status: pass` AND `failedFiles: 0`** — the per-test counters alone hide an unhandled rejection escaping outside any test.
- Baseline to compare against: **516 tests, 0 failed files**, conformance 73 passed / 12 skipped, biome 13 warnings.

---

### Task 1: `DATABASE_IN_USE`, and the guard that should already use it

**Files:**
- Modify: `src/errors.ts` (the `SQLiteErrorCode` union)
- Modify: `src/client.ts` (the connection-guard throw, around `:625`)
- Test: `tests/unit/errors.test.ts`, `tests/browser/exclusive-connection.test.ts`, `tests/browser/lifecycle.test.ts`

**Interfaces:**
- Produces: `'DATABASE_IN_USE'` as a member of `SQLiteErrorCode`. Later tasks throw it from `src/delete.ts`.

**Invariants:** **I5** — the client guard fires when `bsq:conn` is refused, so by I5 it must report `DATABASE_IN_USE`, not `BUSY`. It shipped as `BUSY` on 2026-09-01, before the code existed. Nothing is released, so this is not a breaking change to any consumer.

- [ ] **Step 1: Add the code**

In `src/errors.ts`, add to the `SQLiteErrorCode` union, after `'BUSY'`:

```typescript
  | 'DATABASE_IN_USE'
```

and extend the doc comment above `sqliteCode` — no, leave that alone. Instead document the new member where the union is declared, in the block comment at the top of the file, by appending one sentence:

```
 * `DATABASE_IN_USE` is this library's own: a database that a live client holds,
 * as opposed to `BUSY`, which covers a transient conflict worth retrying.
```

- [ ] **Step 2: Switch the client guard to it**

In `src/client.ts`, the throw inside `acquireInstrumented`'s connection guard currently reads `'BUSY'`. Replace only the code argument:

```typescript
        throw new SQLiteError(
          'DATABASE_IN_USE',
          `${vfs} supports one connection at a time across the whole origin. ` +
            `Another tab or client is already connected to '${dbFile}'. ` +
            `Close that client to open a new one here.`,
        );
```

- [ ] **Step 3: Update the two browser tests that assert the old code**

`tests/browser/exclusive-connection.test.ts` and `tests/browser/lifecycle.test.ts` each assert `BUSY` for a second `AccessHandlePoolVFS` client. Change those assertions to `DATABASE_IN_USE`. Change nothing else about them — they still pin that a second client fails promptly and legibly.

- [ ] **Step 4: Add a unit test**

In `tests/unit/errors.test.ts`, following the shape of the tests already there:

```typescript
it('carries DATABASE_IN_USE on both code and name', () => {
  const error = new SQLiteError('DATABASE_IN_USE', 'held elsewhere');
  expect(error.code).toBe('DATABASE_IN_USE');
  expect(error.name).toBe('DATABASE_IN_USE');
  expect(error.sqliteCode).toBeUndefined();
});
```

- [ ] **Step 5: Run and commit**

Run: `pnpm exec rstest --project unit tests/unit/errors.test.ts`, then the two browser files on **both engines**, then `pnpm check && pnpm exec tsc --noEmit && pnpm test`.
Expected: `status: pass`, `failedFiles: 0`.

```bash
git add src/errors.ts src/client.ts tests/unit/errors.test.ts tests/browser/exclusive-connection.test.ts tests/browser/lifecycle.test.ts
git commit -m "feat(errors): DATABASE_IN_USE, distinct from BUSY

A database a live client holds and a transient conflict worth retrying have
different remedies, so they get different codes. The connection guard shipped
as BUSY before this code existed."
```

---

### Task 2: every client holds the connection lock

**Files:**
- Modify: `src/client.ts` (`connLockPromise` around `:503`, the deferred-spawn gate around `:1109`)
- Test: `tests/browser/exclusive-connection.test.ts`

**Interfaces:**
- Consumes: `connectionLockName(vfs, file)` and `Locks.hold(name, { mode?, signal?, ifAvailable? })` from `src/locks.ts`; `sharesStorage(vfs)`; `VFS_CAPABILITIES[vfs].exclusiveConnection`.
- Produces: for every VFS where `sharesStorage(vfs)` is true, a client holds `bsq:conn:<ns>:<file>` from construction to `close()`. Task 3 relies on this.

**Invariants:** **I2**, **I3**, **I6**. Read all three before editing — I3 in particular names a gate that is currently written the wrong way for this change.

- [ ] **Step 1: Write the failing tests**

Add to `tests/browser/exclusive-connection.test.ts`:

```typescript
it('lets two clients coexist on a shared-mode VFS, and both hold the lock', async () => {
  const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
  const options = { vfs: 'OPFSAdaptiveVFS' as const, poolSize: 1 };
  const a = createSQLiteClient(dbName, options);
  const b = createSQLiteClient(dbName, options);
  onTestFinished(async () => {
    for (const client of [a, b]) {
      try {
        await client.close();
      } catch {
        /* a failed client has nothing to close */
      }
    }
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dbName, { recursive: true });
    } catch {
      /* the entry may not exist if the test failed before creation */
    }
  });

  await a.write('CREATE TABLE t (n)');
  await b.write('INSERT INTO t VALUES (1)');

  // Falsifiable: give the shared branch `ifAvailable: true` and one of these
  // two clients starts throwing DATABASE_IN_USE.
  const held = (await navigator.locks.query()).held ?? [];
  const name = `bsq:conn:opfs:${dbName}`;
  expect(held.filter((lock) => lock.name === name).length).toBe(2);
  expect(held.filter((lock) => lock.name === name).every((l) => l.mode === 'shared')).toBe(true);
});

it('takes no connection lock on the memory VFS', async () => {
  const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
  const db = createSQLiteClient(dbName, { vfs: 'MemoryVFS', poolSize: 1 });
  onTestFinished(async () => {
    try {
      await db.close();
    } catch {
      /* a failed client has nothing to close */
    }
  });
  await db.write('CREATE TABLE t (n)');

  const held = (await navigator.locks.query()).held ?? [];
  expect(held.some((lock) => (lock.name ?? '').startsWith('bsq:conn:'))).toBe(false);
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm exec rstest --project browser tests/browser/exclusive-connection.test.ts`
Expected: the first test FAILS with a count of 0 — only `AccessHandlePoolVFS` takes the lock today.

- [ ] **Step 3: Generalise the acquisition**

Replace the `connLockPromise` declaration in `src/client.ts`, keeping the `connRelease` declaration above it:

```typescript
  /**
   * Settles as soon as the Web Locks API responds to the connection request.
   *
   * The mode is the VFS's: `exclusive` where `exclusiveConnection` is declared,
   * so a second client is refused; `shared` everywhere else, so any number of
   * clients coexist while `deleteDatabase` — which asks for the same name
   * exclusively — is still kept out.
   *
   * **`ifAvailable` is exclusive-only, and the asymmetry is deliberate.** A
   * second client on an exclusive VFS must fail fast rather than wait for the
   * first one to close. A shared client must WAIT: the only thing it can queue
   * behind is a delete holding this name, and waiting that delete out is the
   * correct behaviour. Its workers are separately held at `open_v2` by
   * `bsq:init`, which the delete holds too.
   *
   * `undefined` on the memory VFS, where two clients are two databases.
   */
  const connLockPromise: Promise<void> | undefined = sharesStorage(vfs)
    ? (
        locks.hold(connectionLockName(vfs, dbFile), {
          mode: capability.exclusiveConnection ? 'exclusive' : 'shared',
          ...(capability.exclusiveConnection ? { ifAvailable: true } : {}),
        }) as Promise<(() => void) | undefined>
      ).then((release) => {
        connRelease = release;
      })
    : undefined;
```

The cast is needed because the two option shapes select different `hold` overloads and a ternary cannot resolve to one of them. If you find a formulation that types without a cast, prefer it and say so in your report.

- [ ] **Step 4: Keep the deferral exclusive-only**

The deferred-spawn block currently gates on `connLockPromise !== undefined`, which after step 3 is true for eight more VFS. Change the outer condition to gate on the declaration instead:

```typescript
  if (capability.exclusiveConnection && connLockPromise !== undefined) {
```

Leave the block's body, including its `else if (!closing)` guard, exactly as it is — that guard fixed a Critical defect on 2026-09-01 and its falsifiability comment records why.

- [ ] **Step 5: Run both new tests, then everything**

Run: `pnpm exec rstest --project browser tests/browser/exclusive-connection.test.ts` and the same with `TEST_BROWSER=firefox`.
Expected: PASS on both.

Then verify I3 by experiment: temporarily change the step-4 condition back to `connLockPromise !== undefined`, run the whole browser project on **Firefox**, and report whether anything changes. Restore it either way. This is the check that the startup path was not silently altered for eight VFS.

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: `status: pass`, `failedFiles: 0`.

- [ ] **Step 6: Commit**

```bash
git add src/client.ts tests/browser/exclusive-connection.test.ts
git commit -m "feat(client): every client holds the connection lock for its lifetime

Shared where the VFS allows several connections, exclusive where it does not,
absent on the memory VFS. ifAvailable stays exclusive-only: a shared client
must wait out a delete rather than fail, and only the exclusive mode defers
worker startup."
```

---

### Task 3: `deleteDatabase` refuses under a live client

**Files:**
- Modify: `src/delete.ts` (the lock section, around `:81-94`)
- Test: `tests/browser/delete.test.ts`

**Interfaces:**
- Consumes: the lifetime lock from Task 2, `DATABASE_IN_USE` from Task 1, `connectionLockName` from `src/locks.ts`.
- Produces: `deleteDatabase` throwing `SQLiteError` with `code: 'DATABASE_IN_USE'` when a client is open, and `code: 'BUSY'` when an open or another delete is in flight.

**Invariants:** **I1** (both acquisitions `ifAvailable` — this is where a deadlock would be introduced), **I5**, **I6**, **I7**.

- [ ] **Step 1: Write the failing tests**

Add to `tests/browser/delete.test.ts`. The three VFS named here are the ones **measured to delete a live database** on 2026-09-02, so each of these currently resolves and each will go red without the fix:

```typescript
describe('deleteDatabase under a live connection', () => {
  const liveClient = (vfs: 'OPFSAnyContextVFS' | 'IDBBatchAtomicVFS' | 'IDBMirrorVFS' | 'OPFSAdaptiveVFS') => {
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(dbName, { vfs, poolSize: 1 });
    onTestFinished(async () => {
      try {
        await db.close();
      } catch {
        /* a failed client has nothing to close */
      }
      try {
        await deleteDatabase(dbName, { vfs });
      } catch {
        /* best-effort cleanup */
      }
    });
    return { db, dbName };
  };

  for (const vfs of [
    'OPFSAnyContextVFS',
    'IDBBatchAtomicVFS',
    'IDBMirrorVFS',
    'OPFSAdaptiveVFS',
  ] as const) {
    // Falsifiable: remove the connection-lock acquisition in delete.ts and the
    // first three go red by resolving (they delete the database today), while
    // OPFSAdaptiveVFS goes red with WORKER_CRASHED instead of DATABASE_IN_USE.
    it(`refuses with DATABASE_IN_USE on ${vfs}`, async () => {
      const { db, dbName } = liveClient(vfs);
      await db.write('CREATE TABLE t (n)');
      await db.write('INSERT INTO t VALUES (1)');

      const error = await deleteDatabase(dbName, { vfs }).then(
        () => undefined,
        (e) => e,
      );
      expect(error).toBeInstanceOf(SQLiteError);
      expect((error as SQLiteError).code).toBe('DATABASE_IN_USE');

      // The live client is untouched — this is the whole point.
      const rows = await db.read<{ n: number }>('SELECT n FROM t');
      expect(rows.map((r) => r.n)).toEqual([1]);
    });

    it(`deletes on ${vfs} once the client has closed`, async () => {
      const { db, dbName } = liveClient(vfs);
      await db.write('CREATE TABLE t (n)');
      await db.close();
      await expect(deleteDatabase(dbName, { vfs })).resolves.toBeUndefined();
    });
  }

  it('still deletes on the memory VFS with a client open — nothing is shared there', async () => {
    const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(dbName, { vfs: 'MemoryVFS', poolSize: 1 });
    onTestFinished(async () => {
      try {
        await db.close();
      } catch {
        /* a failed client has nothing to close */
      }
    });
    await db.write('CREATE TABLE t (n)');
    await expect(
      deleteDatabase(dbName, { vfs: 'MemoryVFS' }),
    ).resolves.toBeUndefined();
  });
});
```

Import `createSQLiteClient`, `deleteDatabase`, `SQLiteError` and `onTestFinished` if that file does not already.

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm exec rstest --project browser tests/browser/delete.test.ts`
Expected: the four `refuses with DATABASE_IN_USE` tests FAIL — three by resolving, one with `WORKER_CRASHED`.

- [ ] **Step 3: Take the connection lock in `deleteDatabase`**

In `src/delete.ts`, replace the `tryWithLock` block and the `BUSY` throw that follows it:

```typescript
  const locks = createLocks();

  // The connection lock first: a live client is both the likelier refusal and
  // the more actionable one, and it gets its own code so a caller can tell
  // "close it, possibly in another tab" from "retry in a moment".
  //
  // `ifAvailable` on BOTH acquisitions is load-bearing. A client takes
  // bsq:conn and then bsq:init; this function takes them the other way round.
  // A request that never queues cannot deadlock — a blocking acquisition on
  // either name reintroduces the cycle.
  const connRelease = await locks.hold(connectionLockName(vfs, dbFile), {
    mode: 'exclusive',
    ifAvailable: true,
  });

  if (connRelease === undefined) {
    throw new SQLiteError(
      'DATABASE_IN_USE',
      `${dbFile} is open. Close every client on it, in this tab and in any other, then delete it.`,
    );
  }

  try {
    const ran = await locks.tryWithLock(initLockName(vfs, dbFile), () =>
      runDelete({ file: dbFile, vfs, build, wasm }),
    );

    if (!ran) {
      throw new SQLiteError(
        'BUSY',
        `${dbFile} is being opened or deleted elsewhere. Try again in a moment.`,
      );
    }
  } finally {
    connRelease();
  }
```

Import `connectionLockName` alongside the existing `createLocks, initLockName` import.

- [ ] **Step 4: Run the tests on both engines**

Run: `pnpm exec rstest --project browser tests/browser/delete.test.ts`, then the same with `TEST_BROWSER=firefox`.
Expected: PASS on both.

- [ ] **Step 5: Verify falsifiability by experiment (I7)**

Comment out the `connRelease` acquisition and its `undefined` check, run `tests/browser/delete.test.ts`, confirm the four refusal tests go red, restore, confirm green. Report both observations — a claim that they *would* fail is worth nothing here.

- [ ] **Step 6: Whole suite and conformance, then commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test && pnpm test:conformance`
Expected: `status: pass`, `failedFiles: 0`; conformance 73 passed / 12 skipped.

```bash
git add src/delete.ts tests/browser/delete.test.ts
git commit -m "fix(delete): refuse to delete a database a client still holds

Three VFS deleted it and the data was gone — IDBMirrorVFS silently, the live
client still serving correct rows from its mirror while a fresh client found
nothing. The four that survived survived by accident, on OPFS handle
exclusivity this library never arranged."
```

---

### Task 4: the construction-versus-delete window

**Files:**
- Test: `tests/browser/delete.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3. Adds no production code.

**Invariants:** **I8** — no wall-clock dependency.

This task encodes the one claim the spec could not settle by reading: whether a delete can slip between a client's lock **request** and its **grant**. The specification says the queue is FIFO per name, so a request issued first is processed first and the delete's `ifAvailable` meets a pending request and is refused. **That is a reading, and this repository has paid five times for readings.** If the test turns out non-deterministic, that is a finding to report, not a test to loosen.

- [ ] **Step 1: Write the test**

```typescript
it('refuses a delete issued in the same task as a client construction', async () => {
  const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
  const vfs = 'OPFSAdaptiveVFS' as const;

  // Both requests are issued in this one task, client first. Per the Web Locks
  // specification the queue is FIFO per name, so the client's shared request is
  // processed first and the delete's ifAvailable request meets it pending.
  const db = createSQLiteClient(dbName, { vfs, poolSize: 1 });
  const attempt = deleteDatabase(dbName, { vfs }).then(
    () => undefined,
    (e) => e,
  );

  onTestFinished(async () => {
    try {
      await db.close();
    } catch {
      /* a failed client has nothing to close */
    }
    try {
      await deleteDatabase(dbName, { vfs });
    } catch {
      /* best-effort cleanup */
    }
  });

  const error = await attempt;
  expect(error).toBeInstanceOf(SQLiteError);
  expect((error as SQLiteError).code).toBe('DATABASE_IN_USE');

  // And the client that won the race is usable.
  await db.write('CREATE TABLE t (n)');
  const rows = await db.read('SELECT n FROM t');
  expect(rows).toEqual([]);
});
```

- [ ] **Step 2: Run it twenty times per engine**

Run it repeatedly — at least twenty runs on Chromium and twenty on Firefox — and count the outcomes. A single green run proves nothing about a race.

Run: `pnpm exec rstest --project browser tests/browser/delete.test.ts` (and with `TEST_BROWSER=firefox`), repeated.

- [ ] **Step 3: Report what you observed, and stop if it varies**

If every run refuses the delete on both engines, the FIFO reading is confirmed and the test stays. **If any run lets the delete through, do not weaken the test** — report the count per engine and stop. That result means a delete can slip past a client under construction, which is a finding for the spec's author, not something to paper over.

- [ ] **Step 4: Commit, only if deterministic**

```bash
git add tests/browser/delete.test.ts
git commit -m "test(delete): pin that a delete cannot slip past a client under construction

The spec could only reason about this from the Web Locks queue being FIFO per
name. This is the measurement, at twenty runs per engine."
```

---

### Task 5: say what changed

**Files:**
- Modify: `README.md` — the Known Limitations entry about deletion, and the error-code table
- Modify: `CHANGELOG.md` — the `Unreleased` section

**This task is controller work with the user, not a dispatch.** The repository's convention is that the README is edited iteratively and not committed pass by pass, so the edit is shown and the commit waits for approval.

- [ ] **Step 1: Make the Known Limitations entry true**

The current entry claims `deleteDatabase` "reports `BUSY` rather than deleting under a live connection", which was false on three VFS. Replace it with what now holds: a database any client still holds cannot be deleted, on every VFS; the refusal is `DATABASE_IN_USE`, immediate; closing every client on it — in this tab and any other — is what releases it; and a client the application has forgotten but not closed keeps blocking, deliberately, until its tab goes.

- [ ] **Step 2: Add `DATABASE_IN_USE` to the error-code table**

The table lists the codes a consumer can meet. Add a row saying it means a live client holds the database and naming the remedy, and adjust the `BUSY` row so the two read as a pair rather than as overlapping.

- [ ] **Step 3: Add the CHANGELOG entries**

Under `Unreleased`: a **Fixed** entry for the data loss, naming the three VFS and that `IDBMirrorVFS` lost data silently; and a **Breaking** entry for the error-code change, since a second `AccessHandlePoolVFS` client and every refused delete now report `DATABASE_IN_USE` where they reported `BUSY`, `WORKER_CRASHED` or nothing at all.

- [ ] **Step 4: Show the diff and stop**

Show what changed and wait. Several round trips are normal; committing after each forces the user to brake.

---

## Self-Review

**Spec coverage.** §2 mechanism → Tasks 2 and 3. D1 (abandoned client blocks) → falls out of Task 2, and is stated in Task 5's README text. D2 (`ifAvailable` both sides) → Task 3, invariant I1. D3 (no deferral for shared) → Task 2 step 4, invariant I3, verified by experiment in step 5. D4 (fail fast) → Task 3. D5 (two codes) → Task 1. §6 testing → Tasks 2, 3, 4. §7's remaining question → Task 4. §8 is deferred by decision.

**One gap found and closed while writing this:** the spec never said the *client's* guard should switch from `BUSY` to `DATABASE_IN_USE`. It must, by D5's own logic — the same lock refusing has to give the same code — so Task 1 does it.

**Type consistency.** `connectionLockName(vfs, file)` and `sharesStorage(vfs)` are used as they exist in `src/locks.ts`. `Locks.hold`'s `ifAvailable` overload returns `Promise<(() => void) | undefined>`, which is why Task 2 casts and Task 3 checks for `undefined`. `capability` is already bound in both `client.ts` and `delete.ts`.

**Ordering constraint.** Task 3 must follow Task 2: the delete's refusal is only meaningful once clients actually hold the lock. Task 1 must precede both — they throw the code it adds.
