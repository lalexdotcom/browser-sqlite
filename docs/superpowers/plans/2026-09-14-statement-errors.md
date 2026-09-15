# A failed statement says why — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every statement SQLite refuses rejects with `SQLiteError` code `STATEMENT_FAILED`,
carrying SQLite's primary result code on `sqliteCode` and, when SQLite reports a subtype, its
extended one on `sqliteExtendedCode`. Opens and deletes that SQLite fails keep `WORKER_CRASHED`
but carry `sqliteCode`. `SQLITE_CODES` (primary) and `SQLITE_EXTENDED_CODES` (extended) export
every result code by name.

**Architecture:** The worker already sends `sqliteCode` for every SQLite failure. The client
drops it in `workerError` (`src/pool.ts`), in the `open-error` case of the same file, and in the
`error` case of `src/delete.ts`. Two pure functions in `pool.ts` replace those three sites. The
worker reads the extended code with `module._sqlite3_extended_errcode(db)` **where the statement
fails**, stamps it on wa-sqlite's error, and sends it on the wire.

**Tech Stack:** TypeScript, the vendored wa-sqlite v1.1.2 (SQLite 3.53.0; its `package.json`
still reads 1.1.1), rstest (a `unit` Node project plus
Chromium and Firefox browser projects), biome.

**Spec:** `docs/superpowers/specs/2026-09-14-statement-errors-design.md`. Read it, not a summary
of it. Its amendment of 2026-09-15 (D8, D9) is part of it.

## Global Constraints

- **Serena rule.** Serena's symbolic tools are primary for code: explore with
  `get_symbols_overview` and `find_symbol` (`include_body`), and edit with `replace_symbol_body`,
  `insert_after_symbol`/`insert_before_symbol`, `replace_content` and `rename_symbol`. Use the
  built-in Read, Edit and Grep on code files only as a fallback, when Serena fails. They are fine
  for `.md`, JSON and config files.
- **Forbidden, in every task:** `--no-verify`; setting `SKIP_SIMPLE_GIT_HOOKS`; touching
  `.git/hooks`; running `simple-git-hooks`, `pnpm install` or `pnpm store prune`.
- **Before each commit, and in this order:** run `pnpm check` (biome format and lint), then run
  `pnpm exec tsc --noEmit` yourself. If the pre-commit hook fails, stop and report its output
  verbatim. After committing, confirm with `git log --oneline -1` and `git show --stat HEAD`.
- **A task is done when `pnpm test` and `pnpm exec tsc --noEmit` both pass.** `pnpm test` prints
  THREE reports (Chromium plus unit, Firefox, isolated); read all three. Every commit lands on
  green.
- **Do not accept "pre-existing" for a failure without checking it on the base commit**
  (`git stash` is NOT allowed; use `git worktree add /tmp/base <sha>` and run the file there).
- The new public code is exactly `STATEMENT_FAILED`. The new field is exactly
  `sqliteExtendedCode`. The new exports are exactly `SQLITE_CODES` (the 31 primary codes) and
  `SQLITE_EXTENDED_CODES` (the 82 extended codes), keyed without the `SQLITE_` prefix.
- `sqliteExtendedCode` is present only when SQLite reported a subtype: the client drops it when
  it equals `sqliteCode` (spec D9). The worker sends it unfiltered.
- `sqliteCode` stays SQLite's **primary** code everywhere. Never enable
  `sqlite3_extended_result_codes` on the connection.
- The `message` of every error stays exactly as it is today.
- Code, comments and commit messages are in English.

## File map

| File | Change | Task |
|---|---|---|
| `src/errors.ts` | `STATEMENT_FAILED` in `SQLiteErrorCode`; the `sqliteExtendedCode` field and constructor option | 1 |
| `src/sqlite-codes.ts` | **new**: `SQLITE_CODES`, `SQLITE_EXTENDED_CODES` | 1 |
| `src/index.ts` | re-export both | 1 |
| `tests/unit/errors.test.ts`, `tests/unit/exports.test.ts` | one test each | 1 |
| `tests/unit/sqlite-codes.test.ts` | **new** | 1 |
| `src/pool.ts` | `subtypeOf` (D9); `busyFromCode` carries the extended code when it is a subtype; `workerError` renamed `statementError` and exported, with a `STATEMENT_FAILED` branch; new `startupError`; the `open-error` case uses it | 2 |
| `src/delete.ts` | the `error` case uses `startupError` | 2 |
| `tests/unit/statement-error.test.ts` | **new** | 2 |
| `src/wa-sqlite.d.ts` | declare `_sqlite3_extended_errcode` | 3 |
| `src/types.ts` | `sqliteExtendedCode` on the `error` message | 3 |
| `src/worker/worker.ts` | stamp the extended code where the statement fails; send it | 3 |
| `tests/browser/statement-errors.test.ts` | **new** | 3 |
| `tests/browser/tx-savepoint.test.ts` | one assertion in the F2 test | 3 |
| `API.md`, `CHANGELOG.md` | consumer documentation | 4 |

---

### Task 1: The public contract — `STATEMENT_FAILED`, `sqliteExtendedCode`, `SQLITE_CODES`, `SQLITE_EXTENDED_CODES`

**Files:**
- Modify: `src/errors.ts` (the header comment, `SQLiteErrorCode`, `SQLiteError`)
- Create: `src/sqlite-codes.ts`
- Modify: `src/index.ts`
- Test: `tests/unit/errors.test.ts`, `tests/unit/exports.test.ts`, and the new `tests/unit/sqlite-codes.test.ts`

**Interfaces:**
- Produces: `SQLiteErrorCode` includes `'STATEMENT_FAILED'`;
  `new SQLiteError(code, message, { cause?, sqliteCode?, sqliteExtendedCode?, timeout? })`;
  `SQLiteError#sqliteExtendedCode?: number`;
  `SQLITE_CODES: Readonly<{ OK: 0; …; CONSTRAINT: 19; …; DONE: 101 }>` and
  `SQLITE_EXTENDED_CODES: Readonly<{ ERROR_MISSING_COLLSEQ: 257; …; CONSTRAINT_UNIQUE: 2067; … }>`,
  both exported from `src/sqlite-codes.ts` and from the package entry.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('SQLiteError', …)` in `tests/unit/errors.test.ts`:

```ts
  // Falsifiable: drop the sqliteExtendedCode assignment in the constructor.
  it('carries sqliteExtendedCode when given one, and nothing otherwise', () => {
    const error = new SQLiteError(
      'STATEMENT_FAILED',
      'UNIQUE constraint failed: u.a',
      { sqliteCode: 19, sqliteExtendedCode: 2067 },
    );
    expect(error.name).toBe('STATEMENT_FAILED');
    expect(error.sqliteCode).toBe(19);
    expect(error.sqliteExtendedCode).toBe(2067);
    expect(
      new SQLiteError('CLIENT_CLOSED', 'closed').sqliteExtendedCode,
    ).toBeUndefined();
  });
