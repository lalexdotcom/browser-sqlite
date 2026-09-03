# Database Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report who is live on a database right now — clients, tabs, and the writer — without opening it, via `inspectDatabase({ file, vfs })` and `db.inspect()`.

**Architecture:** Each client holds an uncontended Web Locks liveness marker naming its UUID, VFS and label. One `navigator.locks.query()` reads the whole roster plus the write lock's holder and its queue. Nothing is maintained between calls: every call is a fresh census, and the consumer polls if it wants reactivity.

**Tech Stack:** TypeScript, Web Locks API, rstest (`unit` project on Node, `browser` project on Chromium/Firefox), biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-03-database-inspection-design.md`

## Global Constraints

- **Serena's symbolic tools are primary for code.** `get_symbols_overview`, `find_symbol`, `replace_symbol_body`, `insert_after_symbol`, `replace_content`. Built-in Read/Edit/Grep on a code file only when Serena fails or the file is unparseable; they are fine for `.md`, JSON, YAML.
- **TDD, strictly.** Test first, watch it fail for the stated reason, then the minimal implementation, then green, then commit.
- **`pnpm check` (biome) after every modification.** The pre-commit hook runs biome on staged files and the full `pnpm test` suite; a commit that breaks tests will not land.
- **Baseline to hold:** `pnpm test` = 565 tests / 41 files / 0 failed before this plan starts. Every task must leave it green plus its own new tests.
- **Never touch `bsq:conn`.** It is load-bearing for `AccessHandlePoolVFS`'s single-connection guard and for `deleteDatabase`'s `DATABASE_IN_USE`. The new marker must contend with nothing. (Spec D4.)
- **Strict parsing, never guessing.** A marker that does not match exactly is ignored. (Spec D6.)
- **`normalizeDatabaseFile` is the one definition of database identity.** (Spec D8.)
- **No `signal` parameter anywhere in this surface.** A documented exception to
  the project's "`signal` on every method" convention: `navigator.locks.query()`
  takes no lock and waits for nothing, so the parameter could only abort the
  `.then()`. (Spec D12.)
- **English in code, comments, commits and docs.**

## Deviation from the spec, decided while planning

The spec's §7 places the marker parser in `src/inspect.ts` and the name builder in `src/locks.ts`. **This plan puts both in `src/locks.ts`.** Encoder and decoder that live apart drift apart, and `locks.ts` already holds exactly this pair — `stagingLockName` builds a name and `staleStagingTables` interprets one. `src/inspect.ts` keeps the realm resolution, the assembly and the public entry points.

---

### Task 1: The marker name and its parser

**Files:**
- Modify: `src/locks.ts` (add after `sweepLockName`, near the other name builders)
- Test: `tests/unit/locks.test.ts`

**Interfaces:**
- Consumes: `namespaceFor(vfs)`, `VFS_CAPABILITIES`, `SQLiteVFS` — all already in `locks.ts`/`types.ts`.
- Produces:
  - `clientMarkerName(vfs: SQLiteVFS, file: string, id: string, clientName: string): string`
  - `type ClientMarker = { readonly id: string; readonly vfs: SQLiteVFS; readonly name: string }`
  - `parseClientMarker(lockName: string, vfs: SQLiteVFS, file: string): ClientMarker | undefined`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/locks.test.ts`, and add `clientMarkerName`, `parseClientMarker` to the existing import from `../../src/locks`:

```ts
describe('clientMarkerName / parseClientMarker', () => {
  const ID = '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a90';

  it('round-trips a plain name', () => {
    const lock = clientMarkerName('OPFSAdaptiveVFS', 'app.db', ID, 'SQLite 1');
    expect(parseClientMarker(lock, 'OPFSAdaptiveVFS', 'app.db')).toEqual({
      id: ID,
      vfs: 'OPFSAdaptiveVFS',
      name: 'SQLite 1',
    });
  });

  it('round-trips a name containing a colon and a percent', () => {
    const lock = clientMarkerName('OPFSAdaptiveVFS', 'app.db', ID, 'a:b 100%');
    expect(parseClientMarker(lock, 'OPFSAdaptiveVFS', 'app.db')?.name).toBe(
      'a:b 100%',
    );
  });

  it('round-trips when the FILE contains a colon', () => {
    const file = 'weird:name.db';
    const lock = clientMarkerName('OPFSAdaptiveVFS', file, ID, 'SQLite 1');
    expect(parseClientMarker(lock, 'OPFSAdaptiveVFS', file)?.id).toBe(ID);
  });

  it('sees a sibling opened through another VFS of the same namespace', () => {
    const lock = clientMarkerName('OPFSCoopSyncVFS', 'app.db', ID, 'SQLite 1');
    expect(parseClientMarker(lock, 'OPFSAdaptiveVFS', 'app.db')?.vfs).toBe(
      'OPFSCoopSyncVFS',
    );
  });

  it('ignores a marker from another namespace', () => {
    const lock = clientMarkerName('IDBBatchAtomicVFS', 'app.db', ID, 'SQLite 1');
    expect(parseClientMarker(lock, 'OPFSAdaptiveVFS', 'app.db')).toBeUndefined();
  });

  it('ignores a marker for another file', () => {
    const lock = clientMarkerName('OPFSAdaptiveVFS', 'other.db', ID, 'SQLite 1');
    expect(parseClientMarker(lock, 'OPFSAdaptiveVFS', 'app.db')).toBeUndefined();
  });

  it('ignores a foreign lock name under our prefix shape', () => {
    expect(
      parseClientMarker('bsq:write:opfs:app.db', 'OPFSAdaptiveVFS', 'app.db'),
    ).toBeUndefined();
  });

  it('ignores a marker with too few or too many segments', () => {
    const prefix = 'bsq:client:opfs:app.db:';
    expect(
      parseClientMarker(`${prefix}${ID}:OPFSAdaptiveVFS`, 'OPFSAdaptiveVFS', 'app.db'),
    ).toBeUndefined();
    expect(
      parseClientMarker(
        `${prefix}${ID}:OPFSAdaptiveVFS:SQLite%201:extra`,
        'OPFSAdaptiveVFS',
        'app.db',
      ),
    ).toBeUndefined();
  });

  it('ignores a marker whose id is not a UUID', () => {
    expect(
      parseClientMarker(
        'bsq:client:opfs:app.db:not-a-uuid:OPFSAdaptiveVFS:SQLite%201',
        'OPFSAdaptiveVFS',
        'app.db',
      ),
    ).toBeUndefined();
  });

  it('ignores a marker naming a VFS that does not exist', () => {
    expect(
      parseClientMarker(
        `bsq:client:opfs:app.db:${ID}:NoSuchVFS:SQLite%201`,
        'OPFSAdaptiveVFS',
        'app.db',
      ),
    ).toBeUndefined();
  });

  it('ignores a marker whose encoding is malformed', () => {
    expect(
      parseClientMarker(
        `bsq:client:opfs:app.db:${ID}:OPFSAdaptiveVFS:%E0%A4%A`,
        'OPFSAdaptiveVFS',
        'app.db',
      ),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec rstest --project unit tests/unit/locks.test.ts`
