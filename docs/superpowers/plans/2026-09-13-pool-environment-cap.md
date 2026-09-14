# A pool capped by its environment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On an engine without `readwrite-unsafe`, an `OPFSWriteAheadVFS` pool runs on one worker without starting any worker bound to fail, exposes its effective size as `db.poolSize`, and an open failure carries its VFS-level cause to the consumer.

**Architecture:** Surplus workers (index ≥ 1) of a VFS declaring `singleConnectionWithout` receive a `declineWithout` list in their `open` message, probe the feature synchronously before loading wasm, and post `declined` instead of opening. The client retires such a slot — scheduler gate settles it as neither opened nor failed, supervisor takes it out of `liveCount` — without `onWorkerLost`, warning once only when `poolSize` was explicit. Separately, the worker's `open-error` now carries `vfsInstance.lastError`.

**Tech Stack:** TypeScript, wa-sqlite, Web Workers, OPFS, rstest (unit project in Node; chromium and firefox browser projects via Playwright), biome.

**Spec:** `docs/superpowers/specs/2026-09-13-pool-environment-cap-design.md` — read it before any task; decisions D1-D7 are the user's.

## Global Constraints

- Serena's symbolic tools are PRIMARY for code (`find_symbol`, `replace_symbol_body`, `insert_after_symbol`, `replace_content`); built-in Read/Edit on code files only as fallback. Markdown and JSON may use Read/Edit.
- **Never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`.** Run `pnpm exec tsc --noEmit` yourself before each commit; if the hook fails, stop and report its output verbatim; after committing, confirm with `git log -1` and `git show --stat HEAD`.
- Run `pnpm check` after every modification (biome, writes fixes).
- Every commit lands green. A failing test and the code that satisfies it are committed together.
- Every new test carries a `// Falsifiable:` comment naming the mutation that turns it red, and that mutation is tried once before committing.
- Read four fields from every rstest report: `status`, `failedFiles`, and the test counters. A green counter with `failedFiles > 0` is red.
- English in code, comments, docs and commit messages. Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Consumer pages (`API.md`, `VFS.md` prose, `README.md`) are edited with the user, iteratively, and committed only when the user says so (Task 8). The GENERATED zones of `VFS.md` are the exception: CI regenerates them and fails on a diff, so they are committed with the generator change that produced them.
- Probes and scratch files go in `.scratchpad/`; nothing in `src/`, `tests/` or CI may depend on it.
- Warning text, verbatim: `` `${vfs} holds its database file exclusively without ${missing}: pool capped at 1 of ${poolSize}` ``.
- Commands: unit file `pnpm exec rstest --project unit <path>`; browser file on Chromium `pnpm exec rstest --project chromium <path>`; on Firefox `pnpm exec rstest --config rstest.firefox.config.ts <path>`.

---

### Task 1: The worker-side probe

**Files:**
- Create: `src/worker/probes.ts`
- Test: `tests/unit/probes.test.ts`

**Interfaces:**
- Produces: `WORKER_PROBES: Partial<Record<PlatformFeature, (scope: ProbeScope) => boolean>>` and `firstMissing(features: readonly PlatformFeature[], scope?: ProbeScope): PlatformFeature | null`, both exported from `src/worker/probes.ts`. `ProbeScope = { FileSystemSyncAccessHandle?: unknown }`, exported.

- [ ] **Step 1: Write the failing test**

`tests/unit/probes.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { firstMissing, WORKER_PROBES } from '../../src/worker/probes';

/** Chromium 121+: the handle carries the `mode` attribute. */
class HandleWithMode {
  get mode() {
    return 'readwrite-unsafe';
  }
}
/** Firefox and Safari: the interface exists, the attribute does not. */
class HandleWithoutMode {}

describe('worker probes — readwrite-unsafe', () => {
  // Falsifiable: make the probe return true unconditionally — the Firefox and
  // Safari shape then reports the feature present.
  it('is missing where the handle has no mode attribute (Firefox, Safari)', () => {
    expect(
      firstMissing(['readwrite-unsafe'], {
        FileSystemSyncAccessHandle: HandleWithoutMode,
      }),
    ).toBe('readwrite-unsafe');
  });

  // Falsifiable: make the probe return false unconditionally — the Chromium
  // shape then reports the feature missing.
  it('is present where the handle carries mode (Chromium 121+)', () => {
    expect(
      firstMissing(['readwrite-unsafe'], {
        FileSystemSyncAccessHandle: HandleWithMode,
      }),
    ).toBeNull();
  });

  // Falsifiable: drop the `typeof … === 'function'` check — reading
  // `.prototype` of undefined throws instead of answering.
  it('is missing where the interface does not exist at all (the page)', () => {
    expect(firstMissing(['readwrite-unsafe'], {})).toBe('readwrite-unsafe');
  });
});

describe('worker probes — firstMissing', () => {
  // Falsifiable: treat a feature with no worker probe as missing — a
  // declaration naming one would then decline every surplus worker everywhere.
  it('never reports a feature it cannot probe', () => {
    expect(firstMissing(['opfs'], {})).toBeNull();
  });

  it('reports nothing for an empty list', () => {
    expect(firstMissing([], {})).toBeNull();
  });

  it('probes readwrite-unsafe and nothing else today', () => {
    expect(Object.keys(WORKER_PROBES)).toEqual(['readwrite-unsafe']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec rstest --project unit tests/unit/probes.test.ts`
Expected: FAIL — the module `src/worker/probes` does not exist.

- [ ] **Step 3: Write the module**

`src/worker/probes.ts`:

```ts
/**
 * Platform features a worker can probe for itself, synchronously, before it
 * loads anything. Pure, and tested in Node for the reason `cloneable.ts` is.
 *
 * `readwrite-unsafe` cannot be probed from the page: `FileSystemSyncAccessHandle`
 * is exposed to dedicated workers only, which is why `capabilities.ts` lists
 * it as unprobeable. A worker can, and without opening a file: the engines that
 * implement the mode also ship the handle's `mode` ATTRIBUTE. That is not the
 * trap `capabilities.ts` warns about — WebIDL ignores an unknown DICTIONARY
 * member, so passing the option proves nothing, but an attribute an engine does
 * not implement is simply absent from the prototype. Measured 2026-09-13 in a
 * dedicated worker: Chromium true, Firefox false, Safari false
 * (spec 2026-09-13, §3.1).
 */
import type { PlatformFeature } from '../types';

/** The globals a probe reads; `globalThis` in a worker, a stub in tests. */
export type ProbeScope = { FileSystemSyncAccessHandle?: unknown };

const hasModeAttribute = (scope: ProbeScope): boolean => {
  const Handle = scope.FileSystemSyncAccessHandle;
  return typeof Handle === 'function' && 'mode' in Handle.prototype;
};

export const WORKER_PROBES: Partial<
  Record<PlatformFeature, (scope: ProbeScope) => boolean>
> = {
  'readwrite-unsafe': hasModeAttribute,
};

/**
 * The first feature of `features` this worker lacks, or null. A feature with
 * no probe here is never reported missing: declining on something unprobeable
 * would shrink every pool on every engine.
 */
export const firstMissing = (
  features: readonly PlatformFeature[],
  scope: ProbeScope = globalThis as ProbeScope,
): PlatformFeature | null => {
  for (const feature of features) {
    const probe = WORKER_PROBES[feature];
    if (probe && !probe(scope)) return feature;
  }
  return null;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec rstest --project unit tests/unit/probes.test.ts`
Expected: PASS, 6 tests. Then try each `// Falsifiable:` mutation once, see it red, revert.

- [ ] **Step 5: Commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/worker/probes.ts tests/unit/probes.test.ts
git commit -m "feat(worker): probe readwrite-unsafe from inside a worker

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The scheduler retires a slot that declined

**Files:**
- Modify: `src/scheduler.ts` — the `Scheduler` type (add `retire`), the gate state beside `firstSettleOpened`, `settleGateSlot`, and the `remove` method.
- Test: `tests/unit/scheduler.test.ts` (append).

**Interfaces:**
- Produces: `Scheduler<W>.retire(index: number): void`. `onFirstSettle`'s signature is unchanged: `{ openedCount: number; failedIndices: number[] }`; a retired slot is in neither.

