# A second client, on every VFS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every VFS tells a second client on the same database what it is meant to — shared, isolated, or refused fast with `DATABASE_IN_USE` — and the browser suite proves it on every VFS, with the single-VFS tests running on both recommended VFS.

**Architecture:** A new capability field, `exclusiveConnectionWithout`, makes `OPFSWriteAheadVFS` take `bsq:conn` exclusively where the engine lacks `readwrite-unsafe`. That feature cannot be probed from the page, so worker 0 probes it before opening and waits for the client's `proceed`; the answer is memoised per realm so clients built together request the lock in construction order. A test helper derives each VFS's second-client outcome from `VFS_CAPABILITIES`; a matrix runs it over every (vfs, build) pair on both engines, and the multi-client and cross-tab suites loop over the VFS whose outcome is "shared".

**Tech Stack:** TypeScript 7 (`tsc`), rstest 0.11.8 + Playwright (Chromium, Firefox), wa-sqlite (vendored), Web Locks, OPFS.

**Spec:** `docs/superpowers/specs/2026-09-15-second-client-design.md` — read it whole, amendments §10 included. The plan argues from it.

## Global Constraints

- Branch `fix/second-client`. Every commit lands on green: a failing test and the code that satisfies it belong to the same task.
- Files in English; chat with the user in French.
- **Serena's symbolic tools are primary for code** (`get_symbols_overview`, `find_symbol`, `replace_symbol_body`, `insert_after_symbol`, `replace_content`, `replace_in_files`). Built-in Read/Edit on code only as a fallback. Read/Edit are fine for `.md`, JSON, config.
- `pnpm check` after every modification.
- **Never** `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`. Run `pnpm exec tsc --noEmit` yourself before each commit. If the hook fails, stop and report its output verbatim. After committing, confirm with `git log --oneline -1` and `git show --stat HEAD`.
- rstest 0.11.8 has **no `it.each`**: parameterise with `for` loops calling `describe`/`it`. Conditional skips are `it.skip(title, () => {})` + `continue`, as in `tests/conformance/invariants.test.ts`.
- `browserLogs: false`: `console.log` from a browser test is invisible. A probe surfaces its numbers through a deliberately failing assertion, `expect(JSON.stringify(result)).toBe('')`.
- Probes are throwaway. Their source lives in `.scratchpad/second-client-2026-09-15/`; to run, copy one into `tests/browser/`, run it, save the raw output beside the source, and delete the copy. Nothing in `src/`, `tests/` or CI may depend on `.scratchpad/`.
- Single-file runs: `pnpm exec rstest --project chromium run <path>` and `pnpm exec rstest --config rstest.firefox.config.ts run <path>`. `pnpm test` chains three configs and prints THREE reports — read all three.
- A falsifier is **run, not reasoned**: delete or mutate the line, observe red, restore (`git diff` must show nothing left of the mutation), observe green, and report both runs.
- Do not accept "pre-existing" for a red without checking it on the base commit (`git stash` is NOT allowed; use `git worktree add .work/base <sha>` if a base run is needed).
- `CHANGELOG.md`: the unreleased section only. No version bump.

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | `VFSCapability.exclusiveConnectionWithout` and its values; protocol messages `probeFirst` (open), `proceed` (client → worker), `probed` (worker → client); the stale `exclusiveConnection` JSDoc (`BUSY` → `DATABASE_IN_USE`) |
| `src/worker/worker.ts` | Worker 0 probes, posts `probed`, opens nothing until `proceed`; a `close` while waiting is answered at once |
| `src/pool.ts` | Relays `probeFirst` to the worker and `probed` to the client, with the `proceed` function |
| `src/client.ts` | The per-realm memo, the connection lock's mode decided from the answer, `connRefused`, `inUse()`, `proceed` once lock and probe are both in, `failClient`/`close()` settling the answer |
| `tests/unit/capabilities.test.ts` | The declaration's invariants |
| `tests/browser/helpers/vfs-contract.ts` (new) | `secondClientOutcome(vfs)`; later `SHARED_VFS` |
| `tests/browser/second-client.test.ts` (new) | The matrix; the close-before-probe test |
| `scripts/recommended-vfs.ts` (new) | `RECOMMENDED_VFS`, side-effect free, read by the renderer and the tests |
| `scripts/render-vfs-matrix.ts` | Imports the list; a `Clients` fact in the per-VFS header |
| `tests/browser/multi-client.test.ts`, `cross-tab.test.ts` | Looped over `SHARED_VFS` |
| `tests/browser/helpers.ts` | `createTestClient` requires `vfs`; cleanup removes sidecars |
| ~34 browser test files | Both recommended VFS, or a written `// One VFS:` exception |
| `VFS.md`, `CHANGELOG.md` | Consumer documentation |

---

### Task 1: The dry run — the suite forced onto `OPFSWriteAheadVFS`

Measures step 3's cost and lists the reds it will meet, before anything is written. Nothing is committed.

**Files:**
- Modify temporarily: `tests/browser/helpers.ts` (restored at the end)
- Create: `.scratchpad/second-client-2026-09-15/dry-run.md`

- [ ] **Step 1: Baseline runs on the untouched tree**

```bash
mkdir -p .scratchpad/second-client-2026-09-15
pnpm exec rstest --project chromium run 2>&1 | tee .scratchpad/second-client-2026-09-15/base-chromium.txt | tail -15
pnpm exec rstest --config rstest.firefox.config.ts run 2>&1 | tee .scratchpad/second-client-2026-09-15/base-firefox.txt | tail -15
```
Expected: both green; note tests, files, skips and duration of each.

- [ ] **Step 2: Force the default**

In `createTestClient` (`tests/browser/helpers.ts`), change `options.vfs ?? 'OPFSAdaptiveVFS'` to `options.vfs ?? 'OPFSWriteAheadVFS'`. Nothing else.

- [ ] **Step 3: Run both engines**

```bash
pnpm exec rstest --project chromium run 2>&1 | tee .scratchpad/second-client-2026-09-15/dry-chromium.txt | tail -40
pnpm exec rstest --config rstest.firefox.config.ts run 2>&1 | tee .scratchpad/second-client-2026-09-15/dry-firefox.txt | tail -40
```

- [ ] **Step 4: Restore and prove it**

```bash
git checkout -- tests/browser/helpers.ts && git status --short
```
Expected: `git status --short` prints nothing but untracked `.scratchpad` content (ignored) — the tree is clean.

- [ ] **Step 5: Write `dry-run.md`**

For each engine: duration against the baseline; every failing test by file and title, with the first line of its error; for each, a one-line first reading — *calibration* (e.g. a timeout test on the `sync` build, which cannot interrupt a running statement — `mem:lessons` 2026-09-15), *two workers expected* (the VFS runs one on Firefox), or *unexplained*. Do not fix anything. Report the file's content in the task report.

---

### Task 2: The defect, characterised before the guard

The spec's three unmeasured points (§6) and the open latency "before". Nothing is committed.

**Files:**
- Create: `.scratchpad/second-client-2026-09-15/second-client-probe.test.ts` (copied into `tests/browser/` only to run)

- [ ] **Step 1: Write the probe**

```ts
// THROWAWAY — spec 2026-09-15 §6. Never commit into tests/.
import { expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { VFS_CAPABILITIES } from '../../src/types';

const vfs = 'OPFSWriteAheadVFS' as const;
const N = 10;
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; name?: string; message?: string }) =>
      `${e?.code ?? e?.name}: ${String(e?.message).slice(0, 140)}`,
  );

for (const build of VFS_CAPABILITIES[vfs].builds) {
  for (const shape of ['together', 'after'] as const) {
    it(`${build} ${shape}`, async () => {
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < N; i += 1) {
        const file = `probe-${crypto.randomUUID()}`;
        const options = { vfs, build, openTimeout: 5000 };
        const a = createSQLiteClient(file, options);
        let b = shape === 'together' ? createSQLiteClient(file, options) : undefined;
        const aCreate = await outcome(a.write('CREATE TABLE t (n)'));
        b ??= createSQLiteClient(file, options);
        const bRead = await outcome(b.read('SELECT count(*) AS n FROM t'));
        const aAfter = await outcome(a.write('INSERT INTO t VALUES (1)'));
        await a.close().catch(() => {});
        const bAfterClose = await outcome(b.read('SELECT count(*) AS n FROM t'));
        const c = createSQLiteClient(file, options);
        const cRead = await outcome(c.read('SELECT count(*) AS n FROM t'));
        for (const x of [b, c]) await x.close().catch(() => {});
        await deleteDatabase(file, { vfs, build }).catch(() => {});
        rows.push({ i, aCreate, bRead, aAfter, bAfterClose, cRead });
      }
      expect(JSON.stringify(rows)).toBe('');
    }, 180_000);
  }
}

it('latency: createSQLiteClient to a resolved SELECT 1', async () => {
  const ms: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const file = `probe-${crypto.randomUUID()}`;
    const started = performance.now();
    const db = createSQLiteClient(file, { vfs });
    await db.read('SELECT 1');
    ms.push(Math.round(performance.now() - started));
    await db.close();
    await deleteDatabase(file, { vfs }).catch(() => {});
  }
  const sorted = [...ms].sort((x, y) => x - y);
  expect(JSON.stringify({ ms, median: sorted[10] })).toBe('');
}, 120_000);
```

- [ ] **Step 2: Run on both engines**