Expected: FAIL — `clientMarkerName is not a function` / import error on `parseClientMarker`.

- [ ] **Step 3: Implement**

In `src/locks.ts`, after `sweepLockName`:

```ts
/**
 * The marker a client holds to publish that it is alive on a database.
 *
 * Held in SHARED mode and contended by NOBODY: like `bsq:staging` this is a
 * liveness marker, not mutual exclusion. `bsq:conn` stays the only occupancy
 * detector `deleteDatabase` rests on — a second one would diverge from it.
 *
 * The label is `encodeURIComponent`d, which escapes `:` as `%3A`. That is what
 * makes the tail split unambiguously into exactly three segments whatever the
 * consumer names their client. The FILE may itself contain a colon, which is
 * why the reader rebuilds the exact prefix instead of scanning for separators —
 * the same trap `epochsFor` documents.
 */
export const clientMarkerName = (
  vfs: SQLiteVFS,
  file: string,
  id: string,
  clientName: string,
): string =>
  `bsq:client:${namespaceFor(vfs)}:${file}:${id}:${vfs}:${encodeURIComponent(clientName)}`;

export type ClientMarker = {
  readonly id: string;
  readonly vfs: SQLiteVFS;
  readonly name: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads one of our markers, or `undefined` for anything else.
 *
 * Every rejection below is deliberate: a marker this version does not
 * understand — a future one carrying more segments, say — must be SKIPPED, not
 * guessed at. Guessing is how a reader reports another database's state.
 */
export const parseClientMarker = (
  lockName: string,
  vfs: SQLiteVFS,
  file: string,
): ClientMarker | undefined => {
  const prefix = `bsq:client:${namespaceFor(vfs)}:${file}:`;
  if (!lockName.startsWith(prefix)) return undefined;

  const parts = lockName.slice(prefix.length).split(':');
  if (parts.length !== 3) return undefined;

  const [id, markerVfs, encoded] = parts as [string, string, string];
  if (!UUID_RE.test(id)) return undefined;
  if (!Object.hasOwn(VFS_CAPABILITIES, markerVfs)) return undefined;

  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    // Malformed percent-escapes throw URIError. An unreadable label is an
    // unreadable marker: skip it rather than report a mangled name.
    return undefined;
  }

  return { id, vfs: markerVfs as SQLiteVFS, name };
};
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec rstest --project unit tests/unit/locks.test.ts`
Expected: PASS, all 11 new cases.

- [ ] **Step 5: Format, then commit**

```bash
pnpm check
git add src/locks.ts tests/unit/locks.test.ts
git commit -m "feat(locks): name and read a client liveness marker"
```

---

### Task 2: `Locks.entries()` — mode, clientId and pending

**Files:**
- Modify: `src/locks.ts` (the `LockManager` type, the `Locks` type, `noOpLocks`, `createLocks`)
- Test: `tests/unit/locks.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type LockEntry = { readonly name: string; readonly mode: 'exclusive' | 'shared'; readonly clientId: string }`
  - `type LockEntries = { readonly held: readonly LockEntry[]; readonly pending: readonly LockEntry[] }`
  - `Locks.entries: () => Promise<LockEntries>`