- [ ] **Step 1: Write the failing tests** — append to `tests/unit/scheduler.test.ts`:

```ts
describe('scheduler — retire(): a slot that declined to open', () => {
  // Falsifiable: settle a retired slot as 'failed' inside retire() — it then
  // appears in failedIndices and the client would retry a worker the
  // environment refuses.
  it('settles the gate without counting the slot as failed', () => {
    let result: { openedCount: number; failedIndices: number[] } | undefined;
    const scheduler = createScheduler<TestWorker>({
      poolSize: 4,
      onFirstSettle: (r) => {
        result = r;
      },
    });
    scheduler.add({ index: 0 });
    scheduler.retire(1);
    scheduler.retire(2);
    scheduler.retire(3);
    expect(result).toEqual({ openedCount: 1, failedIndices: [] });
  });

  // Falsifiable: settle a retired slot as 'opened' — openedCount becomes 1 and
  // the client keeps a pool with no worker instead of failing.
  it('reports openedCount 0 when slot 0 fails and every other slot declined', () => {
    let result: { openedCount: number; failedIndices: number[] } | undefined;
    const scheduler = createScheduler<TestWorker>({
      poolSize: 2,
      onFirstSettle: (r) => {
        result = r;
      },
    });
    scheduler.retire(1);
    scheduler.remove(0);
    expect(result).toEqual({ openedCount: 0, failedIndices: [0] });
  });

  // Falsifiable: do not settle the gate in retire() — the acquire never
  // resolves and the test times out.
  it('opens the gate and serves from the worker that opened', async () => {
    const scheduler = createScheduler<TestWorker>({ poolSize: 2 });
    const pending = scheduler.acquire('read');
    scheduler.add({ index: 0 });
    scheduler.retire(1);
    const lease = await pending;
    expect(lease.worker.index).toBe(0);
    lease.release();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec rstest --project unit tests/unit/scheduler.test.ts`
Expected: FAIL — `scheduler.retire is not a function` (and a `tsc` error on the missing member).

- [ ] **Step 3: Implement**

a) In the `Scheduler<W>` type, directly after the `remove` member:

```ts
  /**
   * Takes a slot out of the pool for good because its worker DECLINED to open:
   * the environment caps the pool below its requested size (spec 2026-09-13).
   * Unlike `remove()`, the slot settles the readiness gate as neither opened
   * nor failed, so it never appears in `onFirstSettle`'s `failedIndices` and
   * never enters the startup retry round.
   */
  retire: (index: number) => void;
```

b) Directly after `let firstSettleFired = false;`:

```ts
  // Slots that settled via retire(): neither opened nor failed, so
  // onFirstSettle must not report them as failures.
  const declinedSlots = new Set<number>();
```

c) In `settleGateSlot`, widen the kind and record declines. The signature becomes
`(index: number, kind: 'opened' | 'failed' | 'declined')`; after
`if (kind === 'opened') firstSettleOpened.add(index);` add
`if (kind === 'declined') declinedSlots.add(index);`; and the `failedIndices`
filter becomes:

```ts
      const failedIndices = [...settledSlots].filter(
        (i) => !firstSettleOpened.has(i) && !declinedSlots.has(i),
      );
```

d) Extract the body `remove` shares with `retire`. Immediately above the `return {` that builds the scheduler object, declare (moving `remove`'s comments with the lines they explain):

```ts
  /** What `remove()` and `retire()` both do once the gate has been told. */
  const takeOut = (index: number) => {
    dead.add(index);
    available.delete(index);
    leased.delete(index);
    workers[index] = undefined;
    // Bump the generation so any outstanding lease on this index knows it is
    // stale when its release() eventually fires.
    generations.set(index, gen(index) + 1);
    if (currentWriterIndex === index) currentWriterIndex = -1;
    // A respawned slot is a different connection with a fresh epoch, so the
    // freshness hint this index carried is void.
    if (lastWriterIndex === index) lastWriterIndex = -1;
    checkShutdown();
  };
```

and replace the two methods:

```ts
    remove: (index) => {
      // Settle this slot in the gate — a dead slot counts. First call per
      // index only; a restart after the gate is open is a no-op here.
      settleGateSlot(index, 'failed');
      takeOut(index);
    },

    retire: (index) => {
      settleGateSlot(index, 'declined');
      takeOut(index);
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec rstest --project unit tests/unit/scheduler.test.ts`
Expected: PASS, the three new tests and every existing one. Try each falsifier once.

- [ ] **Step 5: Commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/scheduler.ts tests/unit/scheduler.test.ts
git commit -m "feat(scheduler): retire a slot that declined to open

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The supervisor's `retired` event

**Files:**
- Modify: `src/supervisor.ts` — the `Supervisor` type's event union, and `report`.
- Test: `tests/unit/supervisor.test.ts` (append).

**Interfaces:**
- Produces: `supervisor.report(index, 'retired')` → `undefined`, always.

- [ ] **Step 1: Write the failing tests** — append to `tests/unit/supervisor.test.ts`:

```ts
describe('supervisor — retired: a slot the environment refused', () => {
  // Falsifiable: return 'lost' from the 'retired' branch — the client would
  // announce a loss for a worker that was never meant to open.
  it('yields no decision', () => {
    const supervisor = createSupervisor({ size: 2 });
    expect(supervisor.report(1, 'retired')).toBeUndefined();
  });

  // Falsifiable: leave `slot.alive` true in the 'retired' branch — liveCount
  // still counts the slot, and the last real worker's death returns 'lost'
  // instead of failing the client.
  it('leaves liveCount, so the last real worker still fails the client', () => {
    const supervisor = createSupervisor({ size: 2 });
    supervisor.report(1, 'retired');
    expect(supervisor.report(0, 'died')).toBe('fail-client');
  });

  // Falsifiable: drop `slot.lost = true` — a late 'spawned'/'ready' revives
  // the slot and its death takes the restart path.
  it('cannot be revived by a late spawned or ready', () => {
    const supervisor = createSupervisor({ size: 2 });
    supervisor.report(1, 'retired');
    supervisor.report(1, 'spawned');
    supervisor.report(1, 'ready');
    expect(supervisor.report(1, 'died')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec rstest --project unit tests/unit/supervisor.test.ts`
Expected: FAIL — `tsc` rejects `'retired'`; at runtime it falls into the `'died'` branch and returns `'lost'`.

- [ ] **Step 3: Implement**

a) The event union in `Supervisor` becomes
`'spawned' | 'ready' | 'served' | 'died' | 'lost' | 'retired'`.

b) In `report`, directly before `if (event === 'lost') {`:

```ts
      if (event === 'retired') {
        // A slot the environment refuses (spec 2026-09-13): its worker declined
        // to open and never will. Not a loss, so no decision — but it must
        // leave liveCount, or the last real worker's death would not fail the
        // client, and `lost` is what keeps a late 'spawned'/'ready' from
        // reviving it. Same duplicate-signal guard as the branches below.
        if (!slot.alive) return undefined;
        slot.alive = false;
        slot.lost = true;
        return undefined;
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec rstest --project unit tests/unit/supervisor.test.ts`
Expected: PASS. Try each falsifier once.

- [ ] **Step 5: Commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/supervisor.ts tests/unit/supervisor.test.ts
git commit -m "feat(supervisor): a retired slot is neither lost nor revived

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The declaration, its generated doc line, and its guards

**Files:**
- Modify: `src/types.ts` — `VFSCapability` (new field; the `requires` comment), every `VFS_CAPABILITIES` entry, the comment above `OPFSWriteAheadVFS`'s `requires`.
- Modify: `src/capabilities.ts` — the comment above `UNPROBEABLE`.
- Modify: `scripts/render-vfs-matrix.ts` — the per-VFS header's `pool` constant.
- Modify: `VFS.md` — generated zones only, by `pnpm docs:vfs`.
- Test: `tests/unit/capabilities.test.ts`.

**Interfaces:**
- Consumes: `WORKER_PROBES` from Task 1.
- Produces: `VFSCapability.singleConnectionWithout: readonly PlatformFeature[]` — `['readwrite-unsafe']` on `OPFSWriteAheadVFS`, `[]` on the eight others.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/capabilities.test.ts`, in `'gives every declared feature either a probe or an explicit exemption'`, after `for (const f of cap.degradesWithout) declared.add(f);` add:

```ts
      for (const f of cap.singleConnectionWithout) declared.add(f);