```bash
D=.scratchpad/second-client-2026-09-15
cp $D/second-client-probe.test.ts tests/browser/
pnpm exec rstest --project chromium run tests/browser/second-client-probe.test.ts > $D/probe-before-chromium.txt 2>&1
pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/second-client-probe.test.ts > $D/probe-before-firefox.txt 2>&1
rm tests/browser/second-client-probe.test.ts && git status --short
```
Every probe test "fails" by design; the JSON is in its assertion message.

- [ ] **Step 3: Read and report**

Tabulate per engine × build × shape: how often B served, how B failed (code, message head), whether A's `aCreate`/`aAfter` ever failed (what the first client sees), `bAfterClose` (does B recover), `cRead` (does a new client open), and the latency median.

**STOP and report to the user before Task 4** if any Firefox row shows `bRead: ok` (a second client served, contradicting the premise of D2), or if A ever fails — the design is to be confronted with it first.

---

### Task 3: The declaration

**Files:**
- Modify: `src/types.ts` (`VFSCapability`, `VFS_CAPABILITIES`)
- Test: `tests/unit/capabilities.test.ts`

**Interfaces:**
- Produces: `VFSCapability.exclusiveConnectionWithout: readonly PlatformFeature[]` — `['readwrite-unsafe']` on `OPFSWriteAheadVFS`, `[]` on the eight others.

- [ ] **Step 1: Write the failing tests**

Insert after the `describe('singleConnectionWithout', …)` block of `tests/unit/capabilities.test.ts` (`WORKER_PROBES` is already imported there):

```ts
describe('exclusiveConnectionWithout', () => {
  // Falsifiable: remove OPFSWriteAheadVFS's declaration, or declare one on
  // OPFSAdaptiveVFS — which shares its database across tabs.
  it('makes OPFSWriteAheadVFS alone exclusive where a feature is missing', () => {
    const declared = Object.entries(VFS_CAPABILITIES)
      .filter(([, cap]) => cap.exclusiveConnectionWithout.length > 0)
      .map(([name]) => name);
    expect(declared).toEqual(['OPFSWriteAheadVFS']);
    expect(VFS_CAPABILITIES.OPFSWriteAheadVFS.exclusiveConnectionWithout).toEqual([
      'readwrite-unsafe',
    ]);
  });

  // Falsifiable: declare `exclusiveConnectionWithout: ['opfs']` on any VFS —
  // worker 0 has no probe for it, so the lock's mode could never be decided.
  it('names only features a worker can probe', () => {
    for (const cap of Object.values(VFS_CAPABILITIES)) {
      for (const feature of cap.exclusiveConnectionWithout) {
        expect(feature in WORKER_PROBES).toBe(true);
      }
    }
  });

  // Falsifiable: remove 'readwrite-unsafe' from OPFSWriteAheadVFS's
  // singleConnectionWithout. The client spawns its whole pool at once and only
  // worker 0 waits for the connection lock (spec 2026-09-15, A2); a surplus
  // worker is kept off the file by declining on that list.
  it('is covered by singleConnectionWithout', () => {
    for (const cap of Object.values(VFS_CAPABILITIES)) {
      for (const feature of cap.exclusiveConnectionWithout) {
        expect(cap.singleConnectionWithout).toContain(feature);
      }
    }
  });

  // Falsifiable: set exclusiveConnection: true on OPFSWriteAheadVFS.
  it('is never combined with exclusiveConnection', () => {
    for (const cap of Object.values(VFS_CAPABILITIES)) {
      if (cap.exclusiveConnection) {
        expect(cap.exclusiveConnectionWithout).toEqual([]);
      }
    }
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm exec rstest --project unit run tests/unit/capabilities.test.ts`
Expected: FAIL — `cap.exclusiveConnectionWithout` is undefined.

- [ ] **Step 3: Declare the field**

In `VFSCapability` (`src/types.ts`), insert after `readonly exclusiveConnection: boolean;`:

```ts
  /**
   * Platform features without which this VFS holds its database file
   * exclusively for a connection's whole life, across the origin — so the
   * client takes `bsq:conn` exclusively, as for `exclusiveConnection`, and a
   * second client gets `DATABASE_IN_USE` (spec 2026-09-15).
   *
   * `OPFSWriteAheadVFS` without `readwrite-unsafe`: upstream's VFS requires the
   * mode and keeps its three access handles for the connection's life, so
   * nothing else can open the file — every query of a second client failed
   * with WORKER_CRASHED on Firefox, 20/20 per shape (2026-09-15).
   *
   * The page cannot probe these features, so worker 0 probes them before
   * opening (`src/worker/probes.ts`): every feature listed needs a probe there,
   * and must also be in `singleConnectionWithout`, whose surplus workers
   * decline before they touch the file.
   */
  readonly exclusiveConnectionWithout: readonly PlatformFeature[];
```

In the same type, fix the stale sentence of `exclusiveConnection`'s JSDoc: replace `A second client that attempts to open the same database receives \`BUSY\`` with `A second client that attempts to open the same database receives \`DATABASE_IN_USE\``.

In `VFS_CAPABILITIES`, add the field after each entry's `exclusiveConnection` line: `exclusiveConnectionWithout: ['readwrite-unsafe'],` on `OPFSWriteAheadVFS`, `exclusiveConnectionWithout: [],` on the eight others (a `replace_content` regex on `exclusiveConnection: (true|false),\n` does it in one pass; then fix `OPFSWriteAheadVFS` by hand).

- [ ] **Step 4: Run to see it pass**

Run: `pnpm exec rstest --project unit run tests/unit/capabilities.test.ts && pnpm exec tsc --noEmit && pnpm check`
Expected: PASS, no type error.

- [ ] **Step 5: Run each falsifier named in the four comments** (Global Constraints), report red/green pairs.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts tests/unit/capabilities.test.ts
git commit -m "feat(types): exclusiveConnectionWithout — one client at a time without a feature

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3b: A write transaction begins IMMEDIATE (inserted 2026-09-15, user)

Found by Task 1 and diagnosed the same day (spec §10, A4): `OPFSWriteAheadVFS` refuses a write transaction that did not announce itself at `BEGIN` — `jLock` throws `Write transaction cannot use BEGIN DEFERRED` (`node_modules/wa-sqlite/src/examples/OPFSWriteAheadVFS.js:453-457`) — so a transaction whose first statement reads, or runs a write that changes nothing, fails with `STATEMENT_FAILED` "disk I/O error" (extended code 778, or 3850 on an empty file), and the client stays unusable afterwards. `transaction()` issues a plain, deferred `BEGIN` (`src/transaction.ts:853`). `output()`'s swap transaction starts with `DROP TABLE IF EXISTS <target>`, which writes nothing when the target does not exist, so `output()` fails on that VFS. Probes: `.scratchpad/second-client-2026-09-15/output-writeahead-probe{,2,3,4}.test.ts`.

**Files:**
- Create: `tests/browser/transaction-begin.test.ts`
- Modify: `src/transaction.ts` (the `BEGIN` line and its comment), `tests/unit/transaction.test.ts`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `ALL_VFS`, `missingHere` from `tests/conformance/helpers.ts`; `deleteDatabase` from `src/delete.ts`.
- Produces: nothing later tasks import. Behaviour: a transaction with `readOnly: false` (the default) sends `BEGIN IMMEDIATE`; `readOnly: true` sends `BEGIN`.

- [ ] **Step 1: The failing browser test**

Create `tests/browser/transaction-begin.test.ts`:

```ts
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import {
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';
import { ALL_VFS, missingHere } from '../conformance/helpers';

/**
 * A transaction whose first statement does not write, on every VFS and every
 * build this browser can run (spec 2026-09-15, A4).
 *
 * OPFSWriteAheadVFS refuses a write transaction that did not announce itself at
 * BEGIN — "Write transaction cannot use BEGIN DEFERRED" — and the client stayed
 * unusable afterwards. `output()`'s swap starts with a DROP TABLE IF EXISTS that
 * writes nothing when the target is new, so `output()` failed there too.
 * Nothing caught it: every transaction test wrote first, and on one VFS.
 */

type Db = ReturnType<typeof createSQLiteClient>;

const SHAPES: Record<string, { run: (db: Db) => Promise<unknown>; after: string; rows: number }> = {
  'reads, then writes': {
    run: (db) =>
      db.transaction(async (tx) => {
        await tx.read('SELECT n FROM t');
        await tx.write('INSERT INTO t VALUES (2)');
      }),
    after: 'SELECT count(*) AS n FROM t',
    rows: 2,
  },
  'runs a write that changes nothing, then writes': {
    run: (db) =>
      db.transaction(async (tx) => {
        await tx.write('DROP TABLE IF EXISTS missing');
        await tx.write('INSERT INTO t VALUES (2)');
      }),
    after: 'SELECT count(*) AS n FROM t',
    rows: 2,
  },
  'output() creates a table that does not exist yet': {
    run: async (db) => {
      const out = db.output('o', { n: 'INTEGER' });
      out.enqueue({ n: 1 });
      await out.close();
    },
    after: 'SELECT count(*) AS n FROM o',
    rows: 1,
  },
  'a readOnly transaction still reads': {
    run: (db) =>
      db.transaction(
        async (tx) => {
          await tx.read('SELECT n FROM t');
        },
        { readOnly: true },
      ),
    after: 'SELECT count(*) AS n FROM t',
    rows: 1,
  },
};

const fresh = (vfs: SQLiteVFS, build: SQLiteBuild) => {
  const file = `transaction-begin-${crypto.randomUUID()}`;
  const db = createSQLiteClient(file, { vfs, build });
  onTestFinished(async () => {
    try {
      await db.close();
    } catch {
      /* a failed client has nothing to close */
    }
    try {
      await deleteDatabase(file, { vfs, build });
    } catch {
      /* never created */
    }
  });
  return db;
};

for (const vfs of ALL_VFS) {
  describe(`${vfs}: a transaction that does not write first`, () => {
    for (const build of VFS_CAPABILITIES[vfs].builds) {
      const missing = missingHere(vfs, build);
      for (const [shape, { run, after, rows }] of Object.entries(SHAPES)) {
        const title = `${build}: ${shape}`;
        if (missing !== null) {
          it.skip(`${title} — skipped, no ${missing} in this browser`, () => {});
          continue;
        }
        it(title, async () => {
          const db = fresh(vfs, build);
          await db.write('CREATE TABLE t (n)');
          await db.write('INSERT INTO t VALUES (1)');
          await run(db);
          // The client is still usable: the failure left it broken for good.
          const [row] = await db.read<{ n: number }>(after);
          expect(row?.n).toBe(rows);
        });
      }
    }
  });
}
```