`heldNames()` is unchanged — `epochsFor` needs nothing else and must not be disturbed.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/locks.test.ts` (add `noOpLocks` to the import if absent):

```ts
describe('Locks.entries', () => {
  const fakeManager = (snapshot: unknown) =>
    ({
      request: () => Promise.resolve(),
      query: () => Promise.resolve(snapshot),
    }) as never;

  it('returns held and pending with mode and clientId', async () => {
    const locks = createLocks(
      fakeManager({
        held: [{ name: 'bsq:write:opfs:app.db', mode: 'exclusive', clientId: 'r1' }],
        pending: [{ name: 'bsq:write:opfs:app.db', mode: 'exclusive', clientId: 'r2' }],
      }),
    );
    expect(await locks.entries()).toEqual({
      held: [{ name: 'bsq:write:opfs:app.db', mode: 'exclusive', clientId: 'r1' }],
      pending: [{ name: 'bsq:write:opfs:app.db', mode: 'exclusive', clientId: 'r2' }],
    });
  });

  it('drops entries missing a name or a clientId', async () => {
    const locks = createLocks(
      fakeManager({
        held: [
          { mode: 'shared', clientId: 'r1' },
          { name: 'bsq:conn:opfs:app.db', mode: 'shared' },
          { name: 'bsq:conn:opfs:app.db', mode: 'shared', clientId: 'r1' },
        ],
      }),
    );
    const { held } = await locks.entries();
    expect(held).toEqual([
      { name: 'bsq:conn:opfs:app.db', mode: 'shared', clientId: 'r1' },
    ]);
  });

  it('defaults a missing mode to exclusive and a missing list to empty', async () => {
    const locks = createLocks(
      fakeManager({ held: [{ name: 'x', clientId: 'r1' }] }),
    );
    expect(await locks.entries()).toEqual({
      held: [{ name: 'x', mode: 'exclusive', clientId: 'r1' }],
      pending: [],
    });
  });

  it('answers empty when Web Locks is missing', async () => {
    expect(await noOpLocks.entries()).toEqual({ held: [], pending: [] });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec rstest --project unit tests/unit/locks.test.ts`
Expected: FAIL — `locks.entries is not a function`.

- [ ] **Step 3: Implement**

Widen the `LockManager` slice in `src/locks.ts`:

```ts
type QueriedLock = { name?: string; mode?: string; clientId?: string };

/** The slice of the Web Locks API this module uses. */
type LockManager = {
  request: (
    name: string,
    optionsOrCallback: any,
    callback?: (lock: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
  query: () => Promise<{ held?: QueriedLock[]; pending?: QueriedLock[] }>;
};
```

Add the exported types next to `Locks`:

```ts
/** One entry of the origin's lock registry, held or pending. */
export type LockEntry = {
  readonly name: string;
  readonly mode: 'exclusive' | 'shared';
  readonly clientId: string;
};

export type LockEntries = {
  readonly held: readonly LockEntry[];
  readonly pending: readonly LockEntry[];
};
```

Add to the `Locks` type, after `heldNames`:

```ts
  /**
   * The origin's whole lock registry: held AND pending, each with the realm
   * holding or awaiting it.
   *
   * `heldNames()` answers a different, cheaper question and keeps its own
   * shape — `epochsFor` only ever needs names.
   */
  entries: () => Promise<LockEntries>;
```

Add to `noOpLocks`:

```ts
  entries: async () => ({ held: [], pending: [] }),
```

And in `createLocks`, after `heldNames`:

```ts
    entries: async () => {
      const snapshot = await manager.query();
      // An entry without a name or a clientId cannot be attributed, and a
      // half-read entry is worse than a missing one: it would join the roster
      // as an anonymous client nobody can close.
      const read = (list: QueriedLock[] | undefined): LockEntry[] =>
        (list ?? [])
          .filter(
            (lock): lock is QueriedLock & { name: string; clientId: string } =>
              typeof lock.name === 'string' &&
              typeof lock.clientId === 'string',
          )
          .map((lock) => ({
            name: lock.name,
            mode: lock.mode === 'shared' ? ('shared' as const) : ('exclusive' as const),
            clientId: lock.clientId,
          }));
      return { held: read(snapshot.held), pending: read(snapshot.pending) };
    },
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec rstest --project unit tests/unit/locks.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, then commit**

```bash
pnpm check
git add src/locks.ts tests/unit/locks.test.ts
git commit -m "feat(locks): expose the registry with mode, clientId and pending"
```

---

### Task 3: `clientPrefix` → `clientName`, and `db.debug.name` carries it

**Files:**
- Modify: `src/client.ts:303`, `src/client.ts:499`, `src/client.ts:503`, `src/client.ts:1112`
- Modify: `src/pool.ts:128`, `src/pool.ts:149`, `src/pool.ts:162`
- Test: `tests/browser/debug.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `db.debug.name` now reads `"<option> <n>"` (e.g. `"SQLite 1"`) instead of `"<option>"`. Spec D15 (**Breaking**) and D18.

This is a value change on a public field. It has no reader anywhere in the repository — verified across `src/`, the nine test files touching `.debug`, `bench/`, `scripts/` and `README.md`.

- [ ] **Step 1: Write the failing test**

Append to `tests/browser/debug.test.ts`, following that file's existing client setup:

```ts
it('names the client the way its log lines are prefixed', async () => {
  const db = createSQLiteClient('debug-name.db', {
    vfs: 'IDBBatchAtomicVFS',
    name: 'ledger',
    debug: true,
  });
  onTestFinished(() => db.close());
  expect(db.debug?.name).toBe('ledger 1');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec rstest --project browser tests/browser/debug.test.ts`
Expected: FAIL — received `'ledger'`, expected `'ledger 1'`.

- [ ] **Step 3: Rename and rewire**

Use Serena `replace_content` on `src/client.ts` and `src/pool.ts`. Six mechanical sites plus one behaviour change:

`src/client.ts:303`
```ts
  const clientName = `${clientOptions.name ?? 'SQLite'} ${clientIndex}`;
```

`src/client.ts:499`
```ts
    typeof debugOption === 'string' ? debugOption : clientName;
```

`src/client.ts:503` — the behaviour change:
```ts
          name: clientName,
```

`src/client.ts:1112` — inside the `createPoolWorker({ … })` call:
```ts
      clientName,
```

`src/pool.ts:128`
```ts
  clientName: string;
```

`src/pool.ts:149`
```ts
    clientName,
```

`src/pool.ts:162`
```ts
  const workerName = `${clientName} / Worker ${index + 1}`;
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS, 566 tests. Nothing else reads `debug.name`, so no other test moves.

- [ ] **Step 5: Format, then commit**

```bash
pnpm check
git add src/client.ts src/pool.ts tests/browser/debug.test.ts
git commit -m "feat(debug)!: db.debug.name carries the client name, index included"
```

---

### Task 4: The marker is held for the client's life

**Files:**
- Modify: `src/client.ts` (mint the UUID near `clientName`; hold beside the `bsq:conn` hold at ~543; release in `close()` beside `connRelease?.()` at ~1058)
- Test: `tests/browser/inspect-marker.test.ts` (create)

**Interfaces:**
- Consumes: `clientMarkerName` (Task 1), `Locks.entries` (Task 2).
- Produces: an in-module `clientUuid: string` and `markerName: string | undefined` inside `createSQLiteClient`, both consumed by Task 8. `markerName` is `undefined` exactly when `sharesStorage(vfs)` is false.

Named `clientUuid`, not `clientId`: `clientId` in this codebase now means a Web Locks realm, and one word for two things is what Task 3 just removed.

- [ ] **Step 1: Write the failing tests**

Create `tests/browser/inspect-marker.test.ts`:

```ts
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { createLocks, parseClientMarker } from '../../src/locks';

const VFS = 'IDBBatchAtomicVFS' as const;
const locks = createLocks();

const markersFor = async (file: string) => {
  const { held } = await locks.entries();
  return held
    .map((entry) => parseClientMarker(entry.name, VFS, file))
    .filter((marker) => marker !== undefined);
};

describe('the client liveness marker', () => {
  it('is held while the client lives and gone after close', async () => {
    const file = 'marker-life.db';
    const db = createSQLiteClient(file, { vfs: VFS, name: 'ledger' });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });

    await db.read('SELECT 1');
    const during = await markersFor(file);
    expect(during).toHaveLength(1);
    expect(during[0]?.name).toBe('ledger 1');
    expect(during[0]?.vfs).toBe(VFS);

    await db.close();
    expect(await markersFor(file)).toHaveLength(0);
  });

  it('gives one marker per client in the same tab', async () => {
    const file = 'marker-two.db';
    const a = createSQLiteClient(file, { vfs: VFS });
    const b = createSQLiteClient(file, { vfs: VFS });
    onTestFinished(async () => {
      await Promise.all([a.close(), b.close()]).catch(() => {});
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });

    await Promise.all([a.read('SELECT 1'), b.read('SELECT 1')]);
    const markers = await markersFor(file);
    expect(markers).toHaveLength(2);
    expect(new Set(markers.map((m) => m?.id)).size).toBe(2);
  });

  it('holds no marker on the memory VFS', async () => {
    const db = createSQLiteClient('marker-mem.db', { vfs: 'MemoryVFS' });
    onTestFinished(() => db.close());
    await db.read('SELECT 1');
    const { held } = await locks.entries();
    expect(held.some((e) => e.name.startsWith('bsq:client:'))).toBe(false);
  });

  it('does not change what deleteDatabase reports', async () => {
    const file = 'marker-delete.db';
    const db = createSQLiteClient(file, { vfs: VFS });
    await db.read('SELECT 1');

    await expect(deleteDatabase(file, { vfs: VFS })).rejects.toMatchObject({
      code: 'DATABASE_IN_USE',
    });

    await db.close();
    await deleteDatabase(file, { vfs: VFS });

    await expect(deleteDatabase(file, { vfs: VFS })).rejects.toMatchObject({
      code: 'DATABASE_NOT_FOUND',
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec rstest --project browser tests/browser/inspect-marker.test.ts`
Expected: FAIL — the first test gets 0 markers where it expects 1. The `deleteDatabase` test PASSES already; that is the point of it — it is the guard that must never start failing.

- [ ] **Step 3: Implement**

In `src/client.ts`, beside `clientName` (~line 303):

```ts
  // Identity for the roster: `clientName` is a label two tabs can both produce,
  // this is what tells two clients apart across the origin.
  const clientUuid = crypto.randomUUID();
```

Beside the existing `connLockPromise` (~line 543), add a second hold. It is deliberately NOT chained onto `connLockPromise`: nothing waits for this one, because nothing contends for it.

```ts
  /**
   * The roster marker: a liveness lock nobody contends, released by the browser
   * if this tab dies without closing. `undefined` on the memory VFS, on the
   * same condition as `bsq:conn` — two clients there are two databases.
   */
  const markerName: string | undefined = sharesStorage(vfs)
    ? clientMarkerName(vfs, dbFile, clientUuid, clientName)
    : undefined;
  let markerRelease: (() => void) | undefined;
  if (markerName !== undefined) {
    void locks
      .hold(markerName, { mode: 'shared' })
      .then((release) => {
        markerRelease = release;
      })
      .catch(() => {
        // A marker that cannot be taken costs observability, never correctness:
        // occupancy is `bsq:conn`'s job. Never fail an open over it.
      });
  }
```

In `close()`, beside `connRelease?.()` (~line 1058):

```ts
      markerRelease?.();
```

Add `clientMarkerName` to the existing import from `./locks`.

- [ ] **Step 4: Run the new file, then the whole suite**

Run: `pnpm exec rstest --project browser tests/browser/inspect-marker.test.ts`
Expected: PASS, 4 tests.

Run: `pnpm test`
Expected: PASS, 570 tests.

- [ ] **Step 5: Format, then commit**

```bash
pnpm check
git add src/client.ts tests/browser/inspect-marker.test.ts
git commit -m "feat(client): hold a liveness marker naming this client"
```

---

### Task 5: The caller's realm

**Files:**
- Create: `src/inspect.ts`
- Test: `tests/browser/inspect-realm.test.ts` (create)

**Interfaces:**
- Consumes: `Locks`, `LockEntries` (Task 2).
- Produces: `resolveRealmId(locks: Locks, snapshot: LockEntries, ownMarkerName?: string): Promise<string>`, memoized at module scope for the realm's lifetime.

- [ ] **Step 1: Write the failing tests**

Create `tests/browser/inspect-realm.test.ts`:

```ts
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { resolveRealmId } from '../../src/inspect';
import { createLocks } from '../../src/locks';

const locks = createLocks();

describe('resolveRealmId', () => {
  it('is stable across calls', async () => {
    const first = await resolveRealmId(locks, await locks.entries());
    const second = await resolveRealmId(locks, await locks.entries());
    expect(first).toBe(second);
    expect(first).not.toBe('');
  });

  it('matches the realm holding our own client marker', async () => {
    const file = 'realm-id.db';
    const db = createSQLiteClient(file, { vfs: 'IDBBatchAtomicVFS' });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs: 'IDBBatchAtomicVFS' }).catch(() => {});
    });
    await db.read('SELECT 1');

    const snapshot = await locks.entries();
    const mine = snapshot.held.find((e) => e.name.startsWith('bsq:client:'));
    expect(mine).toBeDefined();
    expect(await resolveRealmId(locks, snapshot)).toBe(mine?.clientId);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec rstest --project browser tests/browser/inspect-realm.test.ts`
Expected: FAIL — cannot resolve `../../src/inspect`.

- [ ] **Step 3: Implement**

Create `src/inspect.ts`:

```ts
import { SQLiteError } from './errors';
import type { LockEntries, Locks } from './locks';

/**
 * The Web Locks `clientId` of THIS realm.
 *
 * There is no API that returns it, so it is read back out of the registry: hold
 * a name nobody else can have, then find that name's entry. A realm's id is
 * stable for its whole life, so this is paid once, ever — and not even once
 * when a marker of ours is already in the snapshot.
 *
 * Module scope is exactly the right scope: an iframe has its own module
 * instance and its own id, which is what makes `sameTab` mean anything.
 */
let cachedRealmId: string | undefined;

export const resolveRealmId = async (
  locks: Locks,
  snapshot: LockEntries,
  ownMarkerName?: string,
): Promise<string> => {
  if (cachedRealmId !== undefined) return cachedRealmId;

  if (ownMarkerName !== undefined) {
    const mine = snapshot.held.find((entry) => entry.name === ownMarkerName);
    if (mine) {
      cachedRealmId = mine.clientId;
      return cachedRealmId;
    }
  }

  const nonce = `bsq:realm:${crypto.randomUUID()}`;
  const release = await locks.hold(nonce, { mode: 'shared' });
  try {
    const fresh = await locks.entries();
    const mine = fresh.held.find((entry) => entry.name === nonce);
    if (!mine) {
      // A registry that does not report a lock we are holding cannot answer
      // `sameTab` either. Saying so beats reporting every client as elsewhere.
      throw new SQLiteError(
        'UNSUPPORTED',
        'This browser does not report lock holders, so clients cannot be located.',
      );
    }
    cachedRealmId = mine.clientId;
    return cachedRealmId;
  } finally {
    release();
  }
};
```

`UNSUPPORTED` does not exist yet — add it now to `src/errors.ts`, at the end of the `SQLiteErrorCode` union, with the union's own doc paragraph extended:

```ts
  | 'READ_ONLY_TRANSACTION'
  | 'UNSUPPORTED';
```

And append to the `SQLiteErrorCode` doc comment:

```
 * `UNSUPPORTED` means the platform cannot answer the question — raised by
 * `inspectDatabase` where Web Locks is missing, because reporting zero clients
 * there would be indistinguishable from a database nobody holds.
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec rstest --project browser tests/browser/inspect-realm.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Format, then commit**

```bash
pnpm check
git add src/inspect.ts src/errors.ts tests/browser/inspect-realm.test.ts
git commit -m "feat(inspect): resolve and memoize this realm's lock client id"
```

---

### Task 6: `inspectDatabase` — the roster

**Files:**
- Modify: `src/inspect.ts`, `src/index.ts`
- Test: `tests/unit/inspect.test.ts` (create), `tests/browser/inspect.test.ts` (create)

**Interfaces:**
- Consumes: `parseClientMarker`, `namespaceFor`, `sharesStorage` (`locks.ts`), `normalizeDatabaseFile` (`utils.ts`), `resolveRealmId` (Task 5), `VFS_CAPABILITIES` (`types.ts`).
- Produces:
  - `type DatabaseClient = { id; name; tab; sameTab; vfs }`
  - `type InspectionBase = { file; vfs; tabs; write: { tab; sameTab; waiting } }`
  - `type DatabaseInspection = InspectionBase & { clients: readonly DatabaseClient[] }`
  - `inspectWith(locks: Locks, file: string, vfs: SQLiteVFS, ownMarkerName?: string): Promise<DatabaseInspection>` — internal, consumed by Task 8
  - `inspectDatabase(options: { file: string; vfs: SQLiteVFS }): Promise<DatabaseInspection>` — public

The `write` block is filled by Task 7. This task returns `{ tab: null, sameTab: false, waiting: 0 }` and Task 7's tests are what make it real — the field exists from the start so no consumer sees the shape change.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/inspect.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { inspectWith } from '../../src/inspect';
import { clientMarkerName, noOpLocks, type Locks } from '../../src/locks';

const ID_A = '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a90';
const ID_B = '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a91';

const stubLocks = (held: { name: string; clientId: string }[]): Locks =>
  ({
    ...noOpLocks,
    available: true,
    entries: async () => ({
      held: held.map((h) => ({ ...h, mode: 'shared' as const })),
      pending: [],
    }),
    hold: async () => () => {},
  }) as Locks;

describe('inspectWith', () => {
  it('counts one tab for two clients in one realm', async () => {
    const marker = (id: string) =>
      clientMarkerName('OPFSAdaptiveVFS', 'app.db', id, 'SQLite 1');
    const locks = stubLocks([
      { name: marker(ID_A), clientId: 'r1' },
      { name: marker(ID_B), clientId: 'r1' },
    ]);
    const result = await inspectWith(
      locks,
      'app.db',
      'OPFSAdaptiveVFS',
      marker(ID_A),
    );
    expect(result.clients).toHaveLength(2);
    expect(result.tabs).toBe(1);
  });

  it('counts two tabs for two realms', async () => {
    const marker = (id: string) =>
      clientMarkerName('OPFSAdaptiveVFS', 'app.db', id, 'SQLite 1');
    const locks = stubLocks([
      { name: marker(ID_A), clientId: 'r1' },
      { name: marker(ID_B), clientId: 'r2' },
    ]);
    const result = await inspectWith(
      locks,
      'app.db',
      'OPFSAdaptiveVFS',
      marker(ID_A),
    );
    expect(result.tabs).toBe(2);
    expect(result.clients.filter((c) => c.sameTab)).toHaveLength(1);
  });

  it('ignores locks that are not our markers', async () => {
    const locks = stubLocks([
      { name: 'bsq:write:opfs:app.db', clientId: 'r1' },
      { name: 'someone-elses-lock', clientId: 'r1' },
      {
        name: clientMarkerName('OPFSAdaptiveVFS', 'app.db', ID_A, 'SQLite 1'),
        clientId: 'r1',
      },
    ]);
    const result = await inspectWith(locks, 'app.db', 'OPFSAdaptiveVFS');
    expect(result.clients).toHaveLength(1);
  });
});
```

Add the degenerate cases in the same file:

```ts
import { inspectDatabase } from '../../src/inspect';

describe('inspectDatabase degenerate cases', () => {
  it('rejects the memory VFS with INVALID_OPTION', async () => {
    await expect(
      inspectDatabase({ file: 'app.db', vfs: 'MemoryVFS' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  it('rejects an unknown VFS with INVALID_OPTION', async () => {
    await expect(
      inspectDatabase({ file: 'app.db', vfs: 'NoSuchVFS' as never }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  it('rejects with UNSUPPORTED where Web Locks is missing', async () => {
    // The unit project runs on Node, where `navigator.locks` is absent, so
    // `createLocks()` falls back to `noOpLocks` with no stubbing at all.
    await expect(
      inspectDatabase({ file: 'app.db', vfs: 'OPFSAdaptiveVFS' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec rstest --project unit tests/unit/inspect.test.ts`
Expected: FAIL — `inspectWith` / `inspectDatabase` are not exported.

- [ ] **Step 3: Implement**

Append to `src/inspect.ts`:

```ts
import {
  clientMarkerName,
  createLocks,
  namespaceFor,
  parseClientMarker,
  sharesStorage,
  writeLockName,
} from './locks';
import type { SQLiteVFS } from './types';
import { VFS_CAPABILITIES } from './types';
import { normalizeDatabaseFile } from './utils';

/** One live client on a database. */
export type DatabaseClient = {
  readonly id: string;
  readonly name: string;
  /** The realm holding it. Every client in one tab reports the same value. */
  readonly tab: string;
  /** That realm is the caller's. A same-origin iframe is another tab here. */
  readonly sameTab: boolean;
  /** Four VFS share the `opfs` namespace, and therefore the file. */
  readonly vfs: SQLiteVFS;
};

export type InspectionBase = {
  readonly file: string;
  readonly vfs: SQLiteVFS;
  /** Distinct realms among the clients. */
  readonly tabs: number;
  readonly write: {
    /** The realm writing now, never the client. `null` when nobody writes. */
    readonly tab: string | null;
    /** Always false when `tab` is null. */
    readonly sameTab: boolean;
    /** Writers queued behind it, across the whole origin. */
    readonly waiting: number;
  };
};

export type DatabaseInspection = InspectionBase & {
  readonly clients: readonly DatabaseClient[];
};

/**
 * The census, given locks that are already known to work.
 *
 * ONE `entries()` call answers everything, so the roster, the writer and the
 * queue describe the same instant. Two calls would give three truths.
 */
export const inspectWith = async (
  locks: Locks,
  file: string,
  vfs: SQLiteVFS,
  ownMarkerName?: string,
): Promise<DatabaseInspection> => {
  const snapshot = await locks.entries();
  const realm = await resolveRealmId(locks, snapshot, ownMarkerName);

  const clients: DatabaseClient[] = [];
  for (const entry of snapshot.held) {
    const marker = parseClientMarker(entry.name, vfs, file);
    if (!marker) continue;
    clients.push({
      id: marker.id,
      name: marker.name,
      tab: entry.clientId,
      sameTab: entry.clientId === realm,
      vfs: marker.vfs,
    });
  }

  return {
    file,
    vfs,
    clients,
    tabs: new Set(clients.map((client) => client.tab)).size,
    write: { tab: null, sameTab: false, waiting: 0 },
  };
};

/**
 * Who is live on a database, without opening it.
 *
 * This is a snapshot, stale the instant it resolves. It informs a UI; it never
 * authorizes an action — `deleteDatabase` raising `DATABASE_IN_USE` is the only
 * authority on whether a database can be removed.
 */
export const inspectDatabase = async (options: {
  file: string;
  vfs: SQLiteVFS;
}): Promise<DatabaseInspection> => {
  const { vfs } = options;
  if (!Object.hasOwn(VFS_CAPABILITIES, vfs)) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `Unknown vfs '${String(vfs)}'. Supported: ${Object.keys(VFS_CAPABILITIES).join(', ')}.`,
    );
  }
  if (!sharesStorage(vfs)) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `${vfs} keeps its pages in the worker that opened them, so two clients are two databases and there is nothing to inspect. Ask this of a persistent VFS.`,
    );
  }

  const locks = createLocks();
  if (!locks.available) {
    throw new SQLiteError(
      'UNSUPPORTED',
      'The Web Locks API is unavailable, so clients on a database cannot be counted. Reporting zero would be indistinguishable from a database nobody holds.',
    );
  }

  return inspectWith(locks, normalizeDatabaseFile(options.file), vfs);
};
```

`namespaceFor`, `clientMarkerName` and `writeLockName` are imported for Tasks 7 and 8; biome will flag them as unused until then, so import only `createLocks`, `parseClientMarker`, `sharesStorage` in this task and add the rest when used.

Export from `src/index.ts`, beside the other named exports:

```ts
export {
  type DatabaseClient,
  type DatabaseInspection,
  inspectDatabase,
  type InspectionBase,
} from './inspect';
```

- [ ] **Step 4: Run the unit file, then the browser one**

Run: `pnpm exec rstest --project unit tests/unit/inspect.test.ts`
Expected: PASS, 6 tests.

Now create `tests/browser/inspect.test.ts` for the real registry:

```ts
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { inspectDatabase } from '../../src/inspect';
import { makeRealm } from './helpers/realm';

const VFS = 'IDBBatchAtomicVFS' as const;

describe('inspectDatabase', () => {
  it('reports nobody on a database nothing holds', async () => {
    const result = await inspectDatabase({ file: 'nobody.db', vfs: VFS });
    expect(result.clients).toEqual([]);
    expect(result.tabs).toBe(0);
  });

  it('normalizes the file the way the client does', async () => {
    const db = createSQLiteClient('norm.db', { vfs: VFS });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase('norm.db', { vfs: VFS }).catch(() => {});
    });
    await db.read('SELECT 1');
    const viaDotSlash = await inspectDatabase({ file: './norm.db', vfs: VFS });
    expect(viaDotSlash.clients).toHaveLength(1);
  });

  it('separates tabs and marks only the caller as sameTab', async () => {
    const file = 'two-tabs.db';
    const db = createSQLiteClient(file, { vfs: VFS });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });
    await db.read('SELECT 1');

    // A marker held from a second realm, built with the same rule the client
    // uses. `holdIn` is the existing helper; the iframe is what makes the
    // clientId differ, and that is the whole of what `sameTab` reads.
    const foreign = clientMarkerName(
      VFS,
      file,
      '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a99',
      'SQLite 1',
    );
    const realm = await makeRealm();
    const release = await holdIn(realm, foreign, 'shared');
    onTestFinished(() => release());

    const result = await inspectDatabase({ file, vfs: VFS });
    expect(result.clients).toHaveLength(2);
    expect(result.tabs).toBe(2);
    expect(result.clients.filter((c) => c.sameTab)).toHaveLength(1);
    expect(result.clients.find((c) => !c.sameTab)?.id).toBe(
      '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a99',
    );
  });

  it('drops a marker whose realm was torn down without closing', async () => {
    const file = 'torn-down.db';
    const foreign = clientMarkerName(
      VFS,
      file,
      '0189d4a2-4f3c-7b1e-9c8a-2f5b6d7e8a98',
      'SQLite 1',
    );
    const realm = await makeRealm();
    await holdIn(realm, foreign, 'shared');
    expect((await inspectDatabase({ file, vfs: VFS })).clients).toHaveLength(1);

    // No release() and no close(): the iframe simply goes, the way a tab does.
    // The browser reclaiming the lock is the whole reason this is a lock and
    // not a registry entry with a timestamp.
    realm.frameElement?.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await inspectDatabase({ file, vfs: VFS })).clients).toHaveLength(0);
  });
});
```

Import `clientMarkerName` from `../../src/locks` and `holdIn`, `makeRealm` from
`./helpers/realm` at the top of that file.

Run: `pnpm exec rstest --project browser tests/browser/inspect.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Format, then commit**

```bash
pnpm check
git add src/inspect.ts src/index.ts tests/unit/inspect.test.ts tests/browser/inspect.test.ts
git commit -m "feat(inspect): report the live clients on a database"
```

---

### Task 7: The write block

**Files:**
- Modify: `src/inspect.ts` (`inspectWith`)
- Test: `tests/browser/inspect-write.test.ts` (create)

**Interfaces:**
- Consumes: `writeLockName(vfs, file)` from `locks.ts`.
- Produces: `write.tab`, `write.sameTab`, `write.waiting` populated from the same snapshot.

- [ ] **Step 1: Write the failing test**

Create `tests/browser/inspect-write.test.ts`:

```ts
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { inspectDatabase } from '../../src/inspect';

const VFS = 'IDBBatchAtomicVFS' as const;

describe('inspectDatabase write', () => {
  it('is empty when nobody writes', async () => {
    const result = await inspectDatabase({ file: 'quiet.db', vfs: VFS });
    expect(result.write).toEqual({ tab: null, sameTab: false, waiting: 0 });
  });

  it('names the writing tab and counts who waits', async () => {
    const file = 'writing.db';
    const a = createSQLiteClient(file, { vfs: VFS });
    const b = createSQLiteClient(file, { vfs: VFS });
    onTestFinished(async () => {
      await Promise.all([a.close(), b.close()]).catch(() => {});
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });
    await a.write('CREATE TABLE t (v)');

    let seen: Awaited<ReturnType<typeof inspectDatabase>> | undefined;
    let releaseCallback!: () => void;
    const inside = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });

    const held = a.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
      // A second writer queues behind this transaction's origin-wide lock.
      const queued = b.write('INSERT INTO t VALUES (2)');
      seen = await inspectDatabase({ file, vfs: VFS });
      releaseCallback();
      return queued;
    });

    await inside;
    await held;

    expect(seen?.write.tab).not.toBeNull();
    expect(seen?.write.sameTab).toBe(true);
    expect(seen?.write.waiting).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec rstest --project browser tests/browser/inspect-write.test.ts`
Expected: FAIL — `write.tab` is `null` inside a live write transaction.

- [ ] **Step 3: Implement**

In `src/inspect.ts`, add `writeLockName` to the `./locks` import, and replace the hard-coded `write` block in `inspectWith`:

```ts
  const writeName = writeLockName(vfs, file);
  const writer = snapshot.held.find((entry) => entry.name === writeName);
  const waiting = snapshot.pending.filter(
    (entry) => entry.name === writeName,
  ).length;

  return {
    file,
    vfs,
    clients,
    tabs: new Set(clients.map((client) => client.tab)).size,
    write: {
      tab: writer?.clientId ?? null,
      sameTab: writer !== undefined && writer.clientId === realm,
      waiting,
    },
  };
```

- [ ] **Step 4: Run the file, then the whole suite**

Run: `pnpm exec rstest --project browser tests/browser/inspect-write.test.ts`
Expected: PASS, 2 tests.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Format, then commit**

```bash
pnpm check
git add src/inspect.ts tests/browser/inspect-write.test.ts
git commit -m "feat(inspect): report the writing tab and its queue"
```

---

### Task 8: `db.inspect()` and the five getters

**Files:**
- Modify: `src/client.ts` (the returned object ~1270), `src/api.ts` (the `SQLiteDB` type ~356 and `debug` at 423), `src/inspect.ts` (add `ClientInspection`), `src/index.ts`
- Test: `tests/browser/inspect-client.test.ts` (create)

**Interfaces:**
- Consumes: `inspectWith` (Task 6), `clientUuid` and `markerName` (Task 4), `closing` (already in `client.ts`).
- Produces: `db.id`, `db.name`, `db.file`, `db.vfs`, `db.build` (readonly getters) and `db.inspect(): Promise<ClientInspection>`.
- `type ClientInspection = InspectionBase & { self: DatabaseClient | null; siblings: readonly DatabaseClient[] }`

- [ ] **Step 1: Write the failing tests**

Create `tests/browser/inspect-client.test.ts`:

```ts
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';

const VFS = 'IDBBatchAtomicVFS' as const;

describe('db identity getters', () => {
  it('describes itself without the debug option', async () => {
    const db = createSQLiteClient('./ident.db', { vfs: VFS, name: 'ledger' });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase('ident.db', { vfs: VFS }).catch(() => {});
    });
    expect(db.debug).toBeUndefined();
    expect(db.name).toBe('ledger 1');
    expect(db.file).toBe('ident.db');
    expect(db.vfs).toBe(VFS);
    expect(db.build).toBe('async');
    expect(db.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe('db.inspect', () => {
  it('splits self from siblings', async () => {
    const file = 'siblings.db';
    const a = createSQLiteClient(file, { vfs: VFS });
    const b = createSQLiteClient(file, { vfs: VFS });
    onTestFinished(async () => {
      await Promise.all([a.close(), b.close()]).catch(() => {});
      await deleteDatabase(file, { vfs: VFS }).catch(() => {});
    });
    await Promise.all([a.read('SELECT 1'), b.read('SELECT 1')]);

    const view = await a.inspect();
    expect(view.self?.id).toBe(a.id);
    expect(view.siblings).toHaveLength(1);
    expect(view.siblings[0]?.id).toBe(b.id);
    expect(view.tabs).toBe(1);
    expect('clients' in view).toBe(false);
  });

  it('throws CLIENT_CLOSED after close', async () => {
    const file = 'closed.db';
    const db = createSQLiteClient(file, { vfs: VFS });
    await db.read('SELECT 1');
    await db.close();
    onTestFinished(() => deleteDatabase(file, { vfs: VFS }).catch(() => {}));
    await expect(db.inspect()).rejects.toMatchObject({
      code: 'CLIENT_CLOSED',
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec rstest --project browser tests/browser/inspect-client.test.ts`
Expected: FAIL — `db.name` is undefined, `db.inspect is not a function`.

- [ ] **Step 3: Implement**

In `src/inspect.ts`:

```ts
export type ClientInspection = InspectionBase & {
  /** This client, or `null` once it has stopped holding its marker. */
  readonly self: DatabaseClient | null;
  readonly siblings: readonly DatabaseClient[];
};
```

In `src/client.ts`, add `import { inspectWith } from './inspect';` and the
`ClientInspection` type import, then before the returned object:

```ts
  /**
   * The census, from this client's point of view.
   *
   * Throws `CLIENT_CLOSED` like every other method: a uniform contract on `db`
   * is worth more than one method a consumer must read the docs to know
   * survives. After closing, `inspectDatabase({ file, vfs })` answers the same
   * question, and `db.file` / `db.vfs` are what make it reachable.
   */
  const inspect = async (): Promise<ClientInspection> => {
    if (closing) {
      throw new SQLiteError(
        'CLIENT_CLOSED',
        'The SQLite client has been closed.',
      );
    }
    const { clients, ...base } = await inspectWith(
      locks,
      dbFile,
      vfs,
      markerName,
    );
    return {
      ...base,
      self: clients.find((client) => client.id === clientUuid) ?? null,
      siblings: clients.filter((client) => client.id !== clientUuid),
    };
  };
```

And in the returned object literal (~1270), beside `close` and `debug`:

```ts
    get id() {
      return clientUuid;
    },
    get name() {
      return clientName;
    },
    get file() {
      return dbFile;
    },
    get vfs() {
      return vfs;
    },
    get build() {
      return build;
    },
    inspect,
```

In `src/api.ts`, import `ClientInspection` from `./inspect` and `SQLiteBuild`
from `./types` if absent, then extend `SQLiteDB`:

```ts
  /** This client's UUID, unique across the origin. */
  readonly id: string;
  /** This client's label, index included — what its log lines are prefixed with. */
  readonly name: string;
  /** The database file, normalized: the identity every lock name is built on. */
  readonly file: string;
  readonly vfs: SQLiteVFS;
  /** The build actually loaded, resolved by `defaultBuildFor` when not passed. */
  readonly build: SQLiteBuild;
  /**
   * Who else is live on this database, right now, in every tab of this origin.
   *
   * A snapshot, stale the instant it resolves: it informs a UI and never
   * authorizes an action. Poll it if you want it to move — each call is a fresh
   * census costing well under a tenth of a millisecond, and it takes no lock,
   * so it cannot slow a query down.
   */
  inspect: () => Promise<ClientInspection>;
```

Export `ClientInspection` from `src/index.ts` alongside the Task 6 exports.

- [ ] **Step 4: Run the file, then the whole suite**

Run: `pnpm exec rstest --project browser tests/browser/inspect-client.test.ts`
Expected: PASS, 3 tests.

Run: `pnpm test` and `pnpm exec tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Format, then commit**

```bash
pnpm check
git add src/client.ts src/api.ts src/inspect.ts src/index.ts tests/browser/inspect-client.test.ts
git commit -m "feat(client): db.inspect() and the five identity getters"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md` (line 283's option row; a new subsection after the VFS table's notes; the error-code table at ~440)
- Modify: `CHANGELOG.md` (the `Unreleased` section)

**Interfaces:**
- Consumes: the whole surface, as shipped.
- Produces: nothing consumed by code.

- [ ] **Step 1: Fix the stale phrase at README line 283**

Replace `` `true` falls back to the client prefix (e.g. `"SQLite 1"`) `` with `` `true` falls back to the client name (e.g. `"SQLite 1"`) ``, so the README, the logger, `db.name` and the roster marker all say one word.

- [ ] **Step 2: Document the surface**

Add a `### Inspecting a database` subsection, in the README's voice — constraints first, no investigation:

```markdown
### Inspecting a database

`inspectDatabase({ file, vfs })` reports who is live on a database **without
opening it**, and `db.inspect()` answers the same from a client you already
hold. Both resolve with the file, the VFS, the number of distinct tabs, the
roster, and the state of the write lock.

`inspectDatabase` returns `clients`; `db.inspect()` splits the same list into
`self` and `siblings`, and `self` is `null` once the client has been closed.

**"Tab" means realm.** A same-origin iframe in your own page is a different
tab here: it has its own `clientId`, so `sameTab` is `false` for it.

**A snapshot, never a permission.** It is stale the instant it resolves. An
empty roster does not mean a database can be deleted — a tab may open between
the two calls, and `deleteDatabase` raising `DATABASE_IN_USE` remains the only
authority. An empty roster also does not distinguish a database nobody holds
from one that does not exist; `DATABASE_NOT_FOUND` is what says that.

**Polling is on the call.** Nothing is kept between two calls, and there is no
event to subscribe to. A call costs well under a tenth of a millisecond, takes
no lock and makes no worker round trip, so polling cannot slow a query down —
300–500 ms is a comfortable cadence. Do not stack calls: a background tab has
its timers throttled, and an interval that fires without awaiting the previous
answer will queue them up.

`MemoryVFS` and `MemoryAsyncVFS` throw `INVALID_OPTION`: their pages live in
the worker that opened them, so two clients are two databases and there is
nothing to share. Where the Web Locks API is missing, both throw
`UNSUPPORTED` rather than report zero.
```

- [ ] **Step 3: Add `UNSUPPORTED` to the README error table (~line 440)**

```markdown
| `UNSUPPORTED` | The platform cannot answer. Raised by `inspectDatabase` and `db.inspect()` where the Web Locks API is unavailable — reporting zero clients there would be indistinguishable from a database nobody holds. |
```

- [ ] **Step 4: Write the CHANGELOG entries**

Under `### Breaking`:

```markdown
- **`db.debug.name` now carries the client name with its index**, e.g.
  `"SQLite 1"` where it used to report `"SQLite"`. The old value was the bare
  `name` option, identical for every client that passed nothing, so it
  identified nothing even within one tab. It is now the same string the `debug`
  logger prefixes its lines with and the same one the roster reports.
```

Under `### Added`:

```markdown
- **`inspectDatabase({ file, vfs })` and `db.inspect()` report who is live on a
  database**, across every tab of the origin: one entry per client with its id,
  name, tab and VFS, the number of distinct tabs, and the write lock's holder
  with the number of writers queued behind it. `inspectDatabase` needs no open
  client, which is the point — the question usually arrives from outside.
  **It is observability, not a permission:** the answer is stale the instant it
  resolves, and `deleteDatabase` remains the only authority on whether a
  database can be removed.
- **`db.id`, `db.name`, `db.file`, `db.vfs` and `db.build`** — readonly, and
  available whether or not `debug` is on, so a module handed a client can
  describe it without being handed its options too.
- **`UNSUPPORTED` is a new error code**, raised where the Web Locks API is
  unavailable.
```

- [ ] **Step 5: Verify, then commit**

Run: `pnpm test` and `pnpm exec tsc --noEmit`
Expected: PASS / clean. (Docs only, but the hook runs the suite anyway.)

```bash
pnpm check
git add README.md CHANGELOG.md
git commit -m "docs: document database inspection and its two new codes"
```

---

## After the plan

`mem:measurements` states an origin-lock budget of "≤ 1 marker per tab per database". This work adds a second marker per client. The figure stays far from the 450-lock threshold, but the sentence becomes false — correct it when this branch merges, not before.