```

and append, importing `WORKER_PROBES` from `'../../src/worker/probes'`:

```ts
describe('singleConnectionWithout', () => {
  // Falsifiable: declare `singleConnectionWithout: ['opfs']` on any VFS — the
  // worker has no probe for it, so the declaration would never cap anything.
  it('names only features a worker can probe', () => {
    for (const cap of Object.values(VFS_CAPABILITIES)) {
      for (const feature of cap.singleConnectionWithout) {
        expect(feature in WORKER_PROBES).toBe(true);
      }
    }
  });

  // Falsifiable: declare it on OPFSAdaptiveVFS — that VFS rotates its handle
  // and opens its whole pool without readwrite-unsafe (spec 2026-09-13, §6).
  it('caps OPFSWriteAheadVFS and nothing else', () => {
    const capped = Object.entries(VFS_CAPABILITIES)
      .filter(([, cap]) => cap.singleConnectionWithout.length > 0)
      .map(([name]) => name);
    expect(capped).toEqual(['OPFSWriteAheadVFS']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec rstest --project unit tests/unit/capabilities.test.ts`
Expected: FAIL — `singleConnectionWithout` is undefined.

- [ ] **Step 3: Implement the declaration**

a) In `VFSCapability`, directly after `readonly degradesWithout: readonly PlatformFeature[];`:

```ts
  /**
   * Platform features without which this VFS holds its database file
   * exclusively for a connection's whole life, so exactly ONE worker of a pool
   * can open — the others fail at `xOpen` rather than wait.
   *
   * Not `degradesWithout`: `OPFSAdaptiveVFS` lacks `readwrite-unsafe` off
   * Chromium too, but hands its handle over between connections and opens its
   * whole pool. `OPFSWriteAheadVFS` keeps its main and write-ahead handles
   * until close. Every feature listed here needs a worker-side probe in
   * `src/worker/probes.ts`: the pool's surplus workers probe it before loading
   * anything and decline instead of failing (spec 2026-09-13).
   */
  readonly singleConnectionWithout: readonly PlatformFeature[];
```

b) In the `requires` comment of `VFSCapability`, replace
`so the handle silently opens exclusive and the second connection hangs rather than failing.`
with
`so the handle silently opens exclusive, and a second connection then waits or fails depending on the VFS — see \`degradesWithout\` and \`singleConnectionWithout\`.`

c) In every `VFS_CAPABILITIES` entry, directly after its `degradesWithout: …,` line, add `singleConnectionWithout: [],` — then change `OPFSWriteAheadVFS`'s to `singleConnectionWithout: ['readwrite-unsafe'],`. Nine entries; `git diff --stat` shows nine insertions in that object.

d) Replace the comment block above `OPFSWriteAheadVFS`'s `requires` (`// Measured on Firefox 2026-08-27 …` through `// Safari is still unmeasured …`) with:

```ts
    // Measured on Firefox 2026-08-27, HAS_UNSAFE_HANDLES false: all three
    // build pairs and all six invariants pass. That campaign ran at an
    // EFFECTIVE pool of one: without readwrite-unsafe every worker but the
    // first failed to open, and conformance did not count live workers
    // (spec 2026-09-13). `requires` used to name readwrite-unsafe, which made
    // the conformance suite skip the very pairs that would have falsified it.
    // Safari behaves as Firefox — observed 2026-09-13, InvalidStateError.
```

e) In `src/capabilities.ts`, the comment above `UNPROBEABLE` becomes:

```ts
/**
 * Features with no synchronous probe FROM THE PAGE. Declared, never merely
 * omitted.
 *
 * WebIDL ignores an unknown dictionary member, so passing `readwrite-unsafe`
 * and seeing no error proves nothing. `FileSystemSyncAccessHandle`, whose
 * `mode` attribute would tell, is exposed to dedicated workers only — so the
 * pool's own workers probe it (`src/worker/probes.ts`), and the benchmark page
 * opens two handles in a worker of its own. A feature in neither table is a
 * mistake, and `tests/unit/capabilities.test.ts` says so.
 */
```

- [ ] **Step 4: Implement the generated line**

In `scripts/render-vfs-matrix.ts`, the per-VFS header's `pool` constant becomes:

```ts
  const pool =
    cap.maxPoolSize === null
      ? cap.singleConnectionWithout.length === 0
        ? 'Any'
        : `Any, 1 without ${cap.singleConnectionWithout.map((f) => `\`${f}\``).join(', ')}`
      : `**${cap.maxPoolSize}**${noteRef(`pool-${name}`)}`;
```

Run: `pnpm docs:vfs && git diff VFS.md`
Expected: exactly one changed line, inside `<!-- BEGIN GENERATED OPFSWriteAheadVFS -->`: `**Pool size:** Any, 1 without \`readwrite-unsafe\``. Nothing else.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec rstest --project unit` and `pnpm exec tsc --noEmit`
Expected: PASS, 446 + the tests of Tasks 1-4; `tsc` clean. Try both falsifiers once.

- [ ] **Step 6: Commit**

```bash
pnpm check
git add src/types.ts src/capabilities.ts scripts/render-vfs-matrix.ts VFS.md tests/unit/capabilities.test.ts
git commit -m "feat(types): declare the VFS that holds one connection without readwrite-unsafe

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The declined path, end to end

The integration task: protocol, worker, pool, client, the `db.poolSize` getter, `WorkerLostEvent.size`, the conformance guard that reproduces the defect, and browser tests T1-T4.

**Files:**
- Modify: `tests/conformance/helpers.ts`, `tests/conformance/builds.test.ts`, `tests/conformance/invariants.test.ts`
- Modify: `src/types.ts` — `ClientMessageData` (`open`), `WorkerMessageData` (`declined`)
- Modify: `src/worker/worker.ts` — `OpenOptions`, `open()`, the top-level `onmessage`'s `open` case
- Modify: `src/pool.ts` — `DeclinedWorker` type, `createPoolWorker`'s deps / result / message switch / `open` post
- Modify: `src/client.ts` — `effectivePoolSize`, `spawn`, new `retireSlot`, `emitWorkerLost`, the `poolSize` getter, the docs of `poolSize`, `onWorkerLost` and `WorkerLostEvent.size`
- Modify: `src/api.ts` — `readonly poolSize: number`
- Modify: `tests/unit/exports.test.ts` — `'poolSize'` in `_ClientExtras`
- Create: `tests/browser/pool-cap.test.ts`

**Interfaces:**
- Consumes: `firstMissing` (Task 1), `scheduler.retire` (Task 2), `report(index, 'retired')` (Task 3), `capability.singleConnectionWithout` (Task 4).
- Produces: `db.poolSize: number`; `DeclinedWorker = { declined: PlatformFeature }` exported from `src/pool.ts`; `createPoolWorker(...): Promise<PoolWorker | DeclinedWorker>`; worker message `{ type: 'declined'; callId: 0; missing: PlatformFeature }`; `expectNoWorkerLost` exported from `tests/conformance/helpers.ts`.

- [ ] **Step 1: The conformance guard — the reproduction**

In `tests/conformance/helpers.ts`, import `expect` from `'@rstest/core'` and `type WorkerLostEvent` from `'../../src/client'`, then above `conformanceClient`:

```ts
/**
 * Every worker a conformance client lost, as `"<vfs> slot <index>: <message>"`.
 * A conformance pass with a lost worker is not a pass: on 2026-08-27 Firefox
 * "passed" OPFSWriteAheadVFS at poolSize 2 and 4 on ONE live worker, because
 * nothing here counted them (spec 2026-09-13). Drained by `expectNoWorkerLost`.
 */
const workerLosses: string[] = [];
const recordLoss =
  (vfs: SQLiteVFS) =>
  ({ index, cause }: WorkerLostEvent) => {
    workerLosses.push(`${vfs} slot ${index}: ${cause.message}`);
  };

/** Register with `afterEach` at the top level of every conformance file. */
export const expectNoWorkerLost = () => {
  expect(workerLosses.splice(0)).toEqual([]);
};
```

Pass `onWorkerLost: recordLoss(vfs)` in both `createSQLiteClient` calls — `conformanceClient`'s and `createReopened`'s.

In `tests/conformance/builds.test.ts` and `tests/conformance/invariants.test.ts`, add `afterEach` to the `@rstest/core` import, `expectNoWorkerLost` to the `./helpers` import, and at module top level, before the first `describe`:

```ts
// Falsifiable: remove this line — Firefox "passes" OPFSWriteAheadVFS on a
// pool that lost every worker but one, as it did on 2026-08-27.
afterEach(expectNoWorkerLost);
```

Run: `pnpm test:conformance:firefox`
Expected: **FAIL** on the `OPFSWriteAheadVFS` tests, each failure listing `OPFSWriteAheadVFS slot <n>: sqlite3_open_v2`. Every other VFS passes. This is the reproduction; do NOT commit it alone.

Run: `pnpm test:conformance:chromium`
Expected: PASS, 85 tests / 2 files, 73 passed / 12 skipped.

- [ ] **Step 2: The browser tests T1-T4**

`tests/browser/pool-cap.test.ts`:

```ts
/**
 * A pool the environment caps is capped, not lost (spec 2026-09-13).
 *
 * Shared by both engines. The arbiter is HAS_UNSAFE_HANDLES — a behavioural
 * oracle that opens two handles, independent of the library's own probe — so
 * no engine is named and the day Firefox or WebKit ships readwrite-unsafe these
 * tests follow it.
 */
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { HAS_UNSAFE_HANDLES } from '../conformance/helpers';
import { createTestClient, interceptWorkers } from './helpers';

const CAPPED = !HAS_UNSAFE_HANDLES;

/** Replaces console.warn for the current test; returns what it received. */
const captureWarnings = () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  onTestFinished(() => {
    console.warn = original;
  });
  return warnings;
};

describe('a pool capped by its environment', () => {
  // T1. Falsifiable, three ways: a probe that always passes (Firefox then loses
  // three workers); a probe that always fails (Chromium then runs on one); the
  // probe sent to slot 0 as well (the client then fails — nothing opens).
  it('runs OPFSWriteAheadVFS on one worker without readwrite-unsafe, and warns once when poolSize was asked for', async () => {
    const warnings = captureWarnings();
    const records = interceptWorkers();
    const lost: number[] = [];
    const db = await createTestClient({
      vfs: 'OPFSWriteAheadVFS',
      poolSize: 4,
      onWorkerLost: ({ index }) => lost.push(index),
    });
    await db.write('CREATE TABLE t (a)');

    expect(db.poolSize).toBe(CAPPED ? 1 : 4);
    expect(lost).toEqual([]);
    expect(warnings.filter((w) => w.includes(' lost;'))).toEqual([]);
    const capWarnings = warnings.filter((w) => w.includes('pool capped'));
    if (CAPPED) {
      expect(capWarnings).toHaveLength(1);
      expect(capWarnings[0]).toContain('without readwrite-unsafe');
      expect(capWarnings[0]).toContain('pool capped at 1 of 4');
      expect(records[0]?.received).toContain('ready');
      for (const record of records.slice(1)) {
        expect(record.received).toEqual(['declined']);
        expect(record.terminated).toBe(true);
      }
    } else {
      expect(capWarnings).toEqual([]);
    }
    await db.close();
  });

  // T2. Falsifiable: drop the "poolSize was passed" condition on the warning.
  it('caps silently when poolSize was left to its default', async () => {
    const warnings = captureWarnings();
    const db = await createTestClient({ vfs: 'OPFSWriteAheadVFS' });
    await db.write('CREATE TABLE t (a)');
    expect(db.poolSize).toBe(CAPPED ? 1 : 2);
    expect(warnings).toEqual([]);
    await db.close();
  });

  // T3. Falsifiable: declare singleConnectionWithout on OPFSAdaptiveVFS.
  it('leaves OPFSAdaptiveVFS its whole pool: it rotates its handle', async () => {
    const lost: number[] = [];
    const db = await createTestClient({
      vfs: 'OPFSAdaptiveVFS',
      poolSize: 4,
      onWorkerLost: ({ index }) => lost.push(index),
    });
    await db.write('CREATE TABLE t (a)');
    expect(db.poolSize).toBe(4);
    expect(lost).toEqual([]);
    await db.close();
  });

  // T4. Falsifiable: report the requested poolSize as `size` — 4, not 1.
  (CAPPED ? it : it.skip)(
    'reports the effective size when the one remaining worker is lost',
    async () => {
      const records = interceptWorkers();
      const events: { size: number; live: number }[] = [];
      const db = await createTestClient({
        vfs: 'OPFSWriteAheadVFS',
        poolSize: 4,
        maxWorkerRestarts: 0,
        onWorkerLost: ({ size, live }) => events.push({ size, live }),
      });
      await db.write('CREATE TABLE t (a)');
      records[0]?.worker.dispatchEvent(
        new ErrorEvent('error', { message: 'simulated worker failure' }),
      );
      expect(events).toEqual([{ size: 1, live: 0 }]);
      await db.close();
    },
  );
});
```

Run: `pnpm exec rstest --config rstest.firefox.config.ts tests/browser/pool-cap.test.ts`
Expected: FAIL — `db.poolSize` is undefined and three workers are lost. Do not commit.

- [ ] **Step 3: The protocol**

In `src/types.ts`, in `ClientMessageData`'s `open` variant, after `abortIndex?: number;`:

```ts
      /**
       * Features this worker must find before opening; it declines instead of
       * opening when one is missing (spec 2026-09-13). Sent to slots of index
       * ≥ 1 only, and only by a VFS that declares `singleConnectionWithout`.
       */
      declineWithout?: readonly PlatformFeature[];
```

In `WorkerMessageData`, after `| { type: 'ready'; callId: number }`:

```ts
  /**
   * The worker found a feature of `declineWithout` missing and opened nothing:
   * the environment caps the pool (spec 2026-09-13).
   */
  | { type: 'declined'; callId: number; missing: PlatformFeature }
```

- [ ] **Step 4: The worker**

In `src/worker/worker.ts`:

a) Add `type PlatformFeature` to the import list from `'../types'`, and `import { firstMissing } from './probes';` beside the `./cloneable` import.

b) `OpenOptions` gains `declineWithout?: readonly PlatformFeature[] | undefined;`.