- [ ] **Step 2: Run it red**

```bash
timeout 300 pnpm exec rstest --project chromium run tests/browser/transaction-begin.test.ts
timeout 300 pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/transaction-begin.test.ts
```
Expected: red on `OPFSWriteAheadVFS`'s first three shapes, every build, both engines — `STATEMENT_FAILED`; green everywhere else. **Any other red: stop and report it.**

- [ ] **Step 3: The fix**

In `src/transaction.ts`, replace `await exec(via(false), 'BEGIN');` with:

```ts
        // A write transaction announces itself: OPFSWriteAheadVFS refuses one
        // that reaches its first write from a deferred BEGIN — "Write
        // transaction cannot use BEGIN DEFERRED" — and the client stayed broken
        // afterwards (spec 2026-09-15, A4). The origin write lock is already
        // held here, so IMMEDIATE only moves SQLite's RESERVED lock to the start
        // of a transaction no other writer can be in. A read-only one stays
        // deferred: it takes no write lock and must not ask SQLite for one.
        await exec(via(false), readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
```
and prepend to the long comment above it that it concerns `BEGIN` in both forms.

- [ ] **Step 4: Unit tests**

In `tests/unit/transaction.test.ts`, every expectation of the SQL a write transaction sends (`'BEGIN'` in `worker.executed` arrays and in `fakeWorker([...])` scripts) becomes `'BEGIN IMMEDIATE'`; those of a `readOnly: true` transaction stay `'BEGIN'` — read each test to decide, never by blind replace. Add:

```ts
  // Falsifiable: send 'BEGIN' for every transaction in src/transaction.ts, or
  // 'BEGIN IMMEDIATE' for every one (spec 2026-09-15, A4).
  it('begins a write transaction IMMEDIATE and a read-only one deferred', async () => {
    // Build both with the file's existing fakeWorker/createTransaction helpers,
    // run one statement in each, and assert
    //   write:    worker.executed[0] === 'BEGIN IMMEDIATE'
    //   readOnly: worker.executed[0] === 'BEGIN'
  });
```
(Write it with the helpers the file already uses — read how the neighbouring tests build a transaction; the comment above states exactly what to assert.)

- [ ] **Step 5: Run green**

```bash
pnpm exec tsc --noEmit && pnpm check
pnpm exec rstest --project unit run tests/unit/transaction.test.ts
timeout 300 pnpm exec rstest --project chromium run tests/browser/transaction-begin.test.ts tests/browser/transaction.test.ts tests/browser/output.test.ts tests/browser/tx-write.test.ts tests/browser/multi-client.test.ts
timeout 300 pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/transaction-begin.test.ts tests/browser/transaction.test.ts tests/browser/output.test.ts tests/browser/tx-write.test.ts tests/browser/multi-client.test.ts
```
Expected: all green on both engines.

- [ ] **Step 6: Falsifiers, run**

1. Put back `'BEGIN'` for every transaction → the WriteAhead rows of `transaction-begin.test.ts` red on both engines, and the new unit test red. Restore.
2. Send `'BEGIN IMMEDIATE'` for `readOnly` too → the new unit test red. Restore.

- [ ] **Step 7: `CHANGELOG.md`**, unreleased section, under the fixes heading (create `### Fixed` after `### Breaking` if none exists):

```md
- **A transaction that reads before it writes no longer breaks `OPFSWriteAheadVFS`.** That VFS refuses a write transaction that did not announce itself when it began, and `transaction()` began every transaction deferred: a callback whose first statement read — or ran a write that changed nothing — failed with `STATEMENT_FAILED` ("disk I/O error") and left the client unusable. `output()` failed on that VFS for the same reason whenever its target table did not exist yet. A write transaction now begins `IMMEDIATE`; a `readOnly` one still begins deferred.
```

- [ ] **Step 8: Full suite and commit**

```bash
pnpm exec tsc --noEmit && pnpm check && pnpm test
git add src/transaction.ts tests/unit/transaction.test.ts tests/browser/transaction-begin.test.ts CHANGELOG.md
git commit -m "fix(transaction): a write transaction begins IMMEDIATE

OPFSWriteAheadVFS refuses a write transaction that reaches its first write
from a deferred BEGIN, and the client stayed broken afterwards; output()
hit it through its swap's DROP TABLE IF EXISTS.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
Every `pnpm test` run wrapped in nothing: it runs three configs in sequence; if one hangs past 10 min, kill it, record it, rerun once.

---

### Task 4: The matrix, red; the guard, green

**Files:**
- Create: `tests/browser/helpers/vfs-contract.ts`, `tests/browser/second-client.test.ts`
- Modify: `src/types.ts` (protocol), `src/worker/worker.ts`, `src/pool.ts`, `src/client.ts`

**Interfaces:**
- Consumes: `VFSCapability.exclusiveConnectionWithout` (Task 3); `ALL_VFS`, `AVAILABLE_FEATURES`, `missingHere` from `tests/conformance/helpers.ts`; `firstMissing` from `src/worker/probes.ts`.
- Produces: `secondClientOutcome(vfs: SQLiteVFS): 'shared' | 'isolated' | 'refused'` and `type SecondClientOutcome` in `tests/browser/helpers/vfs-contract.ts`. Protocol: `open.probeFirst?: readonly PlatformFeature[]`; `{ type: 'proceed'; callId: number }` (client → worker); `{ type: 'probed'; callId: number; missing: PlatformFeature | null }` (worker → client). `createPoolWorker` deps `probeFirst?` and `onProbed?: (missing: PlatformFeature | null, proceed: () => void) => void`.

- [ ] **Step 1: The outcome helper**

Create `tests/browser/helpers/vfs-contract.ts`:

```ts
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../../src/types';
import { AVAILABLE_FEATURES } from '../../conformance/helpers';

export type SecondClientOutcome = 'shared' | 'isolated' | 'refused';

/**
 * What a second client on the same database gets from `vfs` in this browser
 * (spec 2026-09-15, D3). Derived from `VFS_CAPABILITIES` and never listed by
 * hand: a hand list is a second copy of the truth, and it drifts.
 *
 * - `isolated`: the memory VFS — two clients on one name are two databases.
 * - `refused`: the VFS is exclusive here — `DATABASE_IN_USE`, fast.
 * - `shared`: everything else — each client reads what the other wrote.
 *   `IDBMirrorVFS` is counted here; its behaviour under load across clients
 *   is measured, not asserted (spec §6).
 */