```

Add after the test `'still exposes the client and the error type'` in
`tests/unit/exports.test.ts`:

```ts
  // Falsifiable: drop either re-export from src/index.ts.
  it('exposes the SQLite result codes, primary and extended', () => {
    expect(api.SQLITE_CODES.CONSTRAINT).toBe(19);
    expect(api.SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE).toBe(2067);
  });
```

Create `tests/unit/sqlite-codes.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import * as wa from 'wa-sqlite/src/sqlite-constants.js';
import { SQLITE_CODES, SQLITE_EXTENDED_CODES } from '../../src/sqlite-codes';

/**
 * docs/superpowers/specs/2026-09-14-statement-errors-design.md §4 (D8). The
 * tables are transcribed, so what can be checked mechanically is checked here.
 */
const constants = wa as unknown as Record<string, number>;

describe('SQLITE_CODES and SQLITE_EXTENDED_CODES', () => {
  // Falsifiable: mistype any value that wa-sqlite also defines — e.g.
  // CONSTRAINT_UNIQUE: 2068.
  it('agree with every result code wa-sqlite also defines', () => {
    const shared = [
      ...Object.entries(SQLITE_CODES),
      ...Object.entries(SQLITE_EXTENDED_CODES),
    ].filter(([name]) => `SQLITE_${name}` in constants);
    // 65 on the vendored wa-sqlite (v1.1.2). Guards the lookup, not the
    // tables: a broken import would otherwise let this pass having compared
    // nothing.
    expect(shared.length).toBeGreaterThanOrEqual(65);
    expect(
      shared.filter(([name, value]) => constants[`SQLITE_${name}`] !== value),
    ).toEqual([]);
  });

  // Falsifiable: move one code into the other table — e.g. CONSTRAINT_UNIQUE
  // into SQLITE_CODES.
  it('keep primary and extended codes apart', () => {
    const primary: number[] = Object.values(SQLITE_CODES);
    const extended: number[] = Object.values(SQLITE_EXTENDED_CODES);
    expect(primary.filter((v) => v >= 256)).toEqual([]);
    expect(extended.filter((v) => v < 256)).toEqual([]);
  });

  // Falsifiable: key an extended code under the wrong family — e.g.
  // IOERR_READ: 267, CORRUPT's low byte. Checks the family the NAME announces,
  // not merely that some primary code matches the low byte.
  it("give every extended code its name's family as low byte", () => {
    const family = SQLITE_CODES as Record<string, number>;
    expect(
      Object.entries(SQLITE_EXTENDED_CODES).filter(
        ([name, value]) =>
          family[name.slice(0, name.indexOf('_'))] !== (value & 0xff),
      ),
    ).toEqual([]);
  });

  // Falsifiable: drop one entry, or either Object.freeze.
  it('hold the 31 primary and 82 extended codes of SQLite 3.53.0, frozen', () => {
    expect(Object.keys(SQLITE_CODES)).toHaveLength(31);
    expect(Object.keys(SQLITE_EXTENDED_CODES)).toHaveLength(82);
    expect(Object.isFrozen(SQLITE_CODES)).toBe(true);
    expect(Object.isFrozen(SQLITE_EXTENDED_CODES)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm exec rstest run --project unit tests/unit/errors.test.ts tests/unit/exports.test.ts tests/unit/sqlite-codes.test.ts`
Expected: FAIL. `sqlite-codes.test.ts` cannot resolve `../../src/sqlite-codes`,
`exports.test.ts` reads `SQLITE_CODES` of undefined, and `errors.test.ts` fails the new
`sqliteExtendedCode` expectation.

- [ ] **Step 3: Extend `src/errors.ts`**

In the header comment above `SQLiteErrorCode`, append these lines before the closing `*/`:

```ts
 * `STATEMENT_FAILED` is a statement SQLite refused or failed for any reason
 * but a lock conflict — a constraint, a syntax error, a full disk. `message` is
 * SQLite's own; `sqliteCode` carries its result code, and `sqliteExtendedCode`
 * its subtype when SQLite reports one.
```

Add `| 'STATEMENT_FAILED'` to the `SQLiteErrorCode` union, directly after `| 'BUSY'`.

Replace the body of the class `SQLiteError` with:

```ts
export class SQLiteError extends Error {
  readonly code: SQLiteErrorCode;
  /**
   * SQLite's own numeric result code, present only when the failure came from
   * SQLite rather than from this library. Always the PRIMARY code. `BUSY`
   * covers both SQLITE_BUSY (5) and SQLITE_LOCKED (6); this is how a caller
   * tells them apart.
   */
  readonly sqliteCode?: number;
  /**
   * SQLite's extended result code, present only when a statement SQLite ran
   * failed WITH A SUBTYPE — `STATEMENT_FAILED` or `BUSY` from a query, never
   * an open or a delete: 2067 (`SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE`)
   * under `sqliteCode` 19. Absent when SQLite has no subtype for the failure
   * (a full disk, a syntax error), since `sqliteCode` already says it. When
   * present, `sqliteExtendedCode & 0xff === sqliteCode`.
   */
  readonly sqliteExtendedCode?: number;
  /**
   * The `timeout` that was exceeded, in milliseconds. Present only on
   * `OPERATION_TIMEOUT`, so a log need not parse the message for it.
   */
  readonly timeout?: number;

  constructor(
    code: SQLiteErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      sqliteCode?: number;
      sqliteExtendedCode?: number;
      timeout?: number;
    },
  ) {
    super(message, options);
    this.code = code;
    this.name = code;
    if (options?.sqliteCode !== undefined) this.sqliteCode = options.sqliteCode;
    if (options?.sqliteExtendedCode !== undefined)
      this.sqliteExtendedCode = options.sqliteExtendedCode;
    if (options?.timeout !== undefined) this.timeout = options.timeout;
  }
}
```

- [ ] **Step 4: Create `src/sqlite-codes.ts`**

```ts
/**
 * The result codes of SQLite 3.53.0, keyed without the `SQLITE_` prefix, in two
 * tables that match `SQLiteError`'s two fields: test the family on `sqliteCode`
 * against `SQLITE_CODES` (`CONSTRAINT`, `FULL`), the subtype on
 * `sqliteExtendedCode` against `SQLITE_EXTENDED_CODES` (`CONSTRAINT_UNIQUE`).
 * An extended code's low byte is its family (`2067 & 0xff === 19`), and its key
 * begins with the family's key. What each one means:
 * https://sqlite.org/rescode.html.
 *
 * Transcribed from `src/sqlite.h.in` — the source of `sqlite3.h` — at SQLite's
 * tag `version-3.53.0`, checked 2026-09-14. That is the SQLite of the vendored
 * wa-sqlite, v1.1.2 (its `package.json` still reads 1.1.1: upstream did not
 * bump it): its source-id, read from the wasm, is `2026-04-09 11:41:38
 * 4525003a53a7fc63ca75`, and the tag's `manifest.uuid` begins with the same
 * hash. Not read from wa-sqlite's `sqlite-constants.js`, which has no
 * `BUSY_*`, `LOCKED_*`, `CANTOPEN_*`, `CORRUPT_*` or `READONLY_*` codes;
 * `tests/unit/sqlite-codes.test.ts` checks every name the two share.
 * Re-transcribe when wa-sqlite moves to another SQLite.
 *
 * `sqliteCode` and `sqliteExtendedCode` stay typed `number`, not a union of
 * these: a later SQLite may report a code these tables do not hold.
 */

/** The 31 primary result codes — what `SQLiteError.sqliteCode` holds. */
export const SQLITE_CODES = Object.freeze({
  OK: 0,
  ERROR: 1,
  INTERNAL: 2,
  PERM: 3,
  ABORT: 4,
  BUSY: 5,
  LOCKED: 6,
  NOMEM: 7,
  READONLY: 8,
  INTERRUPT: 9,
  IOERR: 10,
  CORRUPT: 11,
  NOTFOUND: 12,
  FULL: 13,
  CANTOPEN: 14,
  PROTOCOL: 15,
  EMPTY: 16,
  SCHEMA: 17,
  TOOBIG: 18,
  CONSTRAINT: 19,
  MISMATCH: 20,
  MISUSE: 21,
  NOLFS: 22,
  AUTH: 23,
  FORMAT: 24,
  RANGE: 25,
  NOTADB: 26,
  NOTICE: 27,
  WARNING: 28,
  ROW: 100,
  DONE: 101,
} as const);

/**
 * The 82 extended result codes — what `SQLiteError.sqliteExtendedCode` holds
 * when SQLite reports a subtype. No primary code is repeated here.
 */
export const SQLITE_EXTENDED_CODES = Object.freeze({
  ERROR_MISSING_COLLSEQ: 257,
  ERROR_RETRY: 513,
  ERROR_SNAPSHOT: 769,
  ERROR_RESERVESIZE: 1025,
  ERROR_KEY: 1281,
  ERROR_UNABLE: 1537,
  IOERR_READ: 266,
  IOERR_SHORT_READ: 522,
  IOERR_WRITE: 778,
  IOERR_FSYNC: 1034,
  IOERR_DIR_FSYNC: 1290,
  IOERR_TRUNCATE: 1546,
  IOERR_FSTAT: 1802,
  IOERR_UNLOCK: 2058,
  IOERR_RDLOCK: 2314,
  IOERR_DELETE: 2570,
  IOERR_BLOCKED: 2826,
  IOERR_NOMEM: 3082,
  IOERR_ACCESS: 3338,
  IOERR_CHECKRESERVEDLOCK: 3594,
  IOERR_LOCK: 3850,
  IOERR_CLOSE: 4106,
  IOERR_DIR_CLOSE: 4362,
  IOERR_SHMOPEN: 4618,
  IOERR_SHMSIZE: 4874,
  IOERR_SHMLOCK: 5130,
  IOERR_SHMMAP: 5386,
  IOERR_SEEK: 5642,
  IOERR_DELETE_NOENT: 5898,
  IOERR_MMAP: 6154,
  IOERR_GETTEMPPATH: 6410,
  IOERR_CONVPATH: 6666,
  IOERR_VNODE: 6922,
  IOERR_AUTH: 7178,
  IOERR_BEGIN_ATOMIC: 7434,
  IOERR_COMMIT_ATOMIC: 7690,
  IOERR_ROLLBACK_ATOMIC: 7946,
  IOERR_DATA: 8202,
  IOERR_CORRUPTFS: 8458,
  IOERR_IN_PAGE: 8714,
  IOERR_BADKEY: 8970,
  IOERR_CODEC: 9226,
  LOCKED_SHAREDCACHE: 262,
  LOCKED_VTAB: 518,
  BUSY_RECOVERY: 261,
  BUSY_SNAPSHOT: 517,
  BUSY_TIMEOUT: 773,
  CANTOPEN_NOTEMPDIR: 270,
  CANTOPEN_ISDIR: 526,
  CANTOPEN_FULLPATH: 782,
  CANTOPEN_CONVPATH: 1038,
  CANTOPEN_DIRTYWAL: 1294,
  CANTOPEN_SYMLINK: 1550,
  CORRUPT_VTAB: 267,
  CORRUPT_SEQUENCE: 523,
  CORRUPT_INDEX: 779,
  READONLY_RECOVERY: 264,
  READONLY_CANTLOCK: 520,
  READONLY_ROLLBACK: 776,
  READONLY_DBMOVED: 1032,
  READONLY_CANTINIT: 1288,
  READONLY_DIRECTORY: 1544,
  ABORT_ROLLBACK: 516,
  CONSTRAINT_CHECK: 275,
  CONSTRAINT_COMMITHOOK: 531,
  CONSTRAINT_FOREIGNKEY: 787,
  CONSTRAINT_FUNCTION: 1043,
  CONSTRAINT_NOTNULL: 1299,
  CONSTRAINT_PRIMARYKEY: 1555,
  CONSTRAINT_TRIGGER: 1811,
  CONSTRAINT_UNIQUE: 2067,
  CONSTRAINT_VTAB: 2323,
  CONSTRAINT_ROWID: 2579,
  CONSTRAINT_PINNED: 2835,
  CONSTRAINT_DATATYPE: 3091,
  NOTICE_RECOVER_WAL: 283,
  NOTICE_RECOVER_ROLLBACK: 539,
  NOTICE_RBU: 795,
  WARNING_AUTOINDEX: 284,
  AUTH_USER: 279,
  OK_LOAD_PERMANENTLY: 256,
  OK_SYMLINK: 512,
} as const);
```

- [ ] **Step 5: Re-export it from `src/index.ts`**

Add after `export * from './errors';`:

```ts
export { SQLITE_CODES, SQLITE_EXTENDED_CODES } from './sqlite-codes';
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm exec rstest run --project unit tests/unit/errors.test.ts tests/unit/exports.test.ts tests/unit/sqlite-codes.test.ts`
Expected: PASS, every test.

- [ ] **Step 7: Full verification, then commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: no type error, and all three reports green.

```bash
git add src/errors.ts src/sqlite-codes.ts src/index.ts tests/unit/errors.test.ts tests/unit/exports.test.ts tests/unit/sqlite-codes.test.ts
git commit -m "feat(errors): STATEMENT_FAILED, sqliteExtendedCode and the result-code tables

The public contract of spec 2026-09-14 §3-§4. Nothing produces the new
code yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

### Task 2: The client keeps SQLite's code — `statementError` and `startupError`

**Files:**
- Modify: `src/pool.ts` (`busyFromCode`, `workerError`, and the `open-error` case of the
  worker's `onmessage` in `createPoolWorker`)
- Modify: `src/delete.ts` (the `data.type === 'error'` branch, and its import from `./pool`)
- Test: the new `tests/unit/statement-error.test.ts`

**Interfaces:**
- Consumes (Task 1): `SQLiteError` with the `sqliteExtendedCode` option, and the
  `'STATEMENT_FAILED'` code.
- Produces:
  - `statementError(data: { message: string; cause?: unknown; sqliteCode?: number; sqliteExtendedCode?: number; errorCode?: SQLiteErrorCode }): Error`;
  - `startupError(data: { message: string; cause?: unknown; sqliteCode?: number }): SQLiteError`.

  Both are exported from `src/pool.ts`. Task 3 relies on `statementError` reading
  `data.sqliteExtendedCode`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/statement-error.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import { startupError, statementError } from '../../src/pool';

/**
 * docs/superpowers/specs/2026-09-14-statement-errors-design.md §5.3: what the
 * client makes of a worker's `error` and `open-error` messages.
 */
describe('statementError — a query the worker reports failed', () => {
  // Falsifiable: drop the STATEMENT_FAILED branch — this becomes a plain Error
  // with neither code.
  it('turns any SQLite code but 5 and 6 into STATEMENT_FAILED, both codes and the cause kept', () => {
    const cause = new Error('inner');
    const error = statementError({
      message: 'UNIQUE constraint failed: u.a',
      cause,
      sqliteCode: 19,
      sqliteExtendedCode: 2067,
    });
    expect(error).toBeInstanceOf(SQLiteError);
    expect(error).toMatchObject({
      code: 'STATEMENT_FAILED',
      name: 'STATEMENT_FAILED',
      message: 'UNIQUE constraint failed: u.a',
      sqliteCode: 19,
      sqliteExtendedCode: 2067,
    });
    expect(error.cause).toBe(cause);
  });

  // Falsifiable: drop `sqliteExtendedCode` from the BUSY built in busyFromCode.
  it('keeps BUSY for 5 and 6, carrying the extended code too', () => {
    for (const [sqliteCode, sqliteExtendedCode] of [
      [5, 517],
      [6, 262],
    ] as const) {
      expect(
        statementError({
          message: 'database is locked',
          sqliteCode,
          sqliteExtendedCode,
        }),
      ).toMatchObject({ code: 'BUSY', sqliteCode, sqliteExtendedCode });
    }
  });

  // Spec D9. Falsifiable: make subtypeOf return data.sqliteExtendedCode
  // unconditionally — both of these then carry it.
  it('drops the extended code when SQLite reported no subtype', () => {
    const full = statementError({
      message: 'database or disk is full',
      sqliteCode: 13,
      sqliteExtendedCode: 13,
    }) as SQLiteError;
    expect(full).toMatchObject({ code: 'STATEMENT_FAILED', sqliteCode: 13 });
    expect(full.sqliteExtendedCode).toBeUndefined();
    const busy = statementError({
      message: 'database is locked',
      sqliteCode: 5,
      sqliteExtendedCode: 5,
    }) as SQLiteError;
    expect(busy).toMatchObject({ code: 'BUSY', sqliteCode: 5 });
    expect(busy.sqliteExtendedCode).toBeUndefined();
  });

  // Spec D9: only equality with sqliteCode is dropped. A 0 is what a read
  // after a successful call returns — a wrong read, which must stay visible.
  // Falsifiable: filter on `>= 256` instead of on equality.
  it('keeps an extended code that differs from sqliteCode, even 0', () => {
    expect(
      statementError({ message: 'm', sqliteCode: 1, sqliteExtendedCode: 0 }),
    ).toMatchObject({ code: 'STATEMENT_FAILED', sqliteExtendedCode: 0 });
  });

  it('prefers a code the worker minted over the SQLite code', () => {
    expect(
      statementError({
        message: 'm',
        errorCode: 'OPERATION_TIMEOUT',
        sqliteCode: 19,
      }),
    ).toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  // Falsifiable: build STATEMENT_FAILED whenever sqliteCode is absent too.
  it('leaves a failure without a SQLite code a plain Error', () => {
    const cause = new TypeError('not SQLite');
    const error = statementError({ message: 'Unknown error', cause });
    expect(error).not.toBeInstanceOf(SQLiteError);
    expect(error.message).toBe('Unknown error');
    expect(error.cause).toBe(cause);
  });
});

describe('startupError — an open or a delete the worker reports failed', () => {
  it('keeps BUSY for a lock conflict', () => {
    expect(
      startupError({ message: 'database is locked', sqliteCode: 5 }),
    ).toMatchObject({ code: 'BUSY', sqliteCode: 5 });
  });

  // Falsifiable: drop `sqliteCode` from the WORKER_CRASHED built in
  // startupError — the code is lost again, as it was before spec 2026-09-14.
  it('keeps WORKER_CRASHED and carries the SQLite code, primary only', () => {
    const error = startupError({
      message: 'file is not a database',
      sqliteCode: 26,
    });
    expect(error).toMatchObject({ code: 'WORKER_CRASHED', sqliteCode: 26 });
    expect(error.sqliteExtendedCode).toBeUndefined();
  });

  it('builds WORKER_CRASHED without a code when SQLite gave none', () => {
    const error = startupError({ message: 'Failed to open x' });
    expect(error.code).toBe('WORKER_CRASHED');
    expect(error.sqliteCode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec rstest run --project unit tests/unit/statement-error.test.ts`
Expected: FAIL. `startupError` and `statementError` are not exported from `src/pool.ts`.

If the failure is instead an error thrown while *loading* `src/pool.ts` under Node (no unit
test imported it before), stop and report it verbatim. Do not move the functions elsewhere on
your own.

- [ ] **Step 3: Rename `workerError` to `statementError`**

Use Serena's `rename_symbol` on `workerError` in `src/pool.ts`. Its one call site is the
`'error'` case of the worker's `onmessage` (`const error = workerError(data);`).

- [ ] **Step 4: Rewrite `busyFromCode`, `statementError`, and add `startupError`**

Insert `subtypeOf` directly before `busyFromCode`, and replace `busyFromCode`, together with its
doc comment, with:

```ts
/**
 * The extended code when it names a subtype, else undefined (spec D9). SQLite
 * reports the primary code again for a failure that has no subtype, and
 * `sqliteCode` already says that. Any other difference is kept: a 0 read after
 * a successful call is a wrong read, and must stay visible.
 */
const subtypeOf = (data: {
  sqliteCode?: number;
  sqliteExtendedCode?: number;
}): number | undefined =>
  data.sqliteExtendedCode !== data.sqliteCode
    ? data.sqliteExtendedCode
    : undefined;

/**
 * Returns a SQLiteError('BUSY', …) when data carries a lock-conflict result
 * code (5 or 6), else undefined. Shared by `statementError` and `startupError`
 * so the BUSY_CODES decision lives in exactly one place. The extended code
 * travels with it when it is a subtype (`subtypeOf`) — a query sends one, an
 * open does not.
 */
export const busyFromCode = (data: {
  message: string;
  cause?: unknown;
  sqliteCode?: number;
  sqliteExtendedCode?: number;
}): SQLiteError | undefined =>
  data.sqliteCode !== undefined && BUSY_CODES.has(data.sqliteCode)
    ? new SQLiteError('BUSY', data.message, {
        cause: data.cause,
        sqliteCode: data.sqliteCode,
        sqliteExtendedCode: subtypeOf(data),
      })
    : undefined;
```

Replace `statementError`, together with any doc comment it carries, with the code below, and
insert `startupError` directly after it:

```ts
/**
 * What a query's `error` message becomes (spec 2026-09-14 §5.3): a code the
 * worker minted; else `BUSY` for a lock conflict; else `STATEMENT_FAILED` for
 * any other code SQLite reported; else — a failure SQLite did not report, such
 * as a JS exception in the worker — a plain Error, as before. `BUSY` and
 * `STATEMENT_FAILED` carry `sqliteCode`, and `sqliteExtendedCode` when it is a
 * subtype (`subtypeOf`).
 */
export const statementError = (data: {
  message: string;
  cause?: unknown;
  sqliteCode?: number;
  sqliteExtendedCode?: number;
  errorCode?: SQLiteErrorCode;
}): Error =>
  (data.errorCode
    ? new SQLiteError(data.errorCode, data.message, { cause: data.cause })
    : undefined) ??
  busyFromCode(data) ??
  (data.sqliteCode !== undefined
    ? new SQLiteError('STATEMENT_FAILED', data.message, {
        cause: data.cause,
        sqliteCode: data.sqliteCode,
        sqliteExtendedCode: subtypeOf(data),
      })
    : new Error(data.message, { cause: data.cause }));

/**
 * What a failed open or delete becomes: `BUSY` for a lock conflict, else
 * `WORKER_CRASHED` — the slot dies either way — carrying SQLite's primary code
 * when there is one (spec 2026-09-14, D2). No extended code: when
 * `sqlite3_open_v2` itself fails there is no connection to ask (D7).
 */
export const startupError = (data: {
  message: string;
  cause?: unknown;
  sqliteCode?: number;
}): SQLiteError =>
  busyFromCode(data) ??
  new SQLiteError('WORKER_CRASHED', data.message, {
    cause: data.cause,
    sqliteCode: data.sqliteCode,
  });
```

- [ ] **Step 5: Route the two startup sites through `startupError`**

In `src/pool.ts`, in the `'open-error'` case, replace:

```ts
          die(
            busyFromCode(data) ??
              new SQLiteError('WORKER_CRASHED', data.message, {
                cause: data.cause,
              }),
          );
```

with:

```ts
          die(startupError(data));
```

In `src/delete.ts`, in the `if (data.type === 'error')` branch, replace:

```ts
        return settle(
          busyFromCode(data) ??
            new SQLiteError('WORKER_CRASHED', data.message, {
              cause: data.cause,
            }),
        );
```

with:

```ts
        return settle(startupError(data));
```

and change the import `import { busyFromCode, spawnWorker } from './pool';` to
`import { spawnWorker, startupError } from './pool';`. `delete.ts` still uses `SQLiteError`
elsewhere (its `onerror`); keep that import. If `pnpm check` or `tsc` then reports an unused
import anywhere, remove it.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm exec rstest run --project unit tests/unit/statement-error.test.ts`
Expected: PASS, every test.

- [ ] **Step 7: Full verification, then commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: no type error and all three reports green. Existing browser tests that assert
`toBeInstanceOf(Error)` on a SQL error still pass, because `SQLiteError` extends `Error`. If
any test fails because it expected a plain `Error` (for example, on `name`), stop and report it:
that is a consumer-visible break the spec must list.

```bash
git add src/pool.ts src/delete.ts tests/unit/statement-error.test.ts
git commit -m "feat(errors): a failed statement rejects with STATEMENT_FAILED

statementError keeps SQLite's code instead of dropping every one but
BUSY; startupError gives WORKER_CRASHED at open and delete the code it
lost. Spec 2026-09-14 §5.3.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

### Task 3: The worker reads the extended code where the statement fails

**Files:**
- Modify: `src/wa-sqlite.d.ts` (`WASQLiteModule`)
- Modify: `src/types.ts` (the `type: 'error'` variant of the worker-to-client message union)
- Modify: `src/worker/worker.ts`, inside `open`: the `query` generator (its `run` helper and its
  outer `try`), and the `catch (e)` of the `'query'` case of `self.onmessage`
- Create: `tests/browser/statement-errors.test.ts`
- Modify: `tests/browser/tx-savepoint.test.ts` (the F2 test, `'dies when an abandoned write
  pops a consumer savepoint along with __bsq_sp'`)

**Interfaces:**
- Consumes (Task 2): `statementError` copies `data.sqliteExtendedCode` onto `BUSY` and
  `STATEMENT_FAILED` when it differs from `sqliteCode` (`subtypeOf`, spec D9). Consumes
  (Task 1): `SQLITE_CODES`, `SQLITE_EXTENDED_CODES`.
- Produces: the `error` wire message carries `sqliteExtendedCode?: number`. wa-sqlite's error
  object carries an `extendedCode` property inside the worker, which is internal and never
  crosses the boundary under that name.

**Why the reading point matters (spec §5.1).** `sqlite3_extended_errcode(db)` reports the
connection's *most recent* API call. Read while the reply is built, it would be wrong. After a
failed savepoint conclusion the worker issues a `ROLLBACK` before replying, which succeeds and
resets the code to 0. `settle`'s `reset` and `finalize` write it too. So the code is stamped on
the error the first time it is caught, and `??=` keeps the first stamp.

- [ ] **Step 1: Write the failing browser tests**

Create `tests/browser/statement-errors.test.ts`:

```ts
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { SQLiteError } from '../../src/errors';
import { SQLITE_CODES, SQLITE_EXTENDED_CODES } from '../../src/sqlite-codes';
import { createTestClient } from './helpers';

/**
 * docs/superpowers/specs/2026-09-14-statement-errors-design.md: a statement
 * SQLite refuses rejects with STATEMENT_FAILED, carrying SQLite's primary
 * result code on `sqliteCode` and its extended one on `sqliteExtendedCode`.
 *
 * Every build, because each has its own export of
 * `sqlite3_extended_errcode`. `MemoryVFS` declares all three and needs no
 * cleanup; `poolSize: 1` because its pages live in the worker that opened it.
 */

const BUILDS = ['sync', 'async', 'jspi'] as const;

const CONSTRAINTS = [
  {
    name: 'UNIQUE',
    setup: ['CREATE TABLE u (a INTEGER UNIQUE)', 'INSERT INTO u VALUES (1)'],
    failing: 'INSERT INTO u VALUES (1)',
    extended: SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE,
    message: /UNIQUE constraint failed: u\.a/,
  },
  {
    name: 'FOREIGN KEY',
    setup: [
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (p INTEGER REFERENCES p (id))',
    ],
    failing: 'INSERT INTO c VALUES (42)',
    extended: SQLITE_EXTENDED_CODES.CONSTRAINT_FOREIGNKEY,
    message: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'NOT NULL',
    setup: ['CREATE TABLE n (a INTEGER NOT NULL)'],
    failing: 'INSERT INTO n VALUES (NULL)',
    extended: SQLITE_EXTENDED_CODES.CONSTRAINT_NOTNULL,
    message: /NOT NULL constraint failed: n\.a/,
  },
];

/** Fills `big` past any small `max_page_count`. TX-M1's statement. */
const FILL_BIG =
  "INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 20000) SELECT printf('%0500d', x) FROM c";

const memoryClient = (
  build: (typeof BUILDS)[number],
  pragmas?: Record<string, string>,
) =>
  createTestClient({
    vfs: 'MemoryVFS',
    build,
    poolSize: 1,
    ...(pragmas ? { pragmas } : {}),
  });

describe('a failed statement carries SQLite codes', () => {
  for (const build of BUILDS) {
    // Falsifiable: drop the STATEMENT_FAILED branch of statementError in
    // src/pool.ts — a plain Error arrives. Drop the stamp in the worker's
    // `run` — sqliteExtendedCode is undefined.
    for (const c of CONSTRAINTS) {
      it(`${c.name} through write() (${build})`, async () => {
        const db = await memoryClient(build, { foreign_keys: 'ON' });
        try {
          for (const sql of c.setup) await db.write(sql);
          const error = await db.write(c.failing).catch((e) => e);
          expect(error).toBeInstanceOf(SQLiteError);
          expect(error).toMatchObject({
            code: 'STATEMENT_FAILED',
            name: 'STATEMENT_FAILED',
            sqliteCode: SQLITE_CODES.CONSTRAINT,
            sqliteExtendedCode: c.extended,
          });
          expect(error.message).toMatch(c.message);
        } finally {
          await db.close();
        }
      });
    }

    // The prepare path: no statement exists yet, so `run` never sees this
    // error. A missing collation is the prepare failure that has a subtype,
    // so it is the one that can falsify the prepare-level stamp. Falsifiable:
    // drop the stamp in the `catch` of query's outer `try` —
    // sqliteExtendedCode is undefined.
    it(`a missing collation through read(), the prepare path (${build})`, async () => {
      const db = await memoryClient(build);
      try {
        const error = await db
          .read("SELECT 'a' = 'b' COLLATE nosuch")
          .catch((e) => e);
        expect(error).toMatchObject({
          code: 'STATEMENT_FAILED',
          sqliteCode: SQLITE_CODES.ERROR,
          sqliteExtendedCode: SQLITE_EXTENDED_CODES.ERROR_MISSING_COLLSEQ,
        });
        expect(error.message).toMatch(/no such collation sequence: nosuch/);
      } finally {
        await db.close();
      }
    });

    // Spec D9: SQLite reports no subtype for a syntax error, so there is no
    // sqliteExtendedCode. Falsifiable: make subtypeOf in src/pool.ts return
    // data.sqliteExtendedCode unconditionally — it arrives as 1.
    it(`a syntax error has no subtype (${build})`, async () => {
      const db = await memoryClient(build);
      try {
        const error = await db.read('SELECT * FROM WHERE').catch((e) => e);
        expect(error).toMatchObject({
          code: 'STATEMENT_FAILED',
          sqliteCode: SQLITE_CODES.ERROR,
        });
        expect(error.sqliteExtendedCode).toBeUndefined();
        expect(error.message).toMatch(/syntax error/);
      } finally {
        await db.close();
      }
    });

    // TX-M1 (mem:measurements, 2026-09-10): this error reached the client with
    // neither `code` nor `sqliteCode`. SQLite undoes the statement alone, so
    // the transaction goes on and commits.
    it(`SQLITE_FULL inside a transaction (${build})`, async () => {
      const db = await memoryClient(build);
      try {
        await db.write('CREATE TABLE t (a INTEGER)');
        await db.write('CREATE TABLE big (x TEXT)');
        const pages =
          (await db.read<{ page_count: number }>('PRAGMA page_count'))[0]
            ?.page_count ?? 0;
        await db.write(`PRAGMA max_page_count = ${pages + 3}`);
        let caught: unknown;
        await db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          caught = await tx.write(FILL_BIG).catch((e) => e);
          await tx.write('INSERT INTO t VALUES (2)');
        });
        expect(caught).toMatchObject({
          code: 'STATEMENT_FAILED',
          sqliteCode: SQLITE_CODES.FULL,
        });
        // SQLite has no subtype for a full database (spec D9).
        expect(
          (caught as { sqliteExtendedCode?: number }).sqliteExtendedCode,
        ).toBeUndefined();
        expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
          { a: 1 },
          { a: 2 },
        ]);
      } finally {
        await db.close();
      }
    });
  }
});

describe('bulkWrite', () => {
  // SQLiteBulkWriteError already keeps the failed batch as `cause`; this pins
  // what that cause now is. Falsifiable: drop the STATEMENT_FAILED branch of
  // statementError — the cause is a plain Error.
  it('keeps the failed statement as the cause of BULK_WRITE_FAILED', async () => {
    const db = await memoryClient('sync');
    try {
      await db.write('CREATE TABLE k (k INTEGER UNIQUE)');
      const bulk = db.bulkWrite('k', ['k']);
      bulk.enqueue({ k: 1 });
      bulk.enqueue({ k: 1 });
      const error = await bulk.close().catch((e) => e);
      expect(error.code).toBe('BULK_WRITE_FAILED');
      expect(error.cause).toMatchObject({
        code: 'STATEMENT_FAILED',
        sqliteCode: SQLITE_CODES.CONSTRAINT,
        sqliteExtendedCode: SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE,
      });
    } finally {
      await db.close();
    }
  });
});

describe('a file that is not a database', () => {
  /** An OPFS file of 4 KiB of 'A' — what an `opfs-path` VFS opens by name. */
  const garbageFile = async () => {
    const file = `statement-errors-${crypto.randomUUID()}`;
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(file, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array(4096).fill(0x41));
    await writable.close();
    return { file, remove: () => root.removeEntry(file).catch(() => {}) };
  };

  // `OPFSAdaptiveVFS` declares no default pragma, so a `pragmas` entry is
  // what makes the open read the file. Falsifiable: drop `sqliteCode` from
  // the WORKER_CRASHED built in startupError.
  it('fails the open with WORKER_CRASHED carrying NOTADB when a pragma reads it', async () => {
    const { file, remove } = await garbageFile();
    const db = createSQLiteClient(file, {
      vfs: 'OPFSAdaptiveVFS',
      poolSize: 1,
      pragmas: { user_version: '1' },
    });
    onTestFinished(async () => {
      await db.close();
      await remove();
    });
    const error = await db.read('SELECT 1').catch((e) => e);
    expect(error).toMatchObject({
      code: 'WORKER_CRASHED',
      sqliteCode: SQLITE_CODES.NOTADB,
    });
    expect(error.sqliteExtendedCode).toBeUndefined();
  });

  // Without one, the open is lazy and succeeds: the first statement that
  // reads the schema is what fails.
  it('fails the first statement with STATEMENT_FAILED when nothing reads it at open', async () => {
    const { file, remove } = await garbageFile();
    const db = createSQLiteClient(file, {
      vfs: 'OPFSAdaptiveVFS',
      poolSize: 1,
    });
    onTestFinished(async () => {
      await db.close();
      await remove();
    });
    const error = await db
      .read('SELECT name FROM sqlite_schema')
      .catch((e) => e);
    expect(error).toMatchObject({
      code: 'STATEMENT_FAILED',
      sqliteCode: SQLITE_CODES.NOTADB,
    });
    // SQLite has no subtype for NOTADB (spec D9).
    expect(error.sqliteExtendedCode).toBeUndefined();
  });
});
```

In `tests/browser/tx-savepoint.test.ts`, add `import { SQLITE_CODES } from '../../src/sqlite-codes';`
to the imports. In the F2 test, directly after
`expect((secondCaught as Error).message).toMatch(/no such savepoint/);`, add:

```ts
      // Spec 2026-09-14 §5.1: the worker issues a ROLLBACK after this failure
      // and before replying, which resets the connection's error code to 0.
      // "no such savepoint" has no subtype, so a correct read equals
      // sqliteCode and D9 drops it. Falsifiable: read sqlite3_extended_errcode
      // while building the reply instead of stamping it where the statement
      // failed — it finds 0, which differs from 1 and is kept.
      expect(secondCaught).toMatchObject({
        code: 'STATEMENT_FAILED',
        sqliteCode: SQLITE_CODES.ERROR,
      });
      expect(
        (secondCaught as { sqliteExtendedCode?: number }).sqliteExtendedCode,
      ).toBeUndefined();
```

- [ ] **Step 2: Run them and confirm the expected failures**

Run: `pnpm exec rstest run --project chromium statement-errors tx-savepoint`
Expected results:
- **pass:** every test that asserts `sqliteExtendedCode` absent — the syntax, FULL, both open
  tests and the F2 assertion — since Task 2 already produces what they assert and nothing is
  stamped yet;
- **fail:** the constraint, missing-collation and bulkWrite tests, on `sqliteExtendedCode`
  being `undefined` where a subtype is expected.

Any other failure, such as a `code` that is not `STATEMENT_FAILED` or a message that does not
match, is a finding: stop and report it before implementing. In particular, if the
`WORKER_CRASHED` test fails because the query rejects with an error that *wraps* the startup
error rather than being it, report the actual shape. Do not loosen the assertion.

- [ ] **Step 3: Declare the export in `src/wa-sqlite.d.ts`**

In `type WASQLiteModule`, add after `_sqlite3_stmt_status`:

```ts
  /**
   * `sqlite3_extended_errcode`. Exported by all three builds (checked
   * 2026-09-14 in each glue file); unwrapped by the JS façade, like
   * `_sqlite3_stmt_status`. It reports the connection's MOST RECENT API call,
   * so `worker.ts` reads it where a statement fails, never later (spec
   * 2026-09-14, §5.1).
   */
  _sqlite3_extended_errcode: (db: number) => number;
```

- [ ] **Step 4: Add the wire field in `src/types.ts`**

In the `type: 'error'` variant, directly after `sqliteCode?: number;` and its one-line comment,
add:

```ts
      /**
       * SQLite's extended result code, read in the worker where the statement
       * failed (spec 2026-09-14, §5.1). Sent by the query path only;
       * `sqliteExtendedCode & 0xff === sqliteCode`.
       */
      sqliteExtendedCode?: number;
```

Do not add it to `open-error` (spec D7).

- [ ] **Step 5: Stamp the code in the `query` generator of `src/worker/worker.ts`**

Inside `query`, directly after `const buffer: Record<string, unknown>[] = [];`, insert:

```ts
    /**
     * Stamps SQLite's extended result code on a wa-sqlite error where the
     * statement failed (spec 2026-09-14, §5.1). The connection's code describes
     * its MOST RECENT call, so it is read before any cleanup can overwrite it:
     * `settle`'s reset or finalize, or the ROLLBACK the savepoint path issues
     * after a failed conclusion. `??=`: the first stamp wins.
     */
    const stamped = (e: unknown) => {
      if (typeof (e as { code?: unknown })?.code === 'number') {
        (e as { extendedCode?: number }).extendedCode ??=
          module._sqlite3_extended_errcode(db);
      }
      return e;
    };
```

In `run`, replace:

```ts
      if (params?.length) {
        sqlite.bind_collection(stmt, params as any);
      }
```

with:

```ts
      try {
        if (params?.length) {
          sqlite.bind_collection(stmt, params as any);
        }
      } catch (e) {
        throw stamped(e);
      }
```

In `run`'s `step` catch, replace the final `throw e;` (the one after the `SQLITE_INTERRUPT`
`break` block) with `throw stamped(e);`. Leave the `SQLITE_INTERRUPT` branch as it is.

In `query`'s outer `try`, the one whose `finally` resets the progress handler, replace:

```ts
      yield sqlite.changes(db);
    } finally {
      if (yields || polls) sqlite.progress_handler(db, 0, () => 0, null);
    }
```

with:

```ts
      yield sqlite.changes(db);
    } catch (e) {
      // A prepare failure (a syntax error) never reaches `run`. No SQL runs
      // between it and here; a step failure was already stamped in `run`.
      throw stamped(e);
    } finally {
      if (yields || polls) sqlite.progress_handler(db, 0, () => 0, null);
    }
```

- [ ] **Step 6: Send it in the `'query'` case's reply**

In the `catch (e)` of `case 'query':` in `self.onmessage`, directly after the spread that sets
`sqliteCode`, add:

```ts
            ...(typeof (e as { extendedCode?: unknown })?.extendedCode ===
            'number'
              ? {
                  sqliteExtendedCode: (e as { extendedCode: number })
                    .extendedCode,
                }
              : {}),
```

- [ ] **Step 7: Run the tests on both engines and confirm they pass**

Run: `pnpm exec rstest run --project chromium statement-errors tx-savepoint`
Then: `pnpm exec rstest run --config rstest.firefox.config.ts statement-errors tx-savepoint`
Expected: PASS on both, every test.

- [ ] **Step 8: Check each falsifier once, then restore**

Each check is one temporary edit, one run, and a revert with Serena, then a fresh look to
confirm the file matches Step 5 again:
1. Make `stamped` return `e` without stamping. Expect the constraint, missing-collation and
   bulkWrite tests to fail.
2. Restore `stamped`. Replace only the query-level `throw stamped(e);` with `throw e;`. Expect
   the missing-collation test to fail and the constraint tests to still pass.
3. Restore. Delete the three `stamped` call sites in `run` and the query-level catch. Instead,
   in the `'query'` case's reply, send
   `sqliteExtendedCode: openedDB && (await openedDB).module._sqlite3_extended_errcode((await openedDB).db)`
   (a late read). Expect the F2 assertion to fail with 0. The other tests may pass: that is the
   point of F2.

Run for each: `pnpm exec rstest run --project chromium statement-errors tx-savepoint`. Record
each outcome in your report. **Revert every falsifier edit before committing**, and confirm with
`git diff` that only Steps 3 to 6 remain.

- [ ] **Step 9: Full verification, then commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: no type error and all three reports green.

```bash
git add src/wa-sqlite.d.ts src/types.ts src/worker/worker.ts tests/browser/statement-errors.test.ts tests/browser/tx-savepoint.test.ts
git commit -m "feat(errors): the extended result code, read where the statement fails

The worker stamps sqlite3_extended_errcode on wa-sqlite's error at the
first catch, before reset, finalize or the savepoint path's ROLLBACK
can overwrite it, and sends it as sqliteExtendedCode. Spec 2026-09-14
§5.1-§5.2.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

### Task 4: Consumer documentation — `API.md` and `CHANGELOG.md`

**Run inline by the controller, not dispatched.** Consumer documentation is edited
iteratively with the user, and nothing is committed until they approve it
(`mem:conventions`, "Writing for the consumer"). State the constraint and what it costs the
consumer; the mechanism belongs in the spec.

**Files:**
- Modify: `API.md` (section `## Error handling`)
- Modify: `CHANGELOG.md` (`## Unreleased`: `### Breaking` and `### Added`)

- [ ] **Step 1: `API.md`, the opening sentence of `## Error handling`**

Replace:

```markdown
Errors raised by this library are instances of `SQLiteError`, exported from the package entry point.
```

with:

```markdown
Errors raised by this library, and every statement SQLite refuses, are instances of `SQLiteError`, exported from the package entry point.
```

- [ ] **Step 2: `API.md`, the table**

Insert this row directly before the `BUSY` row:

```markdown
| `STATEMENT_FAILED` | SQLite refused or failed a statement for any reason other than a lock conflict: a constraint, a syntax error, a full disk, a file that is not a database. `message` is SQLite's own; `sqliteCode` carries its result code, and `sqliteExtendedCode` its subtype when SQLite reports one. |
```

In the `BUSY` row, replace `with the numeric code on \`sqliteCode\`` with
`with its result code on \`sqliteCode\` and, when SQLite reports one, its subtype on \`sqliteExtendedCode\``.

In the `WORKER_CRASHED` row, append: ` When SQLite refused to open the database — a file that is
not a database, a \`pragmas\` entry it rejected — \`sqliteCode\` carries its result code.`

- [ ] **Step 3: `API.md`, the result codes and the example**

After the paragraph that begins `Discriminate on \`error.code\` or \`error.name\``, insert:

```markdown
**SQLite's result codes.** An error SQLite reported carries its result code on `sqliteCode` and, when a statement failed with a subtype, that subtype on `sqliteExtendedCode`: a UNIQUE violation gives `19` and `2067`, a foreign key `19` and `787`, a full disk `13` and no subtype. Test the family on `sqliteCode` against `SQLITE_CODES`, the subtype on `sqliteExtendedCode` against `SQLITE_EXTENDED_CODES`; `sqliteCode` never equals an extended code. What each code means: [Result and Error Codes](https://sqlite.org/rescode.html).
```

Replace the example block that follows with:

````markdown
```typescript
import { SQLITE_EXTENDED_CODES, SQLiteError } from 'browser-sqlite';

try {
  await db.write('...');
} catch (err) {
  if (err instanceof SQLiteError) {
    switch (err.code) {
      case 'STATEMENT_FAILED':
        if (err.sqliteExtendedCode === SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE) {
          /* already exists */
        }
        break;
      case 'WORKER_CRASHED': /* restart or notify */ break;
      case 'CLIENT_CLOSED':  /* client was shut down */ break;
    }
  }
}
```
````

- [ ] **Step 4: `CHANGELOG.md`**

Append as the last entry of `### Breaking`, after the `OPFSCoopSyncVFS` entry:

```markdown
- **A statement SQLite refuses now rejects with `SQLiteError`, code `STATEMENT_FAILED`.** A
  constraint violation, a syntax error or a full disk used to reject with a plain `Error`; its
  message is unchanged. Two things a consumer can notice: `err.name` is now
  `'STATEMENT_FAILED'` where it was `'Error'`, and a `catch` that took `instanceof SQLiteError`
  to mean "the library's own failure" now catches these too. `BUSY` is unchanged.
```

Append as the last entry of `### Added`, directly before `### Changed`:

```markdown
- **A failed statement says why, in numbers.** `STATEMENT_FAILED` carries SQLite's result code
  on `sqliteCode` and, when SQLite reports one, its subtype on the new `sqliteExtendedCode` —
  `19` and `2067` for a UNIQUE violation. A `BUSY` from a statement carries the subtype too,
  and `WORKER_CRASHED` now carries `sqliteCode` when SQLite refused an open or a deletion.
  `SQLITE_CODES` and `SQLITE_EXTENDED_CODES` export SQLite 3.53.0's result codes by name.
```

- [ ] **Step 5: Show the user the diff, and wait**

Run `pnpm check`, then show `git diff API.md CHANGELOG.md`. Iterate on the user's edits. Commit
only once they approve:

```bash
git add API.md CHANGELOG.md
git commit -m "docs: STATEMENT_FAILED, sqliteExtendedCode and SQLITE_CODES

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git log --oneline -1 && git show --stat HEAD
```

---

## After the tasks

The branch closes through the closure procedure (`mem:conventions`, "On clôture"). Besides the
merge, that means these memory edits, which are no task's job:
- delete the `mem:follow-ups` entry "`SQLITE_FULL` reaches the client with neither `code` nor
  `sqliteCode`";
- update `errors.ts` in `mem:architecture`'s table (eighteen codes, `sqliteExtendedCode`) and add
  `sqlite-codes.ts` to it;
- update `mem:state`.