c) In the top-level `self.onmessage`'s `open` case, destructure `declineWithout` from `data` with the others and pass it in the options object given to `open(file, { … })`.

d) In `open()`, directly after the `if (openedDB) { throw … }` guard:

```ts
  // Spec 2026-09-13: before anything is loaded. A surplus worker of a pool the
  // environment caps opens nothing — no wasm, no VFS, no file — and says so,
  // so nothing fails and wa-sqlite prints nothing. The client terminates it.
  const missing = firstMissing(options.declineWithout ?? []);
  if (missing !== null) {
    self.postMessage({
      type: 'declined',
      callId: 0,
      missing,
    } satisfies WorkerMessageData);
    return;
  }
```

- [ ] **Step 5: The pool**

In `src/pool.ts`:

a) Import `PlatformFeature` as a type from `'./types'` (add it to the existing type import from that module, or add `import type { PlatformFeature } from './types';`). Export, beside `PoolWorker`:

```ts
/** What `createPoolWorker` settles with when its worker declined to open. */
export type DeclinedWorker = { declined: PlatformFeature };
```

b) `createPoolWorker`'s deps gain `declineWithout?: readonly PlatformFeature[] | undefined;`; its return type becomes `Promise<PoolWorker | DeclinedWorker>`; `deferredInit` becomes `Promise.withResolvers<PoolWorker | DeclinedWorker>()`; add `const { declineWithout } = deps;` beside `const { abortSlots } = deps;`.

c) In the `worker.postMessage({ callId: 0, type: 'open', … })` call, add `declineWithout,` after `abortIndex: …`.

d) In the message `switch (type)`, after the `'open-error'` case:

```ts
      case 'declined': {
        // Not a death: this worker opened nothing and never will. It settles
        // init WITHOUT `die`, so no `onDeath`; the client retires the slot and
        // terminates the thread (spec 2026-09-13).
        if (data.callId === 0) {
          logger.info(`worker ${index + 1} declined: no ${data.missing}`);
          deferredInit.resolve({ declined: data.missing });
        }
        break;
      }
```