export const secondClientOutcome = (vfs: SQLiteVFS): SecondClientOutcome => {
  const cap = VFS_CAPABILITIES[vfs];
  if (cap.layout === 'memory') return 'isolated';
  if (cap.exclusiveConnection) return 'refused';
  if (cap.exclusiveConnectionWithout.some((f) => !AVAILABLE_FEATURES.has(f))) {
    return 'refused';
  }
  return 'shared';
};
```

- [ ] **Step 2: The matrix**

Create `tests/browser/second-client.test.ts`:

```ts
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient, type WorkerLostEvent } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { SQLiteError } from '../../src/errors';
import {
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';
import { ALL_VFS, missingHere } from '../conformance/helpers';
import { secondClientOutcome } from './helpers/vfs-contract';

/**
 * What a second client on the same database gets, for every VFS and every
 * build this browser can run (spec 2026-09-15, §4.1).
 *
 * Two clients in one page contend exactly as two tabs do: Web Locks, OPFS
 * access handles and IndexedDB are all origin-wide. The expectation is never
 * written here — `secondClientOutcome` derives it from `VFS_CAPABILITIES`, so a
 * VFS whose declaration stops matching what it does turns this file red.
 * `OPFSWriteAheadVFS` refused every second client on Firefox with
 * WORKER_CRASHED through the whole of rc.5's multi-client work, while every
 * multi-client test ran on one VFS.
 */

/** A refusal is fast or it is not one: AHP-2TAB's broken client looked healthy. */
const REFUSED_WITHIN = 3000;

const values = (rows: { n: number }[]) => rows.map((row) => row.n);

const oneDatabase = (vfs: SQLiteVFS, build: SQLiteBuild) => {
  const file = `second-client-${crypto.randomUUID()}`;
  const losses: string[] = [];
  const clients: ReturnType<typeof createSQLiteClient>[] = [];
  const open = (label: string) => {
    const client = createSQLiteClient(file, {
      vfs,
      build,
      onWorkerLost: ({ index, cause }: WorkerLostEvent) => {
        losses.push(`${label} worker ${index + 1}: ${cause.message}`);
      },
    });
    clients.push(client);
    return client;
  };
  onTestFinished(async () => {
    for (const client of clients) {
      try {
        await client.close();
      } catch {
        /* a failed client has nothing to close */
      }
    }
    try {
      await deleteDatabase(file, { vfs, build });
    } catch {
      /* never created, or already gone */
    }
  });
  return { file, open, losses };
};

for (const vfs of ALL_VFS) {
  const outcome = secondClientOutcome(vfs);
  describe(`${vfs}: a second client is ${outcome}`, () => {
    for (const build of VFS_CAPABILITIES[vfs].builds) {
      const missing = missingHere(vfs, build);
      for (const shape of ['together', 'after'] as const) {
        const title = `${build}, built ${shape === 'together' ? 'together' : 'after the first write'}`;
        if (missing !== null) {
          it.skip(`${title} — skipped, no ${missing} in this browser`, () => {});
          continue;
        }
        it(title, async () => {
          const { file, open, losses } = oneDatabase(vfs, build);
          const a = open('A');
          let b = shape === 'together' ? open('B') : undefined;
          await a.write('CREATE TABLE t (n)');
          await a.write('INSERT INTO t VALUES (1)');
          b ??= open('B');

          if (outcome === 'shared') {
            expect(values(await b.read<{ n: number }>('SELECT n FROM t'))).toEqual([1]);
            await b.write('INSERT INTO t VALUES (2)');
            expect(
              values(await a.read<{ n: number }>('SELECT n FROM t ORDER BY n')),
            ).toEqual([1, 2]);
          } else if (outcome === 'isolated') {
            await expect(b.read('SELECT n FROM t')).rejects.toMatchObject({
              code: 'STATEMENT_FAILED',
            });
            await b.write('CREATE TABLE t (n)');
            await b.write('INSERT INTO t VALUES (9)');
            expect(values(await a.read<{ n: number }>('SELECT n FROM t'))).toEqual([1]);
          } else {
            const started = performance.now();
            const refusal = await b.read('SELECT 1').then(
              () => undefined,
              (e: unknown) => e,
            );
            expect(refusal).toBeInstanceOf(SQLiteError);
            expect((refusal as SQLiteError).code).toBe('DATABASE_IN_USE');
            expect(performance.now() - started).toBeLessThan(REFUSED_WITHIN);
            // The first client is untouched by the refusal.
            await a.write('INSERT INTO t VALUES (2)');
            expect(
              values(await a.read<{ n: number }>('SELECT n FROM t ORDER BY n')),
            ).toEqual([1, 2]);
            // The lock that refused B is the one deleteDatabase reads (spec §3.3).
            await expect(deleteDatabase(file, { vfs, build })).rejects.toMatchObject({
              code: 'DATABASE_IN_USE',
            });
            await a.close();
            // A refused client never recovers (D9); a new one opens once the
            // first is gone.
            const c = open('C');
            expect(
              values(await c.read<{ n: number }>('SELECT n FROM t ORDER BY n')),
            ).toEqual([1, 2]);
          }
          // A suite that proves a VFS works proves how many workers it worked
          // with (mem:lessons, 2026-09-13).
          expect(losses).toEqual([]);
        });
      }
    }
  });
}
```

- [ ] **Step 3: Run it red**

```bash
pnpm exec rstest --project chromium run tests/browser/second-client.test.ts
pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/second-client.test.ts
```
Expected: Chromium green. Firefox red on the `OPFSWriteAheadVFS` rows only, each with `WORKER_CRASHED` where `DATABASE_IN_USE` was expected. **Any other red: stop and report it** — it is a finding, not noise (`IDBMirrorVFS` included).

- [ ] **Step 4: The protocol types**

In `src/types.ts`, in the `open` member of `ClientMessageData`, after `declineWithout?`:

```ts
      /**
       * Features worker 0 probes before opening, where the VFS is exclusive
       * without one (spec 2026-09-15, §3.2): it reports them with `probed`,
       * then loads nothing until `proceed`. Sent to slot 0 only, and only by a
       * VFS that declares `exclusiveConnectionWithout`.
       */
      probeFirst?: readonly PlatformFeature[];
```

Add to `ClientMessageData`, after `| { type: 'stop'; callId: number }`:

```ts
  /** The client decided the connection lock; worker 0 may open (spec 2026-09-15). */
  | { type: 'proceed'; callId: number }
```

Add to `WorkerMessageData`, after the `declined` member:

```ts
  /**
   * Worker 0's answer to `probeFirst`: the first feature missing, or null. It
   * opens nothing until the client sends `proceed` (spec 2026-09-15, §3.2).
   */
  | { type: 'probed'; callId: number; missing: PlatformFeature | null }
```

- [ ] **Step 5: The worker waits**

In `src/worker/worker.ts`:

1. Add `probeFirst?: readonly PlatformFeature[] | undefined;` to `OpenOptions`, beside `declineWithout`.
2. Beside the module-level `let closing`, add:

```ts
/**
 * Set while worker 0 waits for the client's connection lock (spec 2026-09-15,
 * §3.2). `proceed` resolves and clears it; a `close` arriving while it is set
 * is answered at once, since nothing was opened.
 */
let proceedGate: PromiseWithResolvers<void> | undefined;
```

3. In `open()`, right after the `declineWithout` block's closing brace:

```ts
  // Spec 2026-09-15, §3.2: where the VFS is exclusive without a feature the
  // page cannot probe, report it and open nothing until the client has decided
  // the connection lock. A worker that opened first would fail on a file
  // another client holds — or take it from under that client.
  if (options.probeFirst && options.probeFirst.length > 0) {
    proceedGate = Promise.withResolvers<void>();
    self.postMessage({
      type: 'probed',
      callId: 0,
      missing: firstMissing(options.probeFirst),
    } satisfies WorkerMessageData);
  }
```

4. Replace `openedDB = WA_SQLITE_BUILDS[build]()` with:

```ts
  openedDB = (proceedGate?.promise ?? Promise.resolve())
    .then(() => WA_SQLITE_BUILDS[build]())
```
(the rest of the chain is unchanged).

5. In `open()`'s inner `self.onmessage`, add a case before `case 'close'`:

```ts
      case 'proceed': {
        proceedGate?.resolve();
        proceedGate = undefined;
        break;
      }
```
and at the top of its `case 'close'` block:

```ts
        if (proceedGate) {
          // Still waiting for the connection lock: nothing was opened, so
          // there is nothing to drain or close (spec 2026-09-15, §3.2).
          closing = true;
          reply({ type: 'closed', callId: 0 });
          break;
        }
```

6. In the top-level `onmessage`, pass `probeFirst` through from the `open` case to `open(file, { …, probeFirst })`, and add `case 'proceed':` to the `credit`/`stop` group with the comment `// open() replaces this handler synchronously; proceed always arrives after.`

- [ ] **Step 6: The pool relays**

In `src/pool.ts`, `createPoolWorker`'s `deps`, after `declineWithout?`:

```ts
  /** Sent to slot 0 where exclusivity depends on a feature (spec 2026-09-15). */
  probeFirst?: readonly PlatformFeature[] | undefined;
  /** Worker 0's probe answer, with the function that lets it open. */
  onProbed?:
    | ((missing: PlatformFeature | null, proceed: () => void) => void)
    | undefined;
```
Destructure `probeFirst` beside `declineWithout`; add `probeFirst,` to the `open` `postMessage`; add a case to `worker.onmessage` after `declined`:

```ts
      case 'probed': {
        // Worker 0 opens nothing until `proceed`: the client decides the
        // connection lock's mode from this answer first (spec 2026-09-15).
        if (data.callId === 0) {
          logger.info(
            `worker ${index + 1} probed: ${data.missing ? `no ${data.missing}` : 'nothing missing'}`,
          );
          deps.onProbed?.(data.missing, () =>
            worker.postMessage({ type: 'proceed', callId: 0 }),
          );
        }
        break;
      }
```

- [ ] **Step 7: The client decides**

In `src/client.ts`:

1. Module level, beside `clientCount`:

```ts
/**
 * Worker 0's probe answer, per realm and per feature list (spec 2026-09-15,
 * A1). The engine does not change under a page, and one shared promise makes
 * clients built together request `bsq:conn` in construction order — so the
 * first one constructed wins, whichever worker happens to answer first.
 */
const exclusivityProbes = new Map<
  string,
  PromiseWithResolvers<PlatformFeature | null>
>();
```

2. Replace the block from `let connRelease: (() => void) | undefined;` through the end of `const connLockPromise … : undefined;` with (keep the long JSDoc on `connLockPromise`, amended: "The mode is the VFS's: `exclusive` where `exclusiveConnection` is declared, or where worker 0 found a feature of `exclusiveConnectionWithout` missing …"):

```ts
  let connRelease: (() => void) | undefined;
  /**
   * True once an `ifAvailable` request for `bsq:conn` came back empty: another
   * client holds the database and this one is refused (spec 2026-09-15, A3).
   * Not "no releaser", which is also true of a client that failed or closed
   * before its lock was decided — that one reports its own failure.
   */
  let connRefused = false;
  /** The feature whose absence made this client exclusive, for the message. */
  let exclusiveWithout: PlatformFeature | null = null;

  const inUse = () =>
    new SQLiteError(
      'DATABASE_IN_USE',
      `${vfs} supports one connection at a time across the whole origin` +
        (exclusiveWithout
          ? ` without ${exclusiveWithout}, which this browser lacks`
          : '') +
        `. Another tab or client is already connected to '${dbFile}'. ` +
        `Close that client to open a new one here.`,
    );

  /**
   * Where this VFS is exclusive only without a feature the page cannot probe,
   * worker 0 probes it and waits (spec 2026-09-15, §3.2). `undefined` means no
   * answer will come: the client failed or closed first.
   */
  const probeAnswer =
    sharesStorage(vfs) && capability.exclusiveConnectionWithout.length > 0
      ? Promise.withResolvers<PlatformFeature | null | undefined>()
      : undefined;
  let sharedProbe: PromiseWithResolvers<PlatformFeature | null> | undefined;
  if (probeAnswer) {
    const key = capability.exclusiveConnectionWithout.join(',');
    sharedProbe = exclusivityProbes.get(key);
    if (!sharedProbe) {
      sharedProbe = Promise.withResolvers<PlatformFeature | null>();
      exclusivityProbes.set(key, sharedProbe);
    }
    // Subscribed at construction, so in construction order (A1).
    void sharedProbe.promise.then(probeAnswer.resolve);
  }
  /** Set once the lock is ours; from then on slot 0 opens without probing. */
  let lockGranted = false;
  let proceedWorker0: (() => void) | undefined;
  /** Worker 0 opens once BOTH its answer and the lock are in, in either order. */
  const maybeProceed = () => {
    if (!lockGranted || !proceedWorker0 || closing) return;
    const proceed = proceedWorker0;
    proceedWorker0 = undefined;
    proceed();
  };

  const holdConnection = (exclusive: boolean): Promise<void> =>
    (
      locks.hold(connectionLockName(vfs, dbFile), {
        mode: exclusive ? 'exclusive' : 'shared',
        ...(exclusive ? { ifAvailable: true } : {}),
      }) as Promise<(() => void) | undefined>
    ).then((release) => {
      connRelease = release;
      connRefused = release === undefined;
    });

  const connLockPromise: Promise<void> | undefined = !sharesStorage(vfs)
    ? undefined
    : probeAnswer
      ? probeAnswer.promise.then((missing) => {
          // No answer: the client failed or closed first, and takes no lock.
          if (missing === undefined || closing) return;
          exclusiveWithout = missing;
          return holdConnection(missing !== null);
        })
      : holdConnection(capability.exclusiveConnection);
```

3. In `acquireInstrumented`'s connection guard, replace the `if (connRelease === undefined) { throw new SQLiteError('DATABASE_IN_USE', …) }` block with `if (connRefused) throw inUse();` and update the comment above it to name both declarations.

4. In `close()`, right after `logger.info('client closing');`:

```ts
      // A client closed before worker 0 answered takes no lock (spec
      // 2026-09-15, A3): settle the answer as "none" so connLockPromise, which
      // this function awaits below, cannot wait on a worker being closed.
      probeAnswer?.resolve(undefined);
```

5. In `failClient`, first line: `probeAnswer?.resolve(undefined);` — same reason; queries awaiting the connection lock must reach the scheduler's `fatal` instead.

6. In `spawn`, add to the `createPoolWorker` arguments, after `declineWithout`:

```ts
      // Spec 2026-09-15, §3.2: slot 0 waits for the lock until one is ours;
      // a slot 0 restarted after that opens straight away.
      probeFirst:
        index === 0 && probeAnswer !== undefined && !lockGranted
          ? capability.exclusiveConnectionWithout
          : undefined,
      onProbed: (missing, proceed) => {
        proceedWorker0 = proceed;
        sharedProbe?.resolve(missing);
        maybeProceed();
      },
```

7. In the startup block: in the `exclusiveConnection` branch, replace `if (connRelease === undefined)` by `if (connRefused)` and its `new SQLiteError('DATABASE_IN_USE', …)` by `inUse()`. Then, **before** that `if (capability.exclusiveConnection && …)` statement, add:

```ts
  // Spec 2026-09-15, §3.2 and A2: the whole pool spawns now, as for every
  // shared VFS; worker 0 waits for this decision. Without the feature the
  // surplus workers decline on `singleConnectionWithout` before touching the
  // file; with it they open alongside.
  if (probeAnswer && connLockPromise !== undefined) {
    void connLockPromise.then(() => {
      if (connRefused) {
        failClient(inUse());
      } else if (connRelease !== undefined) {
        lockGranted = true;
        maybeProceed();
      }
    });
  }
```
(The `else { startWorkers(); }` branch already spawns this VFS's pool.)

- [ ] **Step 8: Run it green**

```bash
pnpm exec tsc --noEmit && pnpm check
pnpm exec rstest --project chromium run tests/browser/second-client.test.ts tests/browser/exclusive-connection.test.ts tests/browser/pool-cap.test.ts
pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/second-client.test.ts tests/browser/exclusive-connection.test.ts tests/browser/pool-cap.test.ts
```
Expected: all green on both engines. `exclusive-connection.test.ts` still matches `/one connection at a time/` and `/Close that client/`; `pool-cap.test.ts` T5 still gets `WORKER_CRASHED` with its storage cause (a raw worker holds the file; no lock of ours sees it — spec §4.4).

- [ ] **Step 9: The close-before-probe test**

Append to `tests/browser/second-client.test.ts`:

```ts
describe('a client closed before worker 0 has answered', () => {
  // Spec 2026-09-15, §3.2 and A3 — the hazard the AccessHandlePoolVFS guard
  // paid a Critical defect for: a lock requested after close(), or a worker
  // left alive, would keep the next client out.
  it('closes promptly, holds no lock, and leaves the database to the next client', async () => {
    const vfs = 'OPFSWriteAheadVFS' as const;
    const file = `second-client-${crypto.randomUUID()}`;
    onTestFinished(async () => {
      await deleteDatabase(file, { vfs }).catch(() => {});
    });
    const a = createSQLiteClient(file, { vfs });
    const started = performance.now();
    await a.close();
    expect(performance.now() - started).toBeLessThan(REFUSED_WITHIN);
    const held = ((await navigator.locks.query()).held ?? []).filter(
      (lock) => lock.name?.startsWith('bsq:conn:') && lock.name.endsWith(`:${file}`),
    );
    expect(held).toEqual([]);
    const b = createSQLiteClient(file, { vfs });
    await b.write('CREATE TABLE t (n)');
    await b.close();
  });
});
```
Run on both engines: green.

- [ ] **Step 10: Falsifiers — run each, report red/green pairs**

1. **The guard:** in `connLockPromise`, replace `holdConnection(missing !== null)` by `holdConnection(false)` → Firefox `OPFSWriteAheadVFS` rows red with `WORKER_CRASHED`. Restore.
2. **The declaration:** set `OPFSWriteAheadVFS`'s `exclusiveConnectionWithout` to `[]` → the same rows red (the helper now expects sharing). Restore.
3. **AccessHandlePool:** `exclusiveConnection: false` on it → its rows red on both engines. Restore.
4. **The memo (A1):** in `onProbed`, resolve `probeAnswer.resolve(missing)` directly instead of going through `sharedProbe` (and delete the `sharedProbe.promise.then` subscription). Run the Firefox file **10 times** and count reds on the `together` rows. Restore. If 0/10, the memo has no observed falsifier: say so in a comment on `exclusivityProbes`, in those words, rather than claiming one.
5. **Close before the answer:** delete BOTH `probeAnswer?.resolve(undefined)` in `close()` and `|| closing` in `connLockPromise` → the close-before-probe test red. Then restore each alone and record whether either alone goes red — two overlapping guards hide each other's falsifier (`mem:lessons`, 2026-09-12). Write what was observed into the test's comment.

- [ ] **Step 11: Latency after, and the roster observation**

Re-run Task 2's latency `it` alone (copy the probe in, run, remove) on both engines; record the median against Task 2's. Then, in a throwaway addition to the probe, open A and a refused B on Firefox and record `(await inspectDatabase(file, { vfs })).clients.length` — whether a refused client shows in the roster until it is closed. Report both; change nothing on the strength of them.

- [ ] **Step 12: Cost — CHECKPOINT**

Record the duration of `second-client.test.ts` on each engine (from the rstest report). **Report to the controller, who puts it to the user** (D4): keep the matrix over every pair in `tests/browser/`, or fall back to the default build here and every pair in conformance.

- [ ] **Step 13: Full suite and commit**

```bash
pnpm exec tsc --noEmit && pnpm check && pnpm test
```
Expected: THREE green reports. Then:

```bash
git add src/types.ts src/worker/worker.ts src/pool.ts src/client.ts tests/browser/helpers/vfs-contract.ts tests/browser/second-client.test.ts
git commit -m "fix(client): a second OPFSWriteAheadVFS client gets DATABASE_IN_USE without readwrite-unsafe

Worker 0 probes the feature before opening and waits for the connection lock,
whose mode the answer decides; the answer is memoised per realm so clients
built together are served in construction order. The second-client matrix
runs every (vfs, build) pair on both engines.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Two probes after the guard — `IDBMirrorVFS` under load, and mixed `opfs-path` VFS

Measurements only (spec §5, §6). Nothing is committed.

**Files:**
- Create: `.scratchpad/second-client-2026-09-15/after-guard-probe.test.ts`

- [ ] **Step 1: Write the probe**

```ts
// THROWAWAY — spec 2026-09-15 §5 and §6. Never commit into tests/.
import { expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';

it('IDBMirrorVFS: B reads right after A commits, 300 rounds', async () => {
  const vfs = 'IDBMirrorVFS' as const;
  const file = `probe-${crypto.randomUUID()}`;
  const a = createSQLiteClient(file, { vfs });
  const b = createSQLiteClient(file, { vfs });
  await a.write('CREATE TABLE t (n)');
  const stale: number[] = [];
  const errors: string[] = [];
  for (let i = 1; i <= 300; i += 1) {
    await a.write('INSERT INTO t VALUES (?)', [i]);
    try {
      const [row] = await b.read<{ n: number }>('SELECT count(*) AS n FROM t');
      if ((row?.n ?? 0) < i) stale.push(i);
    } catch (e) {
      errors.push(`${i}: ${(e as Error).message.slice(0, 100)}`);
    }
  }
  await a.close();
  await b.close();
  await deleteDatabase(file, { vfs }).catch(() => {});
  expect(JSON.stringify({ stale: stale.length, first: stale.slice(0, 10), errors })).toBe('');
}, 300_000);

it('OPFSAdaptiveVFS meets a live OPFSWriteAheadVFS client on the same file', async () => {
  const file = `probe-${crypto.randomUUID()}`;
  const a = createSQLiteClient(file, { vfs: 'OPFSWriteAheadVFS' });
  await a.write('CREATE TABLE t (n)');
  const c = createSQLiteClient(file, { vfs: 'OPFSAdaptiveVFS', openTimeout: 5000 });
  const read = c.read('SELECT count(*) AS n FROM t').then(
    () => 'ok',
    (e: { code?: string; message?: string }) => `${e.code}: ${String(e.message).slice(0, 120)}`,
  );
  const within5s = await Promise.race([
    read,
    new Promise<string>((r) => setTimeout(r, 5000, 'still waiting after 5 s')),
  ]);
  await a.close();
  const afterClose = await Promise.race([
    read,
    new Promise<string>((r) => setTimeout(r, 5000, 'still waiting 5 s after A closed')),
  ]);
  await c.close().catch(() => {});
  await deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' }).catch(() => {});
  expect(JSON.stringify({ within5s, afterClose })).toBe('');
}, 60_000);
```

- [ ] **Step 2: Run, unloaded then loaded, both engines**

```bash
D=.scratchpad/second-client-2026-09-15
cp $D/after-guard-probe.test.ts tests/browser/
pnpm exec rstest --project chromium run tests/browser/after-guard-probe.test.ts > $D/after-chromium.txt 2>&1
pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/after-guard-probe.test.ts > $D/after-firefox.txt 2>&1
# Loaded: sixteen busy loops, the ABANDON-WEDGE method (mem:measurements).
for i in $(seq 16); do (while :; do :; done) & done
pnpm exec rstest --project chromium run tests/browser/after-guard-probe.test.ts > $D/after-chromium-loaded.txt 2>&1
pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/after-guard-probe.test.ts > $D/after-firefox-loaded.txt 2>&1
kill $(jobs -p)
rm tests/browser/after-guard-probe.test.ts && git status --short
```
Check with `jobs` / `ps` that no busy loop survives.

- [ ] **Step 3: Report**

Per engine × load: stale reads out of 300 and errors for `IDBMirrorVFS`; what the `OPFSAdaptiveVFS` client met, within 5 s and after A closed. **Stale reads or errors on `IDBMirrorVFS` are a decision for the user** (spec §6) — report, do not act.

---

### Task 6: `multi-client` and `cross-tab` on every shared VFS

**Files:**
- Create: `scripts/recommended-vfs.ts`
- Modify: `scripts/render-vfs-matrix.ts`, `tests/browser/helpers/vfs-contract.ts`, `tests/browser/multi-client.test.ts`, `tests/browser/cross-tab.test.ts`

**Interfaces:**
- Consumes: `secondClientOutcome` (Task 4); `ALL_VFS`, `missingHere`, `poolFor` from `tests/conformance/helpers.ts`.
- Produces: `RECOMMENDED_VFS: readonly SQLiteVFS[]` in `scripts/recommended-vfs.ts`; `SHARED_VFS: readonly SQLiteVFS[]` in `tests/browser/helpers/vfs-contract.ts`.

- [ ] **Step 1: Move the list**

Create `scripts/recommended-vfs.ts`, moving the constant AND its doc comment out of `scripts/render-vfs-matrix.ts`, with this addition to the comment:

```ts
import type { SQLiteVFS } from '../src/types.ts';

/**
 * (the existing comment from render-vfs-matrix.ts, verbatim, then:)
 *
 * Also read by the browser suite, whose single-VFS tests run on both (spec
 * 2026-09-15, D8). Kept free of side effects so a browser test can import it:
 * the renderer cannot be imported, it writes VFS.md at module load.
 */
export const RECOMMENDED_VFS: readonly SQLiteVFS[] = [
  'OPFSWriteAheadVFS',
  'OPFSAdaptiveVFS',
];
```
In the renderer, delete the constant and add `import { RECOMMENDED_VFS } from './recommended-vfs.ts';`.

Run: `pnpm docs:vfs && git diff --exit-code VFS.md && pnpm check`
Expected: no diff.

- [ ] **Step 2: `SHARED_VFS`**

Append to `tests/browser/helpers/vfs-contract.ts` (adding the imports `RECOMMENDED_VFS` from `'../../../scripts/recommended-vfs'` and `ALL_VFS`, `missingHere` from `'../../conformance/helpers'`):

```ts
/**
 * The VFS a test of two clients sharing one database can run on in this
 * browser, on their default build, the recommended first (spec 2026-09-15,
 * D7). The refused and the isolated drop out by the same rule the matrix
 * asserts: a refused second client cannot exist, and the memory VFS take no
 * write lock and publish no epoch, so these tests would test nothing there.
 */
export const SHARED_VFS: readonly SQLiteVFS[] = [
  ...RECOMMENDED_VFS,
  ...ALL_VFS.filter((vfs) => !RECOMMENDED_VFS.includes(vfs)),
].filter(
  (vfs) => secondClientOutcome(vfs) === 'shared' && missingHere(vfs) === null,
);
```

- [ ] **Step 3: `multi-client.test.ts`**

- `twoClients` takes the VFS, sizes the pool by it (an explicit `poolSize: 2` throws `INVALID_OPTION` on `OPFSCoopSyncVFS` and `IDBMirrorVFS`), and cleans up through `deleteDatabase`:

```ts
const twoClients = (vfs: SQLiteVFS) => {
  const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
  const options = { vfs, poolSize: poolFor(vfs) };
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
      await deleteDatabase(dbName, { vfs });
    } catch {
      /* never created */
    }
  });
  return { a, b };
};
```
- Wrap the whole `describe('two clients writing at once', …)` in `for (const vfs of SHARED_VFS) { describe(vfs, () => { … }); }` and pass `vfs` to every `twoClients(vfs)` call.
- Move `it('leaves nothing behind when a tx.bulkWrite is interrupted', …)` out of that loop into its own `describe('one client', …)`, with `const a = await createTestClient();` in place of `const { a } = twoClients();` (import `createTestClient` from `./helpers`). It follows the injected target once Task 7 lands (spec A5) and runs on `OPFSAdaptiveVFS` until then.
- Update the file's header comment: it runs on every VFS a second client shares, and why the others are absent (the helper's comment says it; point to it).

- [ ] **Step 4: `cross-tab.test.ts`**

Delete `const VFS = 'OPFSAdaptiveVFS' as const;`. `oneClient` takes `vfs` and uses `poolSize: poolFor(vfs)` and the same `deleteDatabase` cleanup. Wrap the `describe` in `for (const vfs of SHARED_VFS) { describe(vfs, () => { … }); }` and replace every `VFS` in the bodies with `vfs` (including `namespaceFor(VFS)` and the first test's `createSQLiteClient(dbName, { vfs: VFS, poolSize: 1, debug: true })` and its cleanup).

- [ ] **Step 5: Run both engines**

```bash
pnpm exec tsc --noEmit && pnpm check
pnpm exec rstest --project chromium run tests/browser/multi-client.test.ts tests/browser/cross-tab.test.ts
pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/multi-client.test.ts tests/browser/cross-tab.test.ts
```
Expected before triage: `OPFSWriteAheadVFS` present on Chromium and absent on Firefox; `AccessHandlePoolVFS` and the memory VFS absent on both. **Every red is triaged and reported** — defect, documented limit, or calibration — with its evidence. A defect is not fixed in this task: stop and report. `IDBMirrorVFS`: a red on a read that follows the other client's write is its documented non-promise (no read-your-writes across clients there); the fix is to skip that assertion for a VFS whose `multiConnection` is false, with the reason in a comment — only after reporting it.

- [ ] **Step 6: Falsifiers on both recommended × both engines**

For each test whose comment names a falsifier in `src/`, apply it, run the file on each engine, and record which VFS go red. (On Firefox the only recommended VFS present is `OPFSAdaptiveVFS`.) Restore and verify `git diff` shows only the task's intended changes. Update each comment to say where the falsifier was observed red, e.g. `Verified 2026-09-1x: red on OPFSWriteAheadVFS and OPFSAdaptiveVFS (Chromium), OPFSAdaptiveVFS (Firefox).` A falsifier red nowhere: stop and report — a refuted claim is deleted, not reworded (`mem:lessons`).

- [ ] **Step 7: Record the cost**

Duration of both files per engine, before (Task 1 baseline run) and after. Report.

- [ ] **Step 8: Full suite and commit**

```bash
pnpm exec tsc --noEmit && pnpm check && pnpm test
git add scripts/recommended-vfs.ts scripts/render-vfs-matrix.ts tests/browser/helpers/vfs-contract.ts tests/browser/multi-client.test.ts tests/browser/cross-tab.test.ts
git commit -m "test: multi-client and cross-tab on every VFS a second client shares

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The injected target (rewritten 2026-09-15, spec A5)

