# `deleteDatabase` Reports Not Found — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `deleteDatabase` throws `DATABASE_NOT_FOUND` instead of resolving silently when the database is not there.

**Architecture:** The delete worker already builds a VFS instance because `jDelete` is the only correct removal. Before deleting, it opens the database with `SQLITE_OPEN_READWRITE` and **without** `SQLITE_OPEN_CREATE`; absent yields `SQLITE_CANTOPEN` on all seven persistent VFS, measured on both engines. The worker reports the absence over a new wire message and `deleteDatabase` turns it into the error.

**Tech Stack:** TypeScript, wa-sqlite, `navigator.locks`, rstest (unit = Node, browser = Playwright Chromium/Firefox), biome.

**Spec:** `docs/superpowers/specs/2026-09-02-delete-reports-not-found-design.md`

**Measurement this plan rests on:** `.superpowers/sdd/exists-detection-report.md`, and `mem:measurements` under EXISTS-PROBE. **Read the report for the exact shape of the error `open_v2` raises when the file is absent** — it was observed, not guessed, and guessing it is the one way to waste a round here.

## Invariants — break one and the feature is wrong

- **I1 · The guard fires on `SQLITE_CANTOPEN` and on nothing else.** A corrupt database reaches the header read and returns `SQLITE_CORRUPT`; a WASM or VFS start-up failure throws before `open_v2` is reached. Both must keep the errors they raise today. **A `catch` that treats any failure as "not found" turns every start-up bug into a wrong answer**, and it is the obvious way to write this.
- **I2 · `jAccess` must not be used for this.** It was measured and rejected: reliable on four VFS of seven, and on `IDBMirrorVFS` deliberately unimplemented for main database files, so it would be a field whose contract excludes our use. The existing `jAccess` call in `deleteDatabaseFiles` is a **commit barrier for `idb-store`, not an existence check** — its return value is deliberately discarded and its comment says so. Do not repurpose it, and do not delete it.
- **I3 · The probe closes what it opens, before any deletion.** On `AccessHandlePoolVFS` `jClose` leaves the handle associated with the VFS *instance*, which is the same instance that then runs `jDelete` — measured to consume no slot. Leaving the database open would hold what the delete then trips over.
- **I4 · The probe runs on the VFS instance already built**, not on a second one. Re-instantiating doubles start-up and risks the six-slot pool.
- **I5 · Refusal order is `DATABASE_IN_USE`, then `DATABASE_NOT_FOUND`, then `BUSY`.** The first is decided on the main thread before a worker exists, so it necessarily comes first; `BUSY` is last because it means the check itself could not run.
- **I6 · The memory VFS are untouched.** `deleteDatabase` returns early for `layout: 'memory'` before any worker, so nothing there can be found or not found.
- **I7 · Falsifiability by experiment, never by argument.** Six reasoned claims on this branch, five false when finally tested.
- **I8 · No wall-clock dependency in any test.** This branch lost a full cycle to one.

## Global Constraints

- **Serena's symbolic tools are primary for code.** `get_symbols_overview` / `find_symbol` to read, `replace_symbol_body` / `replace_content` to edit. Built-in Read/Edit only for `.md` and config. Never `rename_symbol` in the same session as a `replace_symbol_body` on the same file.
- **Every commit must land green.** The pre-commit hook runs the whole suite and refuses a red tree — a failing test and the code that satisfies it belong to the **same** task.
- **Run `pnpm check` and `pnpm exec tsc --noEmit` after every modification.**
- **Both engines, always:** `pnpm exec rstest --project browser <file>` and the same with `TEST_BROWSER=firefox` prefixed.
- **A test report is green only when `status: pass` AND `failedFiles: 0`.**
- Baseline: **529 tests, 0 failed files**, conformance 73 passed / 12 skipped.

---

### Task 1: the error code

**Files:**
- Modify: `src/errors.ts`
- Test: `tests/unit/errors.test.ts`

**Interfaces:**
- Produces: `'DATABASE_NOT_FOUND'` as a member of `SQLiteErrorCode`. Task 2 throws it.

- [ ] **Step 1: Add the code**

In `src/errors.ts`, add to the `SQLiteErrorCode` union immediately after `'DATABASE_IN_USE'`:

```typescript
  | 'DATABASE_NOT_FOUND'
```

Append one sentence to the block comment at the top of the file — the one beginning "Every failure this library raises on its own behalf" — beside the sentence already there about `DATABASE_IN_USE`:

```
 * `DATABASE_NOT_FOUND` is raised only by `deleteDatabase`: there is nothing at
 * that name to delete. `createSQLiteClient` creates what is absent, so it has
 * no such case.
```

- [ ] **Step 2: Add the unit test**

In `tests/unit/errors.test.ts`, beside the equivalent test for `DATABASE_IN_USE`:

```typescript
it('carries DATABASE_NOT_FOUND on both code and name', () => {
  const error = new SQLiteError('DATABASE_NOT_FOUND', 'nothing to delete');
  expect(error.code).toBe('DATABASE_NOT_FOUND');
  expect(error.name).toBe('DATABASE_NOT_FOUND');
  expect(error.sqliteCode).toBeUndefined();
});
```

- [ ] **Step 3: Run and commit**

Run: `pnpm exec rstest --project unit tests/unit/errors.test.ts`, then `pnpm check && pnpm exec tsc --noEmit && pnpm test`.
Expected: `status: pass`, `failedFiles: 0`.

```bash
git add src/errors.ts tests/unit/errors.test.ts
git commit -m "feat(errors): DATABASE_NOT_FOUND, raised only by deleteDatabase

createSQLiteClient creates a database that is absent, so the case exists on
one function only."
```

---

### Task 2: the probe, the wire message, and the refusal

**Files:**
- Modify: `src/types.ts` (the worker→client message union)
- Modify: `src/worker/worker.ts` (`deleteDatabaseFiles`, and the top-level `delete` handler that calls it)
- Modify: `src/delete.ts` (`runDelete`'s `onmessage`)
- Test: `tests/browser/delete.test.ts`

**Interfaces:**
- Consumes: `'DATABASE_NOT_FOUND'` from Task 1.
- Produces: `deleteDatabase` rejecting with `SQLiteError` code `DATABASE_NOT_FOUND` when nothing is there.

**Invariants:** **I1**, **I2**, **I3**, **I4**, **I6**, **I7**. I1 and I2 are the two that will be got wrong.

**Read `.superpowers/sdd/exists-detection-report.md` before writing the probe.** It carries the observed shape of what `open_v2` raises when the file is absent — the property name, the value, and how it differs from a corrupt database. Use what it observed. If the report is unclear on a point, write a throwaway probe to settle it rather than guessing; do not infer from the wa-sqlite sources alone.

- [ ] **Step 1: Write the failing tests**

Replace the existing `it('is idempotent', …)` in `tests/browser/delete.test.ts` — the contract it pins is being removed on purpose — and add the block below. Keep every other test in the file.

```typescript
describe('deleteDatabase on a database that is not there', () => {
  for (const vfs of [
    'OPFSAdaptiveVFS',
    'OPFSAnyContextVFS',
    'OPFSCoopSyncVFS',
    'OPFSWriteAheadVFS',
    'AccessHandlePoolVFS',
    'IDBBatchAtomicVFS',
    'IDBMirrorVFS',
  ] as const) {
    // Falsifiable: remove the probe in deleteDatabaseFiles and every one of
    // these resolves instead of throwing — that is what the code does today.
    it(`throws DATABASE_NOT_FOUND on ${vfs} when nothing was created`, async () => {
      const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
      const error = await deleteDatabase(dbName, { vfs }).then(
        () => undefined,
        (e) => e,
      );
      expect(error).toBeInstanceOf(SQLiteError);
      expect((error as SQLiteError).code).toBe('DATABASE_NOT_FOUND');
    });

    it(`deletes on ${vfs}, then reports the second attempt`, async () => {
      const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
      const db = createSQLiteClient(dbName, { vfs, poolSize: 1 });
      await db.write('CREATE TABLE t (n)');
      await db.close();

      await expect(deleteDatabase(dbName, { vfs })).resolves.toBeUndefined();

      const error = await deleteDatabase(dbName, { vfs }).then(
        () => undefined,
        (e) => e,
      );
      expect((error as SQLiteError).code).toBe('DATABASE_NOT_FOUND');
    });
  }

  it('still resolves on the memory VFS, which persists nothing', async () => {
    await expect(
      deleteDatabase(`browser-sqlite-test-${crypto.randomUUID()}`, {
        vfs: 'MemoryVFS',
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm exec rstest --project browser tests/browser/delete.test.ts`
Expected: every `throws DATABASE_NOT_FOUND` test FAILS by resolving, and the second half of each `then reports the second attempt` test fails the same way.

- [ ] **Step 3: Add the wire message**

In `src/types.ts`, add a member to the worker→client message union beside `{ type: 'deleted' }`:

```typescript
  | { type: 'not-found' }
```

Document it where it is declared: the delete worker found nothing at that name, and `deleteDatabase` turns it into `DATABASE_NOT_FOUND`.

- [ ] **Step 4: Probe before deleting**

In `src/worker/worker.ts`, `deleteDatabaseFiles` currently creates `vfsInstance` and goes straight into its `try` with the `jDelete` loop. Insert the probe between the two, and give the function a `Promise<boolean>` return — `false` when nothing was found.

The probe must: build the SQLite facade over the `module` already loaded (`SQLite.Factory(module)`), register the **existing** `vfsInstance` (I4), attempt `open_v2` on `file` with read-write and **no create** flag, close the handle at once on success (I3), and treat **only** `SQLITE_CANTOPEN` as "absent" (I1) — anything else rethrows unchanged.

Import the flag constant from the same wa-sqlite constants module `SQLITE_ROW` already comes from at the top of this file; do not hardcode a number.

When the probe says absent, close the VFS instance and return `false` **without running any `jDelete`** and without the `opfs-path` second pass — there is nothing to remove, and running the removal anyway would make the `opfs-path` branch delete files the probe just said do not exist.

The existing `jAccess` call further down stays exactly where it is (I2): it is the `idb-store` commit barrier, its return value is discarded, and its comment explains why removing it reintroduces a data-survives-deletion defect.

- [ ] **Step 5: Report it**

In `src/worker/worker.ts`, the top-level `delete` handler replies `{ type: 'deleted' }` today. Make it reply `{ type: 'not-found' }` when `deleteDatabaseFiles` returned `false`, and `{ type: 'deleted' }` otherwise.

In `src/delete.ts`, `runDelete`'s `onmessage` handles `data.type === 'deleted'`. Add the sibling branch, settling with:

```typescript
new SQLiteError(
  'DATABASE_NOT_FOUND',
  `There is no database named '${message.file}' for ${message.vfs} to delete.`,
)
```

Keep the existing `deleted` and `error` branches unchanged.

- [ ] **Step 6: Run on both engines**

Run: `pnpm exec rstest --project browser tests/browser/delete.test.ts`, then the same with `TEST_BROWSER=firefox`.
Expected: PASS on both.

- [ ] **Step 7: Verify falsifiability by experiment (I7)**

Comment out the probe so `deleteDatabaseFiles` always returns `true`, run the file, confirm the seven `throws DATABASE_NOT_FOUND` tests go red **by resolving**. Restore, confirm green. Report both observations.

Then check I1 by reading rather than by assertion: state in your report what your `catch` does with an error that is **not** `SQLITE_CANTOPEN`, and confirm by inspection that a VFS start-up failure still surfaces as it did before.

- [ ] **Step 8: Whole suite and conformance, then commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test && pnpm test:conformance`
Expected: `status: pass`, `failedFiles: 0`; conformance 73 passed / 12 skipped.

```bash
git add src/types.ts src/worker/worker.ts src/delete.ts tests/browser/delete.test.ts
git commit -m "feat(delete): report a database that is not there

deleteDatabase resolved whether or not it deleted anything, and the silent
no-op is what deleting through the wrong VFS looks like. The delete worker now
opens without SQLITE_OPEN_CREATE first — uniform across all seven persistent
VFS, measured on both engines — and reports absence instead of success.

Idempotence goes with it: a second delete of the same name now throws."
```

---

### Task 3: say what changed

**Files:**
- Modify: `README.md` — the `deleteDatabase` section and the error-code table
- Modify: `CHANGELOG.md` — the `Unreleased` section

**This task is controller work with the user, not a dispatch.** The README is edited iteratively and not committed pass by pass.

- [ ] **Step 1: Remove the line that is now false**

`README.md`'s `deleteDatabase` section says "Deleting a database that does not exist is not an error." That is exactly what changed. Replace it with the new behaviour, in one line — the section already carries a one-line note about the four OPFS VFS sharing a file, and this should match that register.

- [ ] **Step 2: Add the code to the error table**

A row for `DATABASE_NOT_FOUND` saying it is raised by `deleteDatabase` alone, that nothing exists at that name, and that the most likely cause is the wrong `vfs`.

- [ ] **Step 3: Add the CHANGELOG entries**

Under `Unreleased`: a **Breaking** entry — `deleteDatabase` was idempotent and is not any more; a caller that deletes speculatively must catch. Say why the silence was worth removing: it is indistinguishable from deleting through the wrong VFS.

- [ ] **Step 4: Show the diff and stop.**

---

## Self-Review

**Spec coverage.** §2's signal → Task 2 steps 4–5. §3 D1 (idempotence goes) → Task 2 step 1 and Task 3. D2 (must not swallow) → I1, verified in step 7. D3 (same worker, same instance) → I4, step 4. D4 (refusal order) → falls out of where each check sits: `DATABASE_IN_USE` on the main thread before the worker spawns, `DATABASE_NOT_FOUND` in the worker, `BUSY` when `tryWithLock` refuses. §5 testing → Task 2 steps 1, 6, 7.

**One thing deliberately not planned:** no test constructs a corrupt database to prove `SQLITE_CORRUPT` is not swallowed. The spec asks for one "if a case can be constructed", and it is not obvious that one can be, portably, across seven VFS. Step 7 substitutes an inspection with a written statement — weaker, and named as weaker rather than dressed up.

**Type consistency.** `deleteDatabaseFiles` gains `Promise<boolean>`; its only caller is the worker's top-level `delete` handler, changed in the same task. The wire member `{ type: 'not-found' }` is added in `types.ts` and consumed in `delete.ts`, both in Task 2.

**Ordering.** Task 1 before Task 2 — Task 2 throws the code Task 1 adds.
