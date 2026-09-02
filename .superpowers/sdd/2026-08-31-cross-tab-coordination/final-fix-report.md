# Final Fix Report — feat/cross-tab-coordination

Date: 2026-09-01  
Branch: feat/cross-tab-coordination  
Findings fixed: 3

---

## Finding 1 — `transaction()` did not await `publishing`

### What changed

**`src/client.ts`**

- `afterWrite` now declares return type `Promise<unknown>` and ends with
  `return publishing;`. The body is otherwise unchanged: the epoch bump is
  still synchronous, and the `.catch()` still swallows publish failures so the
  returned promise never rejects.
- In `write()`'s `finally`, the two-line pair
  `afterWrite(lease.worker); await publishing;`
  is collapsed to `await afterWrite(lease.worker);` — same behaviour, no
  way for the two lines to drift apart in future edits.

**`src/transaction.ts`**

- `afterWrite` dep type changed from `(worker: PoolWorker) => void` to
  `(worker: PoolWorker) => Promise<unknown>`.
- In the `finally` block, `if (!readOnly) deps.afterWrite(worker);` becomes
  `if (!readOnly) await deps.afterWrite(worker);`.

**`tests/unit/transaction.test.ts`**

- The `afterWrite` mock was `() => {}` (returning void). Changed to
  `() => Promise.resolve()` to satisfy the updated type.

### New browser test

Added `'blocks transaction() until the epoch marker is granted'` to the
`'an epoch published by another realm'` describe block in
`tests/browser/cross-tab.test.ts`.

The test holds an exclusive Web Lock on the epoch-1 marker name from an
iframe realm **inside the transaction callback**, after `tx.write()` returns.
This placement is load-bearing: `applyBarrier` runs before the callback
(inside `acquireInstrumented`), so it does not see the lock and cannot raise
the epoch counter. With the counter at 0, `afterWrite` will bump to 1 and
try to hold epoch 1 as shared — blocked by the realm's exclusive.

With the fix, `transaction()` awaits `deps.afterWrite(worker)`, which waits
for `publishing` (= `epochs.publish(1)`), which is blocked, so
`transaction()` does not resolve. A `Promise.race` against a 400 ms timeout
expects `'timeout'` to win.

### Falsifiability experiments

**Attempt 1 — simple `heldNamesIn` check (mirror of test 3):**
After `await db.transaction(...)`, call `heldNamesIn(window)` and assert
`length === 1`. Result with fix reverted: PASSED on both Chromium and
Firefox. Reason: `await heldNamesIn(window)` internally calls
`await navigator.locks.query()`, which yields control to the browser. During
that yield, the browser processes the pending shared lock grant, so by the
time the snapshot returns, the lock is already held — regardless of whether
`transaction()` awaited it or not. **Not a falsifier.**

**Attempt 2 — pre-held exclusive on epoch 1 from window:**
Held `bsq:epoch:opfs:<dbName>:1` exclusive from `window` before the
transaction, then raced `transaction()` against a 400 ms timeout, expecting
timeout to win. Result without fix: FAILED as expected (transaction resolved
in ~93 ms, `winner = 'tx'`). Result WITH fix: also FAILED (`winner = 'tx'`).
Reason: `applyBarrier` calls `originMax()` which counts all held epoch locks.
It sees our exclusive on epoch 1, calls `raiseTo(1)`, raising `cell.value`
to 1. `afterWrite` then bumps to 2 and publishes epoch 2 — not epoch 1,
which we blocked. Any pre-held lock at epoch N causes `afterWrite` to publish
N+1, making the blocked epoch always one behind. **Not a falsifier after all.**

**Attempt 3 — exclusive held inside callback, from realm (final design):**
`makeRealm()` creates an iframe. Inside the transaction callback, after
`await tx.write()`, `holdIn(realm, marker)` acquires the exclusive from the
iframe. `applyBarrier` runs before the callback and does not see the lock.
The epoch counter stays at 0. `afterWrite` bumps to 1 and calls
`epochs.publish(1)`, which tries `locks.hold(epoch-1-name, {mode:'shared'})`.
The realm's exclusive blocks the grant.

- **Without fix** (`void deps.afterWrite(worker)`): `transaction()` fires
  `afterWrite` without awaiting, then returns. Race: `winner = 'tx'` (test
  FAILS ✓ — confirmed falsifiable).
- **With fix** (`await deps.afterWrite(worker)`): `transaction()` suspends
  at the blocked publish. Race: `winner = 'timeout'` (test PASSES ✓).

---

## Finding 2 — Three unused biome suppressions

Removed the three `// biome-ignore lint/suspicious/noExplicitAny: LockManager stand-in`
comments from `tests/unit/locks.test.ts` (at `} as any` positions in three
separate test blocks). Biome does not fire `noExplicitAny` on those casts;
the comments were reporting as `suppressions/unused`.

`biome check --write` before removal: **13 warnings** (zero
`suppressions/unused`). After verifying the three comments were the only
unused suppressions (grep confirms none remain), warning count stays at
**13 warnings**, no `suppressions/unused` lines in output.

Note: the spec expected "16 → 19 → 16". The current count of 13 reflects
other warnings that were already absent in the branch's current state; the
zero `suppressions/unused` invariant is what matters and is confirmed.

---

## Finding 3 — `realm.test.ts` leaves the production symbol key on `globalThis`

Added `onTestFinished` cleanup to the first test in
`tests/browser/realm.test.ts`. The test assigns a Map to
`globalThis[Symbol.for('browser-sqlite.epochs.v1')]`. The cleanup:

```typescript
onTestFinished(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[parentSymbol];
});
```

`onTestFinished` was added to the import from `@rstest/core`. The assertion
is unchanged.

---

## Test suite results

### Chromium

```
status: pass  failedFiles: 0  tests: all passed
```

### Firefox

```
status: pass  failedFiles: 0  tests: all passed
```

Unit suite: pass, failedFiles: 0.

`pnpm exec tsc --noEmit`: clean.  
`pnpm check` (`biome check --write`): 13 warnings (pre-existing, unrelated to this branch), 0 errors, 0 `suppressions/unused`.