`createTestClient` stops defaulting to one VFS: a test that names none runs on the target its
project injects, and `pnpm test` runs both recommended targets on both engines.

**Files:**
- Create: `tests/browser/target.ts`, `tests/unit/test-target.test.ts`, `tests/target-projects.ts`
- Modify: `tests/browser/helpers.ts`, `rstest.config.ts`, `rstest.firefox.config.ts`, `rstest.isolated.config.ts`, `tsconfig.json` (only if `tests/target-projects.ts` needs including — it is under `tests/`, so it already is), and `tests/browser/interrupt.test.ts` (its needs)

**Interfaces:**
- Consumes: `RECOMMENDED_VFS` (`scripts/recommended-vfs.ts`, Task 6); `VFS_CAPABILITIES`, `defaultBuildFor`, `BUILD_REQUIREMENTS`, `PlatformFeature`, `SQLiteVFS`, `SQLiteBuild` (`src/types.ts`).
- Produces, in `tests/browser/target.ts`:
  - `type TestTarget = { readonly vfs: SQLiteVFS; readonly build: SQLiteBuild }`
  - `type Need = 'two-workers' | 'interruptible'`
  - `type Here = { readonly features: ReadonlySet<PlatformFeature>; readonly crossOriginIsolated: boolean }`
  - `resolvePair(target: TestTarget, needs: readonly Need[], here: Here): TestTarget | null` — pure
  - `TEST_TARGET: TestTarget` — the injected `__BSQ_TEST_TARGET__`