- [ ] **Step 6: The client**

In `src/client.ts` (import `PlatformFeature` as a type from `'./types'` if it is not already):

a) Directly after `const pool: (PoolWorker | undefined)[] = [];`:

```ts
  /**
   * The size the pool actually runs at: `poolSize` minus the slots whose worker
   * declined because the environment caps the pool (spec 2026-09-13). What the
   * `poolSize` getter and `onWorkerLost`'s `size` report. Losses do not change
   * it — they are reported with `live`.
   */
  let effectivePoolSize = poolSize;
  let capAnnounced = false;
```

b) In `spawn`, add to the `createPoolWorker({ … })` argument:

```ts
      // Slot 0 never probes and always opens; only surplus workers may decline.
      declineWithout:
        index > 0 && capability.singleConnectionWithout.length > 0
          ? capability.singleConnectionWithout
          : undefined,
```

and replace its `.then((worker) => { … })` with:

```ts
      .then((result) => {
        if ('declined' in result) {
          retireSlot(index, result.declined);
          return;
        }
        supervisor.report(index, 'ready');
        // If this slot was recorded in startupLosses (it failed in a prior
        // round and is now recovering in the retry), remove the record so it
        // is not reported as permanently lost in onGateOpen.
        startupLosses.delete(index);
        scheduler.add(result);
      })
```

c) Directly after `emitWorkerLost`, add:

```ts
  /**
   * A slot whose worker declined to open: the environment caps the pool
   * (spec 2026-09-13, D1). Not a loss — no `onWorkerLost`, no restart — and
   * announced once, as a warning only when the consumer asked for a pool size
   * (D2). The supervisor hears of it BEFORE the scheduler, because retire()
   * may open the gate synchronously and onGateOpen reads liveCount.
   */
  const retireSlot = (index: number, missing: PlatformFeature) => {
    pool[index]?.terminate();
    pool[index] = undefined;
    effectivePoolSize -= 1;
    supervisor.report(index, 'retired');
    scheduler.retire(index);
    if (capAnnounced) return;
    capAnnounced = true;
    const message = `${vfs} holds its database file exclusively without ${missing}: pool capped at 1 of ${poolSize}`;
    if (clientOptions.poolSize !== undefined) logger.always.warn(message);
    else logger.info(message);
  };
```

d) In `emitWorkerLost`, report the effective size: the warning's `of ${poolSize}` becomes `of ${effectivePoolSize}`, and the callback receives `size: effectivePoolSize`.

e) After `get build() { return build; },`:

```ts
    get poolSize() {
      return effectivePoolSize;
    },
```

f) Docs in the same file. In `CreateSQLiteClientOptions.poolSize`, after `capped to what the VFS allows.` add:
`The environment can cap it too: \`OPFSWriteAheadVFS\` runs on one worker wherever \`readwrite-unsafe\` is missing, with no error, and warns once only when this option was passed. \`db.poolSize\` reports the size the pool runs at.`
In `onWorkerLost`'s doc, `the requested pool size` becomes `the pool's size (\`db.poolSize\`)`. `WorkerLostEvent.size`'s doc becomes:
`/** The number of workers the pool runs — \`db.poolSize\`, not the \`poolSize\` option: the two differ where the environment caps the pool. */`

g) In `src/api.ts`, after `readonly build: SQLiteBuild;`:

```ts
  /**
   * The number of workers the pool runs: `poolSize` as requested, capped by
   * the VFS and by the environment. Exact once every worker has opened or
   * declined; every query waits for that, so it is settled by the time any
   * query returns.
   */
  readonly poolSize: number;
```

h) In `tests/unit/exports.test.ts`, add `| 'poolSize'` to `_ClientExtras` after `| 'build'` — a transaction handle has no pool, and without it `tsc` fails the client/transaction pin.

- [ ] **Step 7: Run everything this task touches**

Run, in order, reading the four fields of each report:
1. `pnpm exec tsc --noEmit` — clean.
2. `pnpm exec rstest --project unit` — pass.
3. `pnpm exec rstest --config rstest.firefox.config.ts tests/browser/pool-cap.test.ts` — pass, 4 tests.
4. `pnpm exec rstest --project chromium tests/browser/pool-cap.test.ts` — pass, 3 tests + T4 skipped.
5. `pnpm test:conformance:firefox` and `pnpm test:conformance:chromium` — both pass, 73 passed / 12 skipped each, identical. Firefox prints `pool capped at 1 of 2` warnings for `OPFSWriteAheadVFS` — expected (D2: conformance passes `poolSize` explicitly).

Then try each falsifier of T1-T4 once — including T1's third (send `declineWithout` to slot 0 too: the client fails).

- [ ] **Step 8: Commit**

```bash
pnpm check
git add src/types.ts src/worker/worker.ts src/pool.ts src/client.ts src/api.ts \
  tests/unit/exports.test.ts tests/browser/pool-cap.test.ts \
  tests/conformance/helpers.ts tests/conformance/builds.test.ts tests/conformance/invariants.test.ts
git commit -m "fix(pool): a pool the environment caps is capped, not lost

Without readwrite-unsafe, OPFSWriteAheadVFS holds its file exclusively for a
connection's life. Surplus workers now probe the feature before loading
anything and decline; the client retires their slots without onWorkerLost,
exposes db.poolSize, and warns once only when poolSize was passed.
Conformance now fails on any lost worker, which is what hid this.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: An open failure carries the VFS's own error

**Files:**
- Modify: `src/worker/worker.ts` — `open()`: hoisted instance, the `vfsInstance` callback, the final `catch`.
- Modify: `src/client.ts` — `emitWorkerLost`'s warning.
- Test: `tests/browser/pool-cap.test.ts` (append T5).

**Interfaces:**
- Consumes: `emitWorkerLost` as left by Task 5.
- Produces: `open-error.message` = `` `${waSqliteMessage}: ${name}: ${message}` `` when the VFS recorded an error; `open-error.cause` = that error, cloned.

- [ ] **Step 1: Write the failing test** — append to `tests/browser/pool-cap.test.ts`, inside the `describe`, and add `createSQLiteClient` from `'../../src/client'` to the imports:

```ts
  // T5. Falsifiable: ignore `lastError` in the worker's final catch — the
  // cause then says `sqlite3_open_v2` and nothing else.
  it('reports the storage error behind a failed open', async () => {
    const file = `pool-cap-held-${crypto.randomUUID()}`;
    // A third party holds the file exclusively, then tries the VFS's own call
    // shape once: the error it gets is the oracle, measured on this engine.
    const src = `
      let held;
      self.onmessage = async (e) => {
        if (e.data === 'release') { held?.close(); self.postMessage('released'); return; }
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(e.data, { create: true });
        held = await fh.createSyncAccessHandle();
        try {
          const again = await fh.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
          again.close();
          self.postMessage(null);
        } catch (err) {
          self.postMessage(err.name);
        }
      };`;
    const holder = new Worker(
      URL.createObjectURL(new Blob([src], { type: 'text/javascript' })),
    );
    const ask = (message: string) =>
      new Promise<unknown>((resolve) => {
        holder.onmessage = (e) => resolve(e.data);
        holder.postMessage(message);
      });
    const oracle = (await ask(file)) as string | null;
    onTestFinished(async () => {
      await ask('release');
      holder.terminate();
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(file).catch(() => {});
    });
    // An engine where the VFS's call shape coexists with an exclusive handle
    // gives this test nothing to observe.
    expect(oracle).not.toBeNull();

    const warnings = captureWarnings();
    const causes: Error[] = [];
    const db = createSQLiteClient(file, {
      vfs: 'OPFSWriteAheadVFS',
      poolSize: 1,
      onWorkerLost: ({ cause }) => causes.push(cause),
    });
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });
    expect(causes).toHaveLength(1);
    expect(causes[0]?.message).toContain(`sqlite3_open_v2: ${oracle}:`);
    expect((causes[0]?.cause as { name?: string } | undefined)?.name).toBe(
      oracle,
    );
    expect(warnings.some((w) => w.includes(` lost;`) && w.includes(`${oracle}:`))).toBe(true);
    await db.close();
  });