- Produces, in `tests/target-projects.ts` (Node, read by the configs): `targetsFromEnv(env: string | undefined): TestTarget[]` — `undefined` → the recommended pairs on their default builds; `'all'` → every declared (vfs, build); otherwise a comma list of `vfs/build`; and `targetLabel(t: TestTarget): string` → `` `${t.vfs}/${t.build}` ``.
- `createTestClient(options?: TestClientOptions)` where `TestClientOptions` gains `needs?: readonly Need[]` and keeps `vfs?`: with `vfs`, the test is pinned (its `build` or the VFS default); without, `resolvePair(TEST_TARGET, needs ?? [], here)`; `null` → throw `Error('TARGET_NOT_RUNNABLE: …')` naming the target and the needs.

- [ ] **Step 1: Spike — two browser projects of one engine, distinct defines**

In a throwaway copy of `rstest.config.ts` at the repository root (`rstest.spike.config.ts`, deleted after), declare two `chromium` projects that differ only by `name` and `source: { define: { __BSQ_TEST_TARGET__: JSON.stringify('A') } }` / `'B'`, both including one throwaway test that does `expect(__BSQ_TEST_TARGET__).toBe('')` (declare the global in the test). Run it once. **Pass** if the report shows both projects and the two failures print `'A'` and `'B'`. Record the outcome in the report. If it fails, use the fallback of spec A5 (one run per target with `BSQ_TEST_TARGETS`, chained in the `test` script) for every later step, and say so.

- [ ] **Step 2: The resolver, TDD, in Node**

Write `tests/unit/test-target.test.ts` first (the resolver takes `here` as a parameter precisely so it runs in Node). Cases, each with a `// Falsifiable:` line:
1. no needs → the target itself, when `missingFeature` finds nothing;
2. `interruptible` on `OPFSWriteAheadVFS/sync`, not isolated → `OPFSWriteAheadVFS/async` (same VFS, next declared build);
3. `interruptible` on `OPFSWriteAheadVFS/sync`, isolated → the target itself;
4. `two-workers` on `OPFSAdaptiveVFS/async` without `readwrite-unsafe` → `OPFSAnyContextVFS/async` (neither recommended VFS runs two workers there; first other VFS in `VFS_CAPABILITIES` key order that does, on its declared builds);
5. `two-workers` on `OPFSAdaptiveVFS/async` with `readwrite-unsafe` → the target;
6. a pair needing a feature not in `here.features` (e.g. `jspi` without it) is never returned;
7. no pair satisfies → `null`.

Then implement `resolvePair` in `tests/browser/target.ts`: candidate order = target; target's VFS on its other declared builds; each VFS of `RECOMMENDED_VFS` on its declared builds; every other VFS in `VFS_CAPABILITIES` key order on its declared builds. A candidate qualifies when `[...requires, ...BUILD_REQUIREMENTS[build]]` are all in `here.features` and every need holds: `two-workers` ⇔ `maxPoolSize !== 1` and no feature of `singleConnectionWithout` is missing; `interruptible` ⇔ `build !== 'sync' || here.crossOriginIsolated`. `TEST_TARGET` reads `__BSQ_TEST_TARGET__` (declare it with `declare const __BSQ_TEST_TARGET__: TestTarget | undefined;`) and throws if it is undefined — a browser project without a target is a configuration error, not a default.

Run: `pnpm exec rstest --project unit run tests/unit/test-target.test.ts` red, then green.

- [ ] **Step 3: The projects**

`tests/target-projects.ts` implements `targetsFromEnv` and `targetLabel` (validating every `vfs/build` against `VFS_CAPABILITIES`, throwing on an unknown one). In `rstest.config.ts`, `rstest.firefox.config.ts` and `rstest.isolated.config.ts`, replace the single browser project by `...targetsFromEnv(process.env.BSQ_TEST_TARGETS).map((target) => ({ ...theExistingProject, name: `${engine} · ${targetLabel(target)}`, source: { define: { __BSQ_TEST_TARGET__: JSON.stringify(target) } } }))`, keeping every existing field and comment. (With the Step 1 fallback: one project, the target from the single `BSQ_TEST_TARGETS` value, and the `test` script chains one run per recommended target.)

- [ ] **Step 4: `createTestClient`**