```

- [ ] **Step 2: Run it to verify it fails — and record the oracle**

Run on both engines:
`pnpm exec rstest --config rstest.firefox.config.ts tests/browser/pool-cap.test.ts --testNamePattern "storage error"`
`pnpm exec rstest --project chromium tests/browser/pool-cap.test.ts --testNamePattern "storage error"`
Expected: FAIL on the `toContain` — the message is `sqlite3_open_v2` alone. **Record the oracle value each engine printed** (Firefox is expected to give `NoModificationAllowedError`; Chromium's is unmeasured, spec §7). If Chromium's `oracle` is `null`, the VFS's call shape coexists with an exclusive handle there: stop and report — the test then needs `(… ? it : it.skip)` on that condition, which is a spec amendment for the user.

- [ ] **Step 3: Implement the worker side**

In `open()`, directly before `openedDB = WA_SQLITE_BUILDS[build]()`:

```ts
  // Hoisted for the final `catch`. For `sqlite3_open_v2` wa-sqlite has no
  // connection to ask `sqlite3_errmsg`, so its error names only the function;
  // the VFS keeps the real one in `lastError` (spec 2026-09-13, §3.4). A fresh
  // instance per open() means the value cannot be stale.
  let vfsInstanceSeen: { lastError?: unknown } | undefined;
```

In the `.then((vfsInstance: any) => {` callback, first line: `vfsInstanceSeen = vfsInstance;`.

Replace the final `.catch((error: unknown) => { self.postMessage({ type: 'open-error', … }); throw error; })` body's message and cause:

```ts
    .catch((error: unknown) => {
      const base =
        error instanceof Error ? error.message : `Failed to open ${file}`;
      const vfsError = vfsInstanceSeen?.lastError;
      const detail =
        vfsError instanceof Error
          ? `${vfsError.name}: ${vfsError.message}`
          : undefined;
      self.postMessage({
        type: 'open-error',
        callId: 0,
        message: detail ? `${base}: ${detail}` : base,
        cause: cloneable(detail ? vfsError : error),
        // wa-sqlite raises SQLiteError(message, code) with SQLite's numeric
        // result code. Carry it across the postMessage boundary so pool.ts
        // can mint SQLiteError('BUSY') rather than SQLiteError('WORKER_CRASHED').
        ...(typeof (error as { code?: unknown })?.code === 'number'
          ? { sqliteCode: (error as { code: number }).code }
          : {}),
      });
      throw error;
    });
```

(`DOMException` inherits from `Error` in every engine this library supports, so `instanceof Error` covers the storage errors.)

- [ ] **Step 4: Implement the client side**

In `emitWorkerLost`, the warning becomes:

```ts
    logger.always.warn(
      `worker ${index + 1} lost; pool is now ${live} of ${effectivePoolSize} (${error.message})`,
    );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run `tests/browser/pool-cap.test.ts` on both engines (commands in Global Constraints): pass, T5 included. `pnpm exec tsc --noEmit`: clean. `pnpm exec rstest --project unit`: pass — `tests/unit/logger.test.ts` passes a literal and is unaffected. Try the falsifier once.

- [ ] **Step 6: Commit**

```bash
pnpm check
git add src/worker/worker.ts src/client.ts tests/browser/pool-cap.test.ts
git commit -m "fix(worker): an open failure carries the VFS's own error

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The bench export records the pool it ran on

**Files:**
- Modify: `scripts/bench/html/index.html` — `RESULTS` (declaration and reset), the end of `runPair`, the export object.
- Modify: `scripts/bench/check.mjs` — `EXPECTED_KEYS`.

**Interfaces:**
- Consumes: `db.poolSize` (Task 5).
- Produces: export key `poolSize: Record<pairId, number | null>`.

- [ ] **Step 1: Make the checker demand the key** — in `scripts/bench/check.mjs`, add `'poolSize'` to `EXPECTED_KEYS` after `'opfsRootAtStart'`.

- [ ] **Step 2: Run the check to verify it fails**

Run: `pnpm build && BENCH_PORT=8123 node scripts/bench/check.mjs chromium --all`
Expected: FAIL — `export missing key: poolSize`.

- [ ] **Step 3: Record it**

a) `const RESULTS = { conformance: {}, measurements: {}, reasons: {} };` becomes `const RESULTS = { conformance: {}, measurements: {}, reasons: {}, poolSize: {} };`, and beside the reset lines (`RESULTS.reasons = {};`) add `RESULTS.poolSize = {};`.

b) At the end of `runPair`, directly before `try { await closeWithTimeout(ctx.db);`:

```js
        // The pool this column actually ran on. Until 2026-09-13 every export
        // of OPFSWriteAheadVFS off Chromium ran on ONE worker of four with
        // nothing to say so (spec 2026-09-13). `ctx.db`, not `db`: a reopen
        // row replaces the column's client.
        RESULTS.poolSize[pair.id] = ctx.db.poolSize ?? null;
```

c) In the export object, directly after `opfsRootAtStart: …,`:

```js
        // Per pair, the workers the pool ran on — `db.poolSize`, which the
        // environment can cap below `poolFor`. `null` from a build that
        // predates the getter.
        poolSize: RESULTS.poolSize,
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `pnpm build && BENCH_PORT=8123 node scripts/bench/check.mjs chromium --all`
Expected: `export OK — keys: …, poolSize, …`, empty `reasons`.

Out of scope, noted for the user and not changed: `ctx.pool = poolFor(pair.cap)` still normalises the concurrency rows' ideal gain by the REQUESTED pool; spec §8 asks only that the export record the effective one.

- [ ] **Step 5: Commit**

```bash
pnpm check
git add scripts/bench/html/index.html scripts/bench/check.mjs
git commit -m "feat(bench): record the pool each column actually ran on

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Consumer documentation and CHANGELOG — inline, with the user

Not dispatched. The agent proposes each edit below, shows the diff, and iterates with the user; nothing is committed until the user says so (`mem:conventions`, "Writing for the consumer"). The wording below is the starting proposal the spec validated.

**Files:** `API.md`, `VFS.md` (prose only), `CHANGELOG.md`.

- [ ] **Step 1: `API.md`**
  - Options table, `poolSize` row, Default cell: `` `2`, capped to the VFS's `maxPoolSize` and to what the environment allows ``.
  - The paragraph **`poolSize` delays your first query.**: keep its first two sentences, then: `Two things cap it. A VFS that holds a single connection caps it at \`1\` and throws if you pass more; omitting it never throws. And \`OPFSWriteAheadVFS\` runs on one worker wherever \`readwrite-unsafe\` is missing — every engine but Chromium, for now — because it keeps its database file open exclusively: there the pool is capped without an error, and warns once only if you passed \`poolSize\`. [\`poolSize\`](#clientpoolsize) tells you the size you got.`
  - New section after `## *client*.build`: `## *client*.poolSize` / `` `number`, readonly. The number of workers the pool runs: `poolSize` as requested, capped by the VFS and by the environment. Exact once every worker has opened or declined; every query waits for that, so it is settled by the time any query returns. ``
  - **`debug`** paragraph: `a permanently lost worker always warns` → `a permanently lost worker always warns, with the error that killed it`.
  - **`onWorkerLost`** paragraph: `the requested \`poolSize\`` → `the pool's size — [\`poolSize\`](#clientpoolsize), not the option —`, and append: `A worker the environment never let open is not lost: nothing is reported for it.`

- [ ] **Step 2: `VFS.md` prose**
  - `OPFSWriteAheadVFS` entry, the paragraph starting **Everywhere else it opens the handle exclusively and rotates it between workers.** becomes: `**Everywhere else it runs on a single worker.** A browser without \`readwrite-unsafe\` ignores the \`mode\` option rather than rejecting it, so the handle opens exclusively — and this VFS keeps it for the connection's whole life instead of handing it over. Only one connection can open, so the pool is capped at \`1\` there, which is [reduced mode](#reduced-mode) at its narrowest: no read is served while a statement runs.`
  - *Reduced mode*, first paragraph: `one exclusive handle rotated between workers instead of one held per connection` → `one exclusive handle instead of one per connection — rotated between workers by \`OPFSAdaptiveVFS\`, held by the single worker \`OPFSWriteAheadVFS\` runs on there`.
  - *Reduced mode*, `That covers \`OPFSAdaptiveVFS\` and \`OPFSWriteAheadVFS\` in reduced mode,` → `That covers \`OPFSAdaptiveVFS\` in reduced mode, and \`OPFSWriteAheadVFS\`, whose single worker is the whole pool there,`.
  - Run `pnpm docs:vfs && git diff --stat VFS.md` afterwards: the generated zones must be unchanged by the prose edits.

- [ ] **Step 3: `CHANGELOG.md`, `## Unreleased`**
  - *Fixed*: `**\`OPFSWriteAheadVFS\` no longer loses its workers on Firefox and Safari.** Without \`readwrite-unsafe\` it keeps its database file open exclusively, so only one worker can open it; the others failed at startup, each reported through \`onWorkerLost\` and a warning, with two console errors apiece. The pool is now capped at one worker there — silently, unless you passed \`poolSize\`, in which case it warns once. Where \`readwrite-unsafe\` exists nothing changes.`
  - *Fixed*: `**A worker that fails to open says why.** The error, \`onWorkerLost\`'s \`cause\` and the warning now carry the storage error behind it — \`NoModificationAllowedError: No modification allowed\`, for instance — where they said only \`sqlite3_open_v2\`.`
  - *Added*: `**\`db.poolSize\`**, the number of workers the pool runs: the \`poolSize\` option, capped by the VFS and by the environment.`
  - *Changed*: `\`WorkerLostEvent.size\` is the pool's size, \`db.poolSize\`, rather than the \`poolSize\` option; the two differ only where the environment caps the pool, which is new. The lost-worker warning ends with the error that killed the worker.`

- [ ] **Step 4: Commit — only when the user says so**

```bash
git add API.md VFS.md CHANGELOG.md
git commit -m "docs: a pool capped by its environment, and db.poolSize

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Final verification

- [ ] **Step 1: The baseline table, in one pass** — every row of `mem:state`'s table, re-read now, none carried forward:
  - `pnpm exec tsc --noEmit` — clean
  - `pnpm build` — clean
  - `pnpm test` — THREE reports, `status: pass` and `failedFiles: 0` on each; counts = the 2026-09-12 baseline (750/62 with 1 skip, 305/43 with 1 skip, 7/3) plus this branch's new tests; on Firefox T4 runs, on Chromium T4 is the second skip of the chromium config — say so when reporting, since the baseline expects exactly 1
  - `pnpm exec rstest --project unit run` — 446 + new
  - `pnpm test:conformance` — TWO reports, identical, 73 passed / 12 skipped each
  - `pnpm test:consumer` — 24/24
  - `BENCH_PORT=8123 node scripts/bench/check.mjs chromium --all` — OK, empty `reasons`, `poolSize` present
  - `pnpm lint` — 13 warnings, 1 info, or report the difference
- [ ] **Step 2: One Safari export read by hand.** After the user moves the `preview` tag (their gesture), they run the bench on Safari with `OPFSWriteAheadVFS`: the console shows no `lost` line and no wa-sqlite error pair, and the export's `poolSize` for that pair is `1`.
- [ ] **Step 3: Report**, with the numbers read, to the user. Merging and the memories belong to the closure procedure (`mem:conventions`), which the user calls.

---

## Addendum — pools that buy nothing (spec §10, user 2026-09-14)

Tasks 10-13 implement spec §10: `OPFSAdaptiveVFS` capped at one worker without
`readwrite-unsafe` (D8), `OPFSCoopSyncVFS` capped at one on every engine (D9), a generic cap
warning (D10), a `Shared` fact in the generated header (D11). **Order is load-bearing:** Task 10
moves the pool-mechanics tests off `OPFSAdaptiveVFS` while the code is unchanged, so that Task 11
can land the declarations green. Read spec §10 before either.

### Task 10: The pool-mechanics tests move to a VFS that keeps its pool on every engine

**Files:** `tests/browser/barrier.test.ts`, `tests/browser/writer-spread.test.ts`,
`tests/browser/lifecycle.test.ts`, `tests/browser/abandon-transaction.test.ts`,
`tests/browser/long-query.test.ts`, `tests/browser/tx-quiesce.test.ts`. No `src/` change.

**Interfaces:** none produced; Task 11 relies on these 12 tests passing on Firefox with
`OPFSAdaptiveVFS` capped.

**The 12 tests** — each failed on Firefox in the 2026-09-14 dry run with Adaptive capped (spec §10.3):

- `barrier.test.ts` — "commit-propagation barrier > sees a schema swap committed by another worker",
  "> sees a table dropped and replaced with a different shape", "> does not repeat the barrier on a
  worker that is already current", "> sends a read to the worker that just wrote, which owes no
  barrier", "barrier — two clients in one tab > client B observes client A's schema change",
  "> treats two spellings of one file as one database" (all: timeout, no assertion reached)
- `writer-spread.test.ts` — "writer spread > sends a write to a free worker while a read holds the
  preferred one", "> keeps results correct under writes and reads issued together" ("pool never
  reached READY")
- `lifecycle.test.ts` — "worker lifecycle — onWorkerLost callback > a throwing callback does not
  break the pool", "worker lifecycle — startup readiness gate > reports a slot that opened and
  then dies during the retry round as lost"
- `abandon-transaction.test.ts` — "an abandoned generator inside a transaction > commits, and
  evicts no worker"
- `long-query.test.ts` — "a long single step > does not terminate the worker it abandoned"
- `tx-quiesce.test.ts` — "the boundary of that wait > fails cleanly when the drop is never caught"

**The rule, test by test.** Read the test and the comment above it. If its subject is the pool's
machinery — scheduling, the writer designation, the commit barrier between connections,
evictions, the startup gate — it moves to `vfs: 'OPFSAnyContextVFS'`, which keeps a real pool on
every engine. If its subject is `OPFSAdaptiveVFS` itself (a comment names Adaptive's rotation or
handle as what is under test), it keeps Adaptive and becomes `(HAS_UNSAFE_HANDLES ? it : it.skip)`
with `HAS_UNSAFE_HANDLES` imported from `../conformance/helpers`, and the report names it. Where a
file sets the VFS once (a module constant or a helper), change it there only if every test that
uses it follows the same rule. Keep every existing comment, adding one line where the VFS changes:
`// OPFSAnyContextVFS: it keeps a pool on every engine; OPFSAdaptiveVFS runs one worker without
readwrite-unsafe (spec 2026-09-13, §10).`

- [ ] **Step 1: Migrate** the 12 tests by the rule.
- [ ] **Step 2: Green at HEAD's code, both engines.** Run the six files with
  `pnpm exec rstest --project chromium <files>` and `pnpm exec rstest --config rstest.firefox.config.ts <files>`.
- [ ] **Step 3: Green under Task 11's declaration, Firefox — a dry run, not a commit.** With Serena's
  `replace_content`, change `OPFSAdaptiveVFS`'s `singleConnectionWithout: [],` in `src/types.ts` to
  `singleConnectionWithout: ['readwrite-unsafe'] /* DRY RUN — revert */,`, run the six files on
  Firefox, then restore the line exactly and prove it: `grep -c 'DRY RUN' src/types.ts` prints 0
  and `git diff src/types.ts` is empty. Expected: every one of the 12 passes.
- [ ] **Step 4: Falsifiers.** For each file, try the existing `// Falsifiable:` mutation of one
  migrated test once and see it red on the new VFS; if a falsifier no longer bites there, say so
  in the report instead of weakening the test.
- [ ] **Step 5: Commit** — `pnpm exec tsc --noEmit`, `pnpm check`, the full `pnpm test` (three
  reports; baseline 780 / 320 / 7), then:

```bash
git add tests/browser/barrier.test.ts tests/browser/writer-spread.test.ts tests/browser/lifecycle.test.ts \
  tests/browser/abandon-transaction.test.ts tests/browser/long-query.test.ts tests/browser/tx-quiesce.test.ts
git commit -m "test: run the pool-mechanics tests on a VFS that keeps its pool on every engine

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Cap the pools that buy nothing

**Files:** `src/types.ts`, `src/client.ts` (`retireSlot`), `scripts/render-vfs-matrix.ts`, `VFS.md`
(generated zones only, by `pnpm docs:vfs`), `tests/unit/capabilities.test.ts`,
`tests/browser/vfs.test.ts`, `tests/browser/pool-cap.test.ts`, `tests/browser/coopsync-retry.test.ts`.

**Interfaces:** consumes Task 10's migration. Produces `OPFSAdaptiveVFS.singleConnectionWithout =
['readwrite-unsafe']`, `OPFSCoopSyncVFS.maxPoolSize = 1`.

- [ ] **Step 1: Tests first.**
  - `tests/unit/capabilities.test.ts`: the test "caps OPFSWriteAheadVFS and nothing else" becomes
    "caps OPFSWriteAheadVFS and OPFSAdaptiveVFS, and nothing else", expecting
    `['OPFSWriteAheadVFS', 'OPFSAdaptiveVFS']`, its falsifier comment naming "remove
    OPFSAdaptiveVFS's declaration". Add, beside it:

    ```ts
    // Falsifiable: set OPFSCoopSyncVFS's maxPoolSize back to null (spec 2026-09-13, §10, D9).
    it('caps OPFSCoopSyncVFS at one worker on every engine', () => {
      expect(VFS_CAPABILITIES.OPFSCoopSyncVFS.maxPoolSize).toBe(1);
      expect(VFS_CAPABILITIES.OPFSCoopSyncVFS.multiConnection).toBe(true);
    });
    ```
  - `tests/browser/vfs.test.ts`: a `describe('OPFSCoopSyncVFS pool guard', …)` mirroring
    `'AccessHandlePoolVFS pool guard'`'s first two tests — an explicit `poolSize: 2` throws
    `/pool sizes greater than 1/`; omitted, it opens, serves a query, and `db.poolSize` is `1`.
  - `tests/browser/pool-cap.test.ts`, T3 becomes:

    ```ts
    // T3. Falsifiable: remove OPFSAdaptiveVFS's singleConnectionWithout — Firefox then keeps 4.
    it('caps OPFSAdaptiveVFS too without readwrite-unsafe: a second worker would only wait its turn', async () => {
      const lost: number[] = [];
      const db = await createTestClient({
        vfs: 'OPFSAdaptiveVFS',
        poolSize: 4,
        onWorkerLost: ({ index }) => lost.push(index),
      });
      await db.write('CREATE TABLE t (a)');
      expect(db.poolSize).toBe(CAPPED ? 1 : 4);
      expect(lost).toEqual([]);
      await db.close();
    });
    ```
  - `tests/browser/coopsync-retry.test.ts`: the client with `poolSize: 4` becomes **two clients on
    the same file**, each with the default pool, and the existing mixed batch is split across both
    and issued at once. Keep the file's header, adding a dated paragraph: since spec §10 (D9) a
    client runs CoopSync on one worker, so the handle transfer now happens between clients — which
    is what tabs do. Then run the retry's falsifier (find the COOPSYNC-BUSY retry in `src/` by its
    comment) on both engines, several times. If no shape across two or three clients turns red with
    the retry removed, keep the test, state in its header that it no longer has a falsifier, and
    report DONE_WITH_CONCERNS with what was tried — do not delete the test.
  - Run the four test files and see the new expectations fail where the code is unchanged.
- [ ] **Step 2: `src/types.ts`.**
  - `OPFSAdaptiveVFS`: `singleConnectionWithout: ['readwrite-unsafe'],`.
  - `OPFSCoopSyncVFS`: `maxPoolSize: 1,` and
    `poolLimitReason: 'it rotates one exclusive access handle between connections, so another worker only waits its turn',`
    — `multiConnection` stays `true`. Above `maxPoolSize`, the comment:
    `// Capped on every engine (spec 2026-09-13, §10, D9): a pool of one was faster at startup and on bursts of reads, equal elsewhere, on Chromium and Firefox (POOL-SIZE, 2026-09-14). The handle still rotates between clients and tabs, which is why the COOPSYNC-BUSY retry stays.`
  - The doc comment of `singleConnectionWithout` becomes:

    ```ts
      /**
       * Platform features without which a pool of more than one worker buys this
       * VFS nothing, so it runs on one (spec 2026-09-13, §3 and §10). Either the
       * VFS holds its database file exclusively for a connection's whole life and
       * a second worker cannot open at all (`OPFSWriteAheadVFS`), or it rotates one
       * exclusive access handle between connections and a second worker only waits
       * its turn (`OPFSAdaptiveVFS` — measured 2026-09-14 on Firefox: a pool of one
       * was faster at startup and on bursts of reads, and equal everywhere else).
       * The pool's surplus workers probe the feature before loading anything and
       * decline (`src/worker/probes.ts`); every feature listed needs a probe there.
       */
    ```
- [ ] **Step 3: `src/client.ts`, `retireSlot`.** The message becomes
  `` `${vfs} gains nothing from more than one worker without ${missing}: pool capped at 1 of ${poolSize}` ``.
  `tests/browser/pool-cap.test.ts` T1's assertions (`without readwrite-unsafe`, `pool capped at 1 of 4`)
  still hold; change nothing there.
- [ ] **Step 4: `scripts/render-vfs-matrix.ts`.** Replace the guard that throws when
  `(cap.maxPoolSize === null) !== cap.multiConnection` — and the comment above it — with:

  ```ts
    // A pool worker is a connection, so an unbounded pool and sharing between
    // connections are usually one fact and the header states it once, as the pool
    // size. They diverge where a pool is capped for another reason than sharing —
    // OPFSCoopSyncVFS runs one worker because it rotates one handle, yet shares its
    // database across tabs (spec 2026-09-13, §10, D11) — and only there does the
    // header add a `Shared` fact.
    const shared =
      (cap.maxPoolSize === null) !== cap.multiConnection
        ? `**Shared:** ${cap.multiConnection ? 'yes' : 'no'}`
        : null;
  ```

  and make the facts array `[`**Pool size:** ${pool}`, ...(shared ? [shared] : []), `**RAM:** …`]`.
  Run `pnpm docs:vfs` and put the whole `git diff VFS.md` in the report. Expected: Adaptive's header
  `Any, 1 without \`readwrite-unsafe\``; CoopSync's `**1**` with a pool footnote and `**Shared:** yes`;
  the VFS table's Pool cell for CoopSync changes; footnote numbers may shift. Anything else: stop and report.
- [ ] **Step 5: Everything green.** `pnpm exec tsc --noEmit`; `pnpm check`; the unit project; the
  four test files on both engines; `pnpm test:conformance` (expect 14 skipped per engine, identical);
  the full `pnpm test` (three reports). Try every new falsifier once.
- [ ] **Step 6: Commit.**

```bash
git add src/types.ts src/client.ts scripts/render-vfs-matrix.ts VFS.md tests/unit/capabilities.test.ts \
  tests/browser/vfs.test.ts tests/browser/pool-cap.test.ts tests/browser/coopsync-retry.test.ts
git commit -m "fix(types): cap the pools that buy nothing — OPFSAdaptiveVFS without readwrite-unsafe, OPFSCoopSyncVFS everywhere

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Documentation — inline, with the user

Not dispatched; proposed, shown, iterated, committed on the user's word. `API.md`: the
**`poolSize` delays your first query** paragraph names both environment caps and CoopSync's
declared one. `VFS.md` prose: the `OPFSAdaptiveVFS` entry (one worker per client without
`readwrite-unsafe`; the lazy close and reopen now serves clients and tabs), the `OPFSCoopSyncVFS`
entry (a pool of one; the rotation and its stalls are between clients and tabs), *Reduced mode*
and *Concurrent reads*. `CHANGELOG.md`: *Breaking* — `OPFSCoopSyncVFS` refuses a `poolSize` above
1; *Changed* — `OPFSAdaptiveVFS` runs one worker without `readwrite-unsafe`, and the cap warning's
wording. `pnpm docs:vfs` must leave the generated zones as Task 11 left them.

### Task 13: Verification

The baseline table of `mem:state` in one pass (as Task 9), and a Safari export read by hand once
the user moves the `preview` tag: `poolSize` is `1` for `OPFSWriteAheadVFS`, `OPFSAdaptiveVFS` and
`OPFSCoopSyncVFS`, and no `lost` line or wa-sqlite error pair appears.