As in Interfaces. Keep the sidecar cleanup of the original Task 7 (the three every layout may have plus the VFS's `extraFileSuffixes`), applied to the RESOLVED vfs. `here` is `{ features: detectFeatures() ∪ ('readwrite-unsafe' if the conformance probe says so), crossOriginIsolated: globalThis.crossOriginIsolated === true }` — reuse `AVAILABLE_FEATURES` from `tests/conformance/helpers.ts`. Rewrite the doc comment: the VFS is the target's unless the test pins one, pinning is for tests whose subject is a VFS, and a property the subject requires is declared as a need.

- [ ] **Step 5: The reds the dry run predicted**

Task 1's dry run (`.scratchpad/second-client-2026-09-15/dry-run.md`) found, under `OPFSWriteAheadVFS/sync`, `interrupt.test.ts` red for calibration (the `sync` build cannot interrupt) and `output.test.ts`/`tx-write.test.ts` red for the defect Task 3b fixed. Give the `interrupt.test.ts` clients `needs: ['interruptible']`. Nothing else is changed in this task.

- [ ] **Step 6: Run**

`pnpm exec tsc --noEmit && pnpm check && pnpm test`. Expected: each engine's report lists one project per recommended target; the `OPFSAdaptiveVFS/async` projects pass the same tests as before this task; the `OPFSWriteAheadVFS/sync` projects pass. Any red: triage per the Tasks 8-10 rule — a calibration fixed by a need, anything else stopped and reported. Record both projects' durations per engine against Task 1's baseline.

- [ ] **Step 7: Falsifiers, run**

1. Make `resolvePair` ignore `needs` → the unit cases 2 and 4 red, and `interrupt.test.ts` red under the WriteAhead project. Restore.
2. Make `createTestClient` ignore the target (hard-code `OPFSAdaptiveVFS`) → nothing in the browser suite goes red; record it — the proof the target is used is the project list and the unit tests, and the report says so plainly.

- [ ] **Step 8: Commit** — `test: the browser suite follows an injected target; pnpm test runs both recommended pairs` with the trailer.

---

### Tasks 8, 9: Triage under the target (rewritten 2026-09-15, spec A5)

After Task 7, every test that calls `createTestClient()` without a VFS already runs on both recommended targets. These tasks convert the tests that still pin a VFS, one batch each, so a reviewer can reject one and approve the other.

**The rule:**
- The subject is a VFS → keep `vfs`, with `// One VFS: <reason>` on the line above.
- The subject needs a property the target may lack → drop `vfs`, declare `needs` (`two-workers` for pool machinery — barrier, evictions, writer spread, a read during a long statement; `interruptible` for interrupt and timeout subjects). A need not in the list: stop and report; the list grows by decision, not by drift.
- Otherwise → drop `vfs`: the test follows the target.
- `build:` pinned without the subject being that build → drop it too.
- Every red met is triaged: calibration → fixed in the test with the reason in a comment; defect → stop and report, never fixed silently; flake → measured (n runs) before any verdict.
- The report carries a table: file · test · before · after (target / needs / pinned + reason) · reds and their triage.

**Each batch:** apply the rule file by file (Serena for every edit); `pnpm exec tsc --noEmit && pnpm check`; the batch's files on both engines (single-file commands, `timeout 300`); `pnpm test` (THREE reports, every project); commit `test: <batch> follow the target`.

**Task 8 — files that mix the target with pinned VFS:** `concurrency`, `lifecycle`, `output`, `tx-savepoint`, `tx-abort`, `barrier`, `tx-quiesce`, `init`, `debug`, `default-pragmas`, `long-query`, `abandon-transaction`, `statement-errors`, `inspect-marker`, `inspect-client`, `pool-cap`.

**Task 9 — files pinned to a non-recommended VFS:** `query-timeout`, `chunk-delivery`, `abandon`, `pool-savepoint`, `tx-timeout`, `abandon-gc` (`MemoryVFS`); `isolated/abort-slot`, `isolated/tx-savepoint` (`MemoryVFS`, isolated config); `inspect`, `inspect-realm`, `inspect-write`, `write-lock-reclaim`, `idb-long-read` (`IDBBatchAtomicVFS`); `writer-spread` (`OPFSAnyContextVFS`); `coopsync-handover`, `coopsync-retry`, `exclusive-connection`, `vfs`, `delete`. Before starting, re-run `node .scratchpad/vfs-coverage.mjs` and add any file it lists that neither batch names.

---

### Task 10: `pnpm test:matrix` (rewritten 2026-09-15, spec A5)

**Files:**
- Create: `scripts/test-matrix.mjs`
- Modify: `package.json` (`"test:matrix": "node scripts/test-matrix.mjs"`), `.gitignore` (`.matrix/`)

- [ ] **Step 1: The script**

- Enumerates every declared (vfs, build) from `VFS_CAPABILITIES` (import `../src/types.ts` — Node strips the types, as `scripts/render-vfs-matrix.ts` does), and the engine configs `rstest.config.ts` (Chromium; run with `--project` filtering out `unit`) and `rstest.firefox.config.ts`.
- Optional arguments narrow it: `--engine chromium|firefox`, `--pair vfs/build` (repeatable).
- For each engine, for each pair, sequentially: `timeout 600 pnpm exec rstest --config <cfg> run` with `BSQ_TEST_TARGETS=<vfs/build>` in the environment (and `--project` for Chromium), stdout+stderr saved to `.matrix/<ISO date>/<engine>-<vfs>-<build>.txt`.
- Parses rstest's JSON summary block from each output (`counts.tests`, `failedTests`, `skippedTests`, `durationMs.total`). A run whose every failure message starts with `TARGET_NOT_RUNNABLE` is "not runnable here". A run that timed out is "timed out".
- Prints a table: rows = pairs, columns = engines, cells = `passed/failed/skipped · seconds` or the status word. Exit code 1 if any cell failed or timed out.

- [ ] **Step 2: A unit test for the parsing** (`tests/unit/test-matrix.test.ts`, importing the parse function the script exports): a passing summary, a failing one, an all-`TARGET_NOT_RUNNABLE` one, an output with no summary (timed out).

- [ ] **Step 3: One full run — CHECKPOINT**

`pnpm test:matrix` with a progress monitor (mem: progress every two minutes). Report the table, the total duration, and every red with its first error line. **Reds here are findings for the user**, not for this task to fix.

- [ ] **Step 4: Commit** — `test: pnpm test:matrix runs the browser suite on every VFS and build` with the trailer.

---

### Task 11: Documentation

**Files:**
- Modify: `scripts/render-vfs-matrix.ts`, `VFS.md` (hand-written spans only, then regenerated), `CHANGELOG.md`

- [ ] **Step 1: A `Clients` fact in the per-VFS header**

In `detailFor` (`scripts/render-vfs-matrix.ts`), beside `shared`:

```ts
  // Who can hold the database at once, where the answer is not "any number":
  // a second client gets DATABASE_IN_USE (spec 2026-09-15).
  const clients = cap.exclusiveConnection
    ? '**Clients:** one at a time'
    : cap.exclusiveConnectionWithout.length > 0
      ? `**Clients:** one at a time without ${cap.exclusiveConnectionWithout.map((f) => `\`${f}\``).join(', ')}`
      : null;
```
and push it into `facts` right after `shared`, the same way `shared` is pushed. Run `pnpm docs:vfs && git diff VFS.md`: exactly two headers gain the fact, `OPFSWriteAheadVFS` and `AccessHandlePoolVFS`.

- [ ] **Step 2: Hand text in `VFS.md`**

Edit only outside `<!-- BEGIN GENERATED … -->` / `<!-- END … -->` spans (a hand edit inside one is erased by the next render — `mem:lessons`). In the `OPFSWriteAheadVFS` section, replace the paragraph that begins `**Everywhere else it runs on a single worker.**` with:

```md
**Everywhere else it runs on a single worker, and a single client.** A browser without `readwrite-unsafe` ignores the `mode` option rather than rejecting it, so the handle opens exclusively — and this VFS keeps it for the connection's whole life instead of handing it over. Only one connection can open, in this tab or any other: the pool is capped at `1`, which is [reduced mode](#reduced-mode) at its narrowest — no read is served while a statement runs — and a second client on the same database fails its first query with `DATABASE_IN_USE`, immediately. Close the first client and the next one opens.
```
In the `AccessHandlePoolVFS` section, in the paragraph beginning `**\`AccessHandlePoolVFS\` allows one connection per origin, not one per tab.**`, replace `fails its first query with \`BUSY\`, immediately` with `fails its first query with \`DATABASE_IN_USE\`, immediately`.

Run `pnpm docs:vfs && git diff --stat VFS.md` — the render must keep both edits.

- [ ] **Step 3: `CHANGELOG.md`, unreleased section**

Under the section's existing fixes heading (create `### Fixed` after `### Breaking` if none exists):

```md
- **A second `OPFSWriteAheadVFS` client now fails fast with `DATABASE_IN_USE` where the browser lacks `readwrite-unsafe`** — every engine but Chromium today. That VFS holds its files exclusively for a connection's whole life there, so one client — one tab — can use a database at a time; a second one used to fail every query with `WORKER_CRASHED`. Close the first client and the next one opens.
```
Under an `### Added` heading (create it if none exists):

```md
- `VFSCapability.exclusiveConnectionWithout`: the platform features without which a VFS allows one client at a time across the origin.
```

- [ ] **Step 4: Checks**

`grep -n "exclusive\|singleConnectionWithout" API.md scripts/bench/html/index.html` — confirm nothing states the old behaviour (API.md's `DATABASE_IN_USE` row already covers "a second client where the VFS supports one connection at a time"; the bench page reads `singleConnectionWithout` only). Report what was checked.

- [ ] **Step 5: Commit**

```bash
pnpm check
git add scripts/render-vfs-matrix.ts VFS.md CHANGELOG.md
git commit -m "docs: OPFSWriteAheadVFS takes one client at a time without readwrite-unsafe

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
pnpm docs:vfs && git diff --exit-code VFS.md
```
The last line runs AFTER the commit: it proves the committed text is what the renderer produces — the check the pre-push hook and CI run. A diff there means a hand edit landed inside a generated span.

---

### Task 12: Full verification and memories

- [ ] **Step 1: The baseline table of `mem:state`, re-read in one pass**

```bash
D=.scratchpad/second-client-2026-09-15
pnpm exec tsc --noEmit > $D/final-tsc.txt 2>&1; echo "tsc $?"
pnpm test > $D/final-test.txt 2>&1; echo "test $?"
pnpm test:conformance > $D/final-conformance.txt 2>&1; echo "conformance $?"
pnpm test:consumer > $D/final-consumer.txt 2>&1; echo "consumer $?"
pnpm lint > $D/final-lint.txt 2>&1; echo "lint $?"
```
Read every report: THREE for `pnpm test`, TWO for conformance, 24/24 consumer stages. Compare counts and skips with `mem:state`'s table; explain every difference.

- [ ] **Step 2: Memories (Serena `write_memory` / `edit_memory` only)**

- `mem:vfs`: the `OPFSWriteAheadVFS` row — one client at a time without `readwrite-unsafe`, `DATABASE_IN_USE`, since this branch; the per-realm memo and why.
- `mem:measurements`: Task 1's dry run (durations), Task 2's characterisation and latency before/after, Task 4's matrix cost and falsifier results (memo rate), Task 5's two probes — each with date, method, n.
- `mem:follow-ups`: delete the `OPFSWriteAheadVFS refuses a second client …` entry; add any finding the branch opened and did not close (an `IDBMirrorVFS` result, a refused client in the roster, the mixed `opfs-path` observation), one short entry each.
- `mem:state`: rewrite the affected sections (the decision owed, the baseline table's counts).
- `mem:lessons`: only if the branch taught one.
- `mem:stack-and-build`: the test-suite table: the injected target, `pnpm test` running both recommended pairs, `pnpm test:matrix`.

- [ ] **Step 3: Commit the memories**

```bash
git add .serena/memories
git commit -m "docs(memory): a second client on every VFS — decisions, measurements, state

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
