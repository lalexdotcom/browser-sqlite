# Page → worker binary protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send every query's params to the worker as a transferred binary block bound straight from wasm memory, convert params the way `bulkWrite()` does for every method, and let `bulkWrite()` encode rows at `enqueue()` under a row pattern the worker expands.

**Architecture:** The page converts params at the call (`toBindable`, `INVALID_VALUE` on refusal), `pool.ts` encodes the converted array at each send into an `EncodedParams` (1 MiB chunks, tag + payload) and transfers its chunks; the worker copies them into one `sqlite3_malloc` block and binds with `SQLITE_STATIC`, freeing it after `settle()`. `bulkWrite()` writes each row into a `ParamsWriter` under a mark and sends `INSERT … VALUES ` plus the row template as `pattern`; the worker expands it and caches the statement under `(sql, pattern, rows)`.

**Tech Stack:** TypeScript, wa-sqlite (vendored, `jspi`/`async`/`sync` builds), rstest (unit + browser via Playwright Chromium/Firefox), biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-07-binary-protocol-design.md` — read it before any task; decisions D1-D8 there are binding.

## Global Constraints

- Branch `feat/binary-protocol`, already created off `main`, already holding the spec. Every commit lands on it, on green: `pnpm exec tsc --noEmit` clean and the unit project green before each commit.
- **Code tools:** Serena's symbolic tools are PRIMARY for code (`get_symbols_overview`, `find_symbol` with `include_body`, `find_referencing_symbols`; edits with `replace_symbol_body`, `insert_before_symbol`/`insert_after_symbol`, `replace_content`). Built-in Read/Edit/Grep on code files only as a fallback when Serena fails. Read/Edit are fine for `.md`, JSON, YAML.
- **Never** `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`. Run `pnpm exec tsc --noEmit` yourself before each commit. If a hook fails, stop and report its output verbatim. After committing, confirm with `git log --oneline -1` and `git show --stat HEAD`. Check `git branch --show-current` reads `feat/binary-protocol` before every commit.
- After every modification: `pnpm exec biome check --write <files>`.
- Commit messages: Conventional Commits, body says why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the implementing model's own line).
- Comments state the fact in one or two lines, no history of the debate. No counts in docs or comments ("the methods above", never "the five methods") — numbers only for measurements and real values.
- Unit tests: `pnpm exec rstest --project unit run <file>`. Browser tests: `pnpm exec rstest --project 'chromium*' run <file>` and `pnpm test` for all three configs (chromium+unit, firefox, isolated). The `'chromium*'` glob is required.
- The block's tags (spec § 2), verbatim: `0` NULL; `1` int32 (4 bytes); `2` float64 (8 bytes); `3` text (u32 byte length + UTF-8); `4` BLOB (u32 byte length + bytes); `5` int64 (8 bytes); little-endian; a number is int32 when `v === (v | 0)`; a boolean is int32 `1`/`0`; chunks of 1 MiB (`1 << 20`); a value never straddles two chunks.
- `INVALID_VALUE` is raised on the page, never by the worker.
- Out of scope: result rows (worker → page), recycling the params buffer, a public pattern API, tagged templates.

## Review Focus

1. **A cached statement whose block was freed.** `SQLITE_STATIC` points into the block; the block must be freed only after `settle()` cleared the bindings, on every exit — normal end, `first()`'s early break, an abort mid-step (`SQLITE_INTERRUPT`), a failed step (finalize). Expected: the next query on the same cached statement binds its own values, never the previous query's bytes. Test in Task 3 (abort then reuse) and Task 4 (bulk batch then reuse).
2. **wasm memory growth during the copy or the bind.** A param larger than the free wasm heap grows `HEAPU8`'s buffer; a `DataView` taken before is detached. Expected: a 64 MiB BLOB param round-trips intact. Test in Task 3.
3. **Empty text and empty BLOB are not NULL.** Expected: `''` reads back as `typeof` `text` and `new Uint8Array(0)` as `blob`, length 0. Test in Task 3.
4. **A rollback after the row moved to a new chunk.** A row whose first values fill a chunk and whose failing value would have opened a new one. Expected: the block holds whole rows only and decodes to them. Test in Task 2.
5. **Numbered and named placeholders.** `?2, ?1` and `:a` with an array: today's `bind_collection` binds by index 1..n. Expected: same values as on `main`. Test in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types/errors.ts` (modify) | `INVALID_VALUE` in `SQLiteErrorCode` and the class doc |
| `src/values.ts` (modify) | `Bindable`, `toBindable` refusing with `INVALID_VALUE`, `convertParams` |
| `src/encode.ts` (create) | `ParamsWriter`, `EncodedParams`, `encodeParams`, `QueryParams`, `prepareParams` |
| `src/types/protocol.ts` (modify) | `ParamsBlock`; the `query` message's `params?: ParamsBlock` and `pattern?: string` |
| `src/worker/bind.ts` (create) | `bindBlock`: block → wasm allocation → `SQLITE_STATIC` bindings |
| `src/worker/worker.ts` (modify) | binds through `bindBlock`, frees after `settle()`, expands `pattern`, `(sql, pattern, rows)` cache key |
| `src/pool.ts` (modify) | `query(sql, params?: QueryParams, …)`; encodes at send, transfers |
| `src/queries.ts`, `src/transaction.ts`, `src/client.ts` (modify) | `prepareParams` at each entry point; `QueryParams` down the call chain |
| `src/bulk.ts` (modify) | one `ParamsWriter` per batch, rows encoded at `enqueue()` under a mark, `pattern` at flush |
| `tests/unit/helpers/params.ts` (create) | test-only decoder of an `EncodedParams` and expander of a patterned call |
| `tests/unit/values.test.ts`, `tests/unit/encode.test.ts` (create), `tests/unit/bulk.test.ts` | unit tests |
| `tests/browser/params.test.ts` (create) | round trip, refusals, parity, retry, heap growth, cache reuse |
| `tests/browser/bulk-write.test.ts` | refused row at `enqueue()` |
| `API.md`, `CHANGELOG.md` | docs |

---

### Task 1: `INVALID_VALUE` and the conversion rules

**Files:**
- Modify: `src/types/errors.ts` (the `SQLiteErrorCode` union and the module doc comment above it)
- Modify: `src/values.ts`
- Test: `tests/unit/values.test.ts`

**Interfaces:**
- Produces:
  - `type Bindable = null | undefined | number | bigint | string | boolean | Uint8Array` (exported from `src/values.ts`)
  - `toBindable(value: unknown, jsonb: boolean, what?: string): Bindable` — `what` defaults to `'value'`, used in messages (`'param 2'`, `'column "doc"'`)
  - `convertParams(params: readonly unknown[] | undefined): Bindable[] | undefined` — names `param ${i + 1}`
  - `SQLiteErrorCode` gains `'INVALID_VALUE'`

- [ ] **Step 1: Write the failing tests** — replace the `'lets JSON.stringify and toISOString throw'` case in `tests/unit/values.test.ts` and add the new ones:

```ts
import { convertParams, toBindable } from '../../src/values';

describe('toBindable refusals', () => {
  const refused = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as SQLiteError;
    }
    throw new Error('expected a refusal');
  };

  it('wraps a conversion failure in INVALID_VALUE with the cause', () => {
    const nested = refused(() => toBindable({ n: 1n }, false, 'param 2'));
    expect(nested).toBeInstanceOf(SQLiteError);
    expect(nested.code).toBe('INVALID_VALUE');
    expect(nested.message).toContain('param 2');
    expect(nested.cause).toBeInstanceOf(TypeError);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(refused(() => toBindable(cycle, false)).cause).toBeInstanceOf(TypeError);
    expect(refused(() => toBindable(new Date(Number.NaN), false)).cause).toBeInstanceOf(RangeError);
  });

  it('refuses a Symbol and a function, in both column kinds', () => {
    for (const jsonb of [false, true]) {
      expect(refused(() => toBindable(Symbol('s'), jsonb)).code).toBe('INVALID_VALUE');
      expect(refused(() => toBindable(() => 1, jsonb)).code).toBe('INVALID_VALUE');
    }
  });

  it('refuses a bigint outside int64 and keeps the bounds', () => {
    expect(toBindable(2n ** 63n - 1n, false)).toBe(2n ** 63n - 1n);
    expect(toBindable(-(2n ** 63n), false)).toBe(-(2n ** 63n));
    expect(refused(() => toBindable(2n ** 63n, false)).code).toBe('INVALID_VALUE');
    expect(refused(() => toBindable(-(2n ** 63n) - 1n, true)).code).toBe('INVALID_VALUE');
  });
});

describe('convertParams', () => {
  it('converts every param as an ordinary column', () => {
    const at = new Date(Date.UTC(2026, 9, 6, 12, 34, 56, 789));
    expect(convertParams([1, 'a', { a: 1 }, [1, 2], at, null, undefined])).toEqual([
      1, 'a', '{"a":1}', '[1,2]', '2026-10-06 12:34:56.789', null, undefined,
    ]);
    expect(convertParams(undefined)).toBeUndefined();
  });

  it('names the param, 1-based', () => {
    try {
      convertParams([1, Symbol('x')]);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as SQLiteError).code).toBe('INVALID_VALUE');
      expect((e as SQLiteError).message).toContain('param 2');
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec rstest --project unit run tests/unit/values.test.ts`
Expected: FAIL — `convertParams` is not exported; the refusal cases see `TypeError`/`RangeError` or no throw.

- [ ] **Step 3: Implement**

In `src/types/errors.ts`, add `| 'INVALID_VALUE'` to `SQLiteErrorCode` (after `'INVALID_PRAGMA'`) and one sentence to the doc comment above it: `` `INVALID_VALUE` is a param or a `bulkWrite()` cell no rule can bind — refused on the page, before any worker sees it. ``

In `src/values.ts`, keep `toSQLiteDate` and `jsonbColumns`; rename today's `toBindable` body to a private `convert` and wrap it:

```ts
import { SQLiteError } from './types/errors';

/** What the worker can bind: anything else is refused before it is sent. */
export type Bindable =
  | null
  | undefined
  | number
  | bigint
  | string
  | boolean
  | Uint8Array;

const MAX_INT64 = 0x7fffffffffffffffn;
const MIN_INT64 = -0x8000000000000000n;

const convert = (value: unknown, jsonb: boolean): unknown => {
  if (typeof value === 'boolean' || typeof value === 'string')
    return jsonb ? JSON.stringify(value) : value;
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date && !jsonb) return toSQLiteDate(value);
  return JSON.stringify(value);
};

/**
 * A primitive or a Uint8Array is bound as given; a JSONB column takes JSON
 * text, so its strings, booleans and Dates go through `JSON.stringify` too.
 * Anything else throws `INVALID_VALUE`, naming `what`.
 */
export const toBindable = (
  value: unknown,
  jsonb: boolean,
  what = 'value',
): Bindable => {
  let v: unknown;
  try {
    v = convert(value, jsonb);
  } catch (cause) {
    throw new SQLiteError(
      'INVALID_VALUE',
      `${what} cannot be converted: ${(cause as Error).message}`,
      { cause },
    );
  }
  if (typeof v === 'bigint') {
    if (v > MAX_INT64 || v < MIN_INT64)
      throw new SQLiteError(
        'INVALID_VALUE',
        `${what} is a bigint outside SQLite's 64-bit integer range: ${v}`,
      );
    return v;
  }
  if (
    v === null ||
    v === undefined ||
    typeof v === 'number' ||
    typeof v === 'string' ||
    typeof v === 'boolean' ||
    v instanceof Uint8Array
  )
    return v;
  throw new SQLiteError(
    'INVALID_VALUE',
    `${what} cannot be bound: a ${typeof v} has no SQLite value`,
  );
};

/** Every parameterised method's params, converted as an ordinary column. */
export const convertParams = (
  params: readonly unknown[] | undefined,
): Bindable[] | undefined =>
  params?.map((v, i) => toBindable(v, false, `param ${i + 1}`));
```

`convert` of `{ toJSON: () => undefined }` returns `undefined`, which stays `undefined` (the existing test `binds undefined when toJSON returns undefined` keeps passing).

- [ ] **Step 4: Run the unit project**

Run: `pnpm exec rstest --project unit run`
Expected: `tests/unit/values.test.ts` passes. `tests/unit/bulk.test.ts`'s `does not buffer a row whose conversion throws` now FAILS (`TypeError` expected, `INVALID_VALUE` thrown): change its assertion to

```ts
expect(() => bulk.enqueue({ a: { n: 1n } })).toThrow(
  expect.objectContaining({ code: 'INVALID_VALUE' }),
);
```

and in `src/bulk.ts`'s `enqueue`, pass the column name so the message names it: `keys.map((k, i) => toBindable(data[k], jsonb[i], \`column "${k}"\`))`. Rerun: whole unit project green.

- [ ] **Step 5: Typecheck, format, commit**

```bash
pnpm exec biome check --write src/values.ts src/types/errors.ts src/bulk.ts tests/unit/values.test.ts tests/unit/bulk.test.ts
pnpm exec tsc --noEmit
git add src/values.ts src/types/errors.ts src/bulk.ts tests/unit/values.test.ts tests/unit/bulk.test.ts
git commit -m "feat(values): refuse an unbindable value with INVALID_VALUE

A Symbol, a function, a bigint outside int64 or a failed conversion used to
reach postMessage or SQLite and fail a whole batch, or bind NULL in silence.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The encoder

**Files:**
- Create: `src/encode.ts`
- Create: `tests/unit/helpers/params.ts`
- Test: `tests/unit/encode.test.ts`

**Interfaces:**
- Consumes: `Bindable`, `convertParams` (Task 1)
- Produces (`src/encode.ts`):
  - `class EncodedParams { readonly chunks: ArrayBuffer[]; readonly used: number[]; readonly count: number; readonly rows: number; readonly pattern: string | undefined; toMessage(): ParamsBlock }` — `toMessage()` may be called once; a second call throws `Error('encoded params were already sent')`
  - `class ParamsWriter { rows: number; get count(): number; value(v: Bindable): void; mark(): void; rollback(): void; endRow(): void; finish(pattern?: string): EncodedParams }`
  - `encodeParams(values: readonly Bindable[]): EncodedParams`
  - `type QueryParams = readonly Bindable[] | EncodedParams`
  - `prepareParams(params: readonly unknown[] | EncodedParams | undefined): QueryParams | undefined` — passes an `EncodedParams` through, converts anything else with `convertParams`
  - `type ParamsBlock = { chunks: ArrayBuffer[]; used: number[]; count: number; rows: number }` — declared in `src/types/protocol.ts` in this task (the message fields follow in Task 3)
- Produces (`tests/unit/helpers/params.ts`): `decodeParams(p: EncodedParams | ParamsBlock): Bindable[]` (tag 1 → number, 5 → bigint, 3 → string, 4 → `Uint8Array`, 0 → `null`) and `expandCall(sql: string, params: unknown): { sql: string; params: unknown[] | undefined }` (an `EncodedParams` with a pattern → `sql + Array(rows).fill(pattern).join(',')` and its decoded values; an array → as given)

- [ ] **Step 1: Write the decoder and the failing tests**

`tests/unit/helpers/params.ts`:

```ts
import { EncodedParams } from '../../../src/encode';
import type { ParamsBlock } from '../../../src/types/protocol';
import type { Bindable } from '../../../src/values';

const utf8 = new TextDecoder();

/** Test-only: the values a block carries, in order. */
export const decodeParams = (p: EncodedParams | ParamsBlock): Bindable[] => {
  const out: Bindable[] = [];
  for (let k = 0; k < p.chunks.length; k++) {
    const buf = p.chunks[k] as ArrayBuffer;
    const end = p.used[k] as number;
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let off = 0;
    while (off < end) {
      const tag = u8[off];
      if (tag === 0) { out.push(null); off += 1; }
      else if (tag === 1) { out.push(dv.getInt32(off + 1, true)); off += 5; }
      else if (tag === 2) { out.push(dv.getFloat64(off + 1, true)); off += 9; }
      else if (tag === 5) { out.push(dv.getBigInt64(off + 1, true)); off += 9; }
      else {
        const n = dv.getUint32(off + 1, true);
        const bytes = u8.subarray(off + 5, off + 5 + n);
        out.push(tag === 3 ? utf8.decode(bytes) : bytes.slice());
        off += 5 + n;
      }
    }
  }
  return out;
};

/** Test-only: what the worker would run for a call `bulk.ts` made. */
export const expandCall = (sql: string, params: unknown) =>
  params instanceof EncodedParams
    ? {
        sql:
          params.pattern === undefined
            ? sql
            : sql + new Array(params.rows).fill(params.pattern).join(','),
        params: decodeParams(params) as unknown[],
      }
    : { sql, params: params as unknown[] | undefined };
```

`tests/unit/encode.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { EncodedParams, ParamsWriter, encodeParams, prepareParams } from '../../src/encode';
import { decodeParams } from './helpers/params';

const MiB = 1 << 20;

describe('encodeParams', () => {
  it('round-trips every bindable value', () => {
    const blob = Uint8Array.of(0, 255, 7);
    const values = [
      null, undefined, 0, -1, 2 ** 31 - 1, -(2 ** 31), 2 ** 31, 1.5, -0, Number.NaN,
      2n ** 63n - 1n, -(2n ** 63n), '', 'é€😀', blob, new Uint8Array(0), true, false,
    ];
    expect(decodeParams(encodeParams(values))).toEqual([
      null, null, 0, -1, 2 ** 31 - 1, -(2 ** 31), 2 ** 31, 1.5, 0, Number.NaN,
      2n ** 63n - 1n, -(2n ** 63n), '', 'é€😀', blob, new Uint8Array(0), 1, 0,
    ]);
  });

  it('counts values and leaves rows at 0', () => {
    const p = encodeParams([1, 'a']);
    expect(p.count).toBe(2);
    expect(p.rows).toBe(0);
    expect(p.pattern).toBeUndefined();
  });

  it('gives a value larger than a chunk a chunk of its own', () => {
    const big = 'x'.repeat(MiB + 10);
    const p = encodeParams(['a', big, 'b']);
    expect(decodeParams(p)).toEqual(['a', big, 'b']);
    for (let k = 0; k < p.chunks.length; k++)
      expect(p.used[k]).toBeLessThanOrEqual((p.chunks[k] as ArrayBuffer).byteLength);
  });

  it('refuses to be sent twice', () => {
    const p = encodeParams([1]);
    p.toMessage();
    expect(() => p.toMessage()).toThrow('encoded params were already sent');
  });
});

describe('ParamsWriter', () => {
  it('never splits a value across chunks', () => {
    const w = new ParamsWriter();
    const s = 'y'.repeat(1000);
    for (let i = 0; i < 3000; i++) w.value(s); // ~3 MB: several chunks
    const p = w.finish();
    expect(p.chunks.length).toBeGreaterThan(1);
    expect(decodeParams(p)).toEqual(new Array(3000).fill(s));
  });

  it('rolls a row back, also after it opened a new chunk', () => {
    const w = new ParamsWriter();
    w.mark(); w.value(1); w.value('a'); w.endRow();
    // Reserved at 3 bytes per unit, this string cannot fit the first chunk:
    // the row's second value opens a second one, which the rollback drops.
    w.mark(); w.value(2); w.value('z'.repeat(MiB / 2));
    w.rollback();
    w.mark(); w.value(3); w.value('c'); w.endRow();
    const p = w.finish('(?,?)');
    expect(p.chunks).toHaveLength(1);
    expect(p.rows).toBe(2);
    expect(p.count).toBe(4);
    expect(p.pattern).toBe('(?,?)');
    expect(decodeParams(p)).toEqual([1, 'a', 3, 'c']);
  });
});

describe('prepareParams', () => {
  it('passes an EncodedParams through and converts an array', () => {
    const p = encodeParams([1]);
    expect(prepareParams(p)).toBe(p);
    expect(prepareParams([{ a: 1 }])).toEqual(['{"a":1}']);
    expect(prepareParams(undefined)).toBeUndefined();
    expect(p).toBeInstanceOf(EncodedParams);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec rstest --project unit run tests/unit/encode.test.ts`
Expected: FAIL — `src/encode.ts` does not exist.

- [ ] **Step 3: Implement `src/encode.ts`, and `ParamsBlock` in `src/types/protocol.ts`**

Add to `src/types/protocol.ts` (exported, above `ClientMessageData`):

```ts
/**
 * Params encoded on the page: values one after another, a tag byte then its
 * payload, little-endian — 0 NULL, 1 int32, 2 float64, 3 text (u32 length +
 * UTF-8), 4 BLOB (u32 length + bytes), 5 int64. A value never straddles two
 * chunks. `rows` is the row count when the message carries a `pattern`.
 */
export type ParamsBlock = {
  chunks: ArrayBuffer[];
  used: number[];
  count: number;
  rows: number;
};
```

`src/encode.ts`:

```ts
import type { ParamsBlock } from './types/protocol';
import { type Bindable, convertParams } from './values';

const CHUNK_BYTES = 1 << 20;
const utf8 = new TextEncoder();

/** Params ready to send. Its chunks are transferred, so it is sent once. */
export class EncodedParams {
  #sent = false;
  constructor(
    readonly chunks: ArrayBuffer[],
    readonly used: number[],
    readonly count: number,
    readonly rows: number,
    readonly pattern: string | undefined,
  ) {}

  toMessage(): ParamsBlock {
    if (this.#sent) throw new Error('encoded params were already sent');
    this.#sent = true;
    return { chunks: this.chunks, used: this.used, count: this.count, rows: this.rows };
  }
}

/** Writes values into 1 MiB chunks; a row can be rolled back to its mark. */
export class ParamsWriter {
  rows = 0;
  #chunks: ArrayBuffer[] = [];
  #used: number[] = [];
  #buf: ArrayBuffer | undefined;
  #u8 = new Uint8Array(0);
  #dv = new DataView(new ArrayBuffer(0));
  #off = 0;
  #count = 0;
  #markChunks = 0;
  #markOff = 0;
  #markCount = 0;
  #markBuf: ArrayBuffer | undefined;

  /** `initial` sizes the first chunk; otherwise it is allocated on first use. */
  constructor(initial?: number) {
    if (initial !== undefined) this.#open(initial);
  }

  get count() {
    return this.#count;
  }

  #open(bytes: number) {
    this.#buf = new ArrayBuffer(bytes);
    this.#u8 = new Uint8Array(this.#buf);
    this.#dv = new DataView(this.#buf);
    this.#off = 0;
  }

  /** Room for `n` more bytes, in a new chunk if this one cannot hold them. */
  #room(n: number) {
    if (this.#buf && this.#off + n <= this.#buf.byteLength) return;
    if (this.#buf) {
      this.#chunks.push(this.#buf);
      this.#used.push(this.#off);
    }
    this.#open(Math.max(CHUNK_BYTES, n));
  }

  mark() {
    this.#markChunks = this.#chunks.length;
    this.#markOff = this.#off;
    this.#markCount = this.#count;
    this.#markBuf = this.#buf;
  }

  rollback() {
    if (this.#buf !== this.#markBuf) {
      this.#chunks.length = this.#markChunks;
      this.#used.length = this.#markChunks;
      if (this.#markBuf) {
        this.#buf = this.#markBuf;
        this.#u8 = new Uint8Array(this.#buf);
        this.#dv = new DataView(this.#buf);
      } else {
        this.#buf = undefined;
      }
    }
    this.#off = this.#markOff;
    this.#count = this.#markCount;
  }

  endRow() {
    this.rows++;
  }

  value(v: Bindable) {
    this.#count++;
    if (v === null || v === undefined) {
      this.#room(1);
      this.#u8[this.#off++] = 0;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : v;
      if (n === (n | 0)) {
        this.#room(5);
        this.#u8[this.#off] = 1;
        this.#dv.setInt32(this.#off + 1, n, true);
        this.#off += 5;
      } else {
        this.#room(9);
        this.#u8[this.#off] = 2;
        this.#dv.setFloat64(this.#off + 1, n, true);
        this.#off += 9;
      }
    } else if (typeof v === 'bigint') {
      this.#room(9);
      this.#u8[this.#off] = 5;
      this.#dv.setBigInt64(this.#off + 1, v, true);
      this.#off += 9;
    } else if (typeof v === 'string') {
      // Worst case: 3 UTF-8 bytes per UTF-16 unit.
      this.#room(5 + v.length * 3);
      const { written } = utf8.encodeInto(v, this.#u8.subarray(this.#off + 5));
      this.#u8[this.#off] = 3;
      this.#dv.setUint32(this.#off + 1, written, true);
      this.#off += 5 + written;
    } else {
      this.#room(5 + v.byteLength);
      this.#u8[this.#off] = 4;
      this.#dv.setUint32(this.#off + 1, v.byteLength, true);
      this.#u8.set(v, this.#off + 5);
      this.#off += 5 + v.byteLength;
    }
  }

  finish(pattern?: string): EncodedParams {
    if (this.#buf) {
      this.#chunks.push(this.#buf);
      this.#used.push(this.#off);
    }
    return new EncodedParams(this.#chunks, this.#used, this.#count, this.rows, pattern);
  }
}

/** One query's params, sized for the worst case so most fit one chunk. */
export const encodeParams = (values: readonly Bindable[]): EncodedParams => {
  let bytes = 0;
  for (const v of values) {
    if (typeof v === 'string') bytes += 5 + v.length * 3;
    else if (v instanceof Uint8Array) bytes += 5 + v.byteLength;
    else bytes += 9;
  }
  const w = new ParamsWriter(Math.max(16, Math.min(bytes, CHUNK_BYTES)));
  for (const v of values) w.value(v);
  return w.finish();
};

export type QueryParams = readonly Bindable[] | EncodedParams;

/** At each entry point: converted params, or a block `bulk.ts` encoded. */
export const prepareParams = (
  params: readonly unknown[] | EncodedParams | undefined,
): QueryParams | undefined =>
  params instanceof EncodedParams ? params : convertParams(params);
```

`encodeParams` caps its first chunk at 1 MiB: a larger value gets a chunk of its own through `#room`.

- [ ] **Step 4: Run them**

Run: `pnpm exec rstest --project unit run tests/unit/encode.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, format, commit**

```bash
pnpm exec biome check --write src/encode.ts src/types/protocol.ts tests/unit/encode.test.ts tests/unit/helpers/params.ts
pnpm exec tsc --noEmit
pnpm exec rstest --project unit run
git add src/encode.ts src/types/protocol.ts tests/unit/encode.test.ts tests/unit/helpers/params.ts
git commit -m "feat(encode): a binary params block with row marks

The format the worker will bind from: tagged values in transferable chunks,
a row that fails mid-way rolled back so a batch holds only whole rows.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Params cross as a binary block

The protocol switches in one commit: the page encodes, the worker binds from the block. `bulk.ts` keeps sending its flat array (now converted by `prepareParams` like any call) until Task 4.

**Files:**
- Modify: `src/types/protocol.ts` — the `query` message
- Create: `src/worker/bind.ts`
- Modify: `src/worker/worker.ts` — `query()` and its `run()`/`finally`, the `'query'` case
- Modify: `src/pool.ts` — `PoolWorker['query']`, `runQuery`, the `postMessage` of the query, `query`
- Modify: `src/queries.ts` — every `params?: unknown[]` → `params?: QueryParams`
- Modify: `src/transaction.ts` — `exec`'s and `via`'s facades, `db.read/write/chunk/stream/first`, `bulkFor`'s `read`/`write`
- Modify: `src/client.ts` — `read`, `chunk`, `stream`, `write`, `first`
- Modify: `src/bulk.ts` — `WriteFn`/`ReadFn`/`TransactionFn` params type `unknown[] | EncodedParams`
- Test: `tests/browser/params.test.ts` (create)

**Interfaces:**
- Consumes: `prepareParams`, `encodeParams`, `EncodedParams`, `QueryParams` (Task 2); `ParamsBlock` (Task 2)
- Produces:
  - `query` message: `params?: ParamsBlock; pattern?: string` (replacing `params: unknown[]`)
  - `bindBlock(module: WASQLiteModule, sqlite: SQLiteAPI, stmt: number, block: ParamsBlock): number` in `src/worker/bind.ts` — returns the wasm pointer to free
  - `PoolWorker['query'](sql: string, params?: QueryParams, options?)`

- [ ] **Step 1: Write the failing browser tests** — `tests/browser/params.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

const typed = 'SELECT typeof(v) AS t, quote(v) AS q FROM p ORDER BY rowid';

describe('params', () => {
  it('binds every kind of value as the conversion rules say', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE p (v)');
    const at = new Date(Date.UTC(2026, 9, 6, 12, 34, 56, 789));
    const values: unknown[] = [
      2 ** 31 - 1, -(2 ** 31), 2 ** 31, 1.5, 2n ** 63n - 1n, -(2n ** 63n),
      'é€😀', '', Uint8Array.of(1, 2), new Uint8Array(0), true, null, undefined,
      { a: 1 }, [1, 2, 300], at, '\ud800',
    ];
    for (const v of values) await db.write('INSERT INTO p VALUES (?)', [v]);
    expect(await db.read(typed)).toEqual([
      { t: 'integer', q: '2147483647' },
      { t: 'integer', q: '-2147483648' },
      { t: 'integer', q: '2147483648' },
      { t: 'real', q: '1.5' },
      { t: 'integer', q: '9223372036854775807' },
      { t: 'integer', q: '-9223372036854775808' },
      { t: 'text', q: "'é€😀'" },
      { t: 'text', q: "''" },
      { t: 'blob', q: "X'0102'" },
      { t: 'blob', q: "X''" },
      { t: 'integer', q: '1' },
      { t: 'null', q: 'NULL' },
      { t: 'null', q: 'NULL' },
      { t: 'text', q: `'{"a":1}'` },
      { t: 'text', q: "'[1,2,300]'" },
      { t: 'text', q: "'2026-10-06 12:34:56.789'" },
      { t: 'text', q: "'�'" },
    ]);
    await db.close();
  });

  it('refuses an unbindable param before any worker sees it', async () => {
    const db = await createTestClient({ debug: true });
    await db.write('CREATE TABLE p (v)');
    const before = (db.debug?.requests ?? []).length;
    await expect(db.write('INSERT INTO p VALUES (?)', [Symbol('s')])).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await expect(db.read('SELECT ?', [() => 1])).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await expect(db.first('SELECT ?', [2n ** 64n])).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    const gen = db.stream('SELECT ?', [Symbol('s')]);
    await expect(gen.next()).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await expect(db.chunk('SELECT ?', [Symbol('s')]).next()).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await db.transaction(async (tx) => {
      expect(() => tx.read('SELECT ?', [Symbol('s')])).toThrow(expect.objectContaining({ code: 'INVALID_VALUE' }));
    });
    // No request for the refused calls reached a worker.
    const sent = (db.debug?.requests ?? []).slice(before).flatMap((r) => r.queries).filter((q) => q.sql === 'SELECT ?');
    expect(sent).toHaveLength(0);
    await db.close();
  });

  it('binds as many values as the statement has parameters, by index', async () => {
    const db = await createTestClient();
    expect(await db.read('SELECT ? AS a', [1, 2])).toEqual([{ a: 1 }]);
    expect(await db.read('SELECT ? AS a, ? AS b', [1])).toEqual([{ a: 1, b: null }]);
    expect(await db.read('SELECT ?2 AS a, ?1 AS b', [1, 2])).toEqual([{ a: 2, b: 1 }]);
    expect(await db.read('SELECT :x AS a', [7])).toEqual([{ a: 7 }]);
    await db.close();
  });

  it('binds the same params to each statement of a multi-statement string', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE m (v)');
    await db.write('INSERT INTO m VALUES (?); INSERT INTO m VALUES (?)', ['x']);
    expect(await db.read('SELECT v FROM m')).toEqual([{ v: 'x' }, { v: 'x' }]);
    await db.close();
  });

  it('round-trips a param larger than the wasm heap', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE b (v)');
    const big = new Uint8Array(64 << 20);
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 255;
    await db.write('INSERT INTO b VALUES (?)', [big]);
    const [row] = await db.read<{ n: number; h: string }>(
      "SELECT length(v) AS n, hex(substr(v, 1 + 4096 * 3, 1)) AS h FROM b",
    );
    // Byte 1 + 4096 * 3 (1-based) is index 3 * 4096, set to 3 above.
    expect(row).toEqual({ n: 64 << 20, h: '03' });
    await db.close();
  }, 120_000);

  it('rebinds a cached statement after an aborted query', async () => {
    const db = await createTestClient({ poolSize: 1 } as never);
    const sql = 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ?) SELECT max(i) AS m, ? AS tag FROM c';
    const controller = new AbortController();
    const slow = db.read(sql, [50_000_000, 'first'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(slow).rejects.toBeDefined();
    expect(await db.read(sql, [3, 'second'])).toEqual([{ m: 3, tag: 'second' }]);
    await db.close();
  }, 60_000);
});
```

Add, in the same file, the test that pins the retry path's premise — `readWithRetry` re-posts the same converted array, so one array must be sendable twice. It drives one pool worker directly, as `tests/browser/pool-savepoint.test.ts` does:

```ts
import { createLogger } from '../../src/logger';
import { createPoolWorker, type PoolWorker } from '../../src/pool';
import { databasePath } from '../../src/utils';
import { removeDatabaseFiles, TEST_TARGET } from './helpers';

describe('one converted params array, sent twice', () => {
  it('binds the same values on the second send', async () => {
    const file = `prm-${Date.now().toString(36)}`;
    const opened = await createPoolWorker({
      index: 0,
      pool: [] as (PoolWorker | undefined)[],
      clientName: 'params',
      file: databasePath(TEST_TARGET.vfs, file),
      vfs: TEST_TARGET.vfs,
      build: TEST_TARGET.build,
      drainTimeout: 5000,
      logger: createLogger('test', false),
    });
    if ('declined' in opened) throw new Error(`worker declined: ${opened.declined}`);
    const worker = opened;
    try {
      const params = [1, 'two'];
      for (let i = 0; i < 2; i++) {
        const rows: unknown[] = [];
        for await (const c of worker.query('SELECT ? AS a, ? AS b', params))
          if (typeof c !== 'number') rows.push(...c);
        expect(rows).toEqual([{ a: 1, b: 'two' }]);
      }
    } finally {
      await worker.close();
      worker.terminate();
      await removeDatabaseFiles(file, TEST_TARGET.vfs);
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec rstest --project 'chromium*' run tests/browser/params.test.ts`
Expected: FAIL — objects bind `NULL`, arrays bind bytes, `INVALID_VALUE` is never raised, `2 ** 31`… pass; the parity, multi-statement, abort and heap cases may already pass (they pin behaviour the change must keep).

- [ ] **Step 3: The message and the worker**

`src/types/protocol.ts`, the `query` member of `ClientMessageData`:

```ts
  | {
      type: 'query';
      callId: number;
      sql: string;
      /** Absent when the query has no params. */
      params?: ParamsBlock;
      /** Repeated `params.rows` times, comma-joined, after `sql`. */
      pattern?: string;
      options?: SQLOptions;
    }
```

`src/worker/bind.ts`:

```ts
import * as SQLite from 'wa-sqlite/src/sqlite-api.js';
import { SQLITE_OK } from 'wa-sqlite/src/sqlite-constants.js';
import type { ParamsBlock } from '../types/protocol';

/**
 * Copies the block into one wasm allocation and binds from it, SQLITE_STATIC:
 * the allocation must outlive the bindings, so the caller frees the returned
 * pointer only after clearing them. Binds as many values as the statement has
 * parameters, by index, as wa-sqlite's `bind_collection` does.
 */
export const bindBlock = (
  module: WASQLiteModule,
  sqlite: SQLiteAPI,
  stmt: number,
  block: ParamsBlock,
): number => {
  const m = module as any;
  let total = 0;
  for (const n of block.used) total += n;
  const ptr: number = m._sqlite3_malloc(Math.max(1, total));
  if (!ptr) throw new SQLite.SQLiteError('out of memory binding params', SQLite.SQLITE_NOMEM);
  let at = ptr;
  for (let k = 0; k < block.chunks.length; k++) {
    const n = block.used[k] as number;
    // HEAPU8 is read at each use: a malloc may have grown the heap.
    m.HEAPU8.set(new Uint8Array(block.chunks[k] as ArrayBuffer, 0, n), at);
    at += n;
  }
  const bound = Math.min(block.count, sqlite.bind_parameter_count(stmt));
  let heap: Uint8Array = m.HEAPU8;
  let dv = new DataView(heap.buffer);
  let off = ptr;
  for (let i = 1; i <= bound; i++) {
    if (heap.buffer !== m.HEAPU8.buffer) {
      heap = m.HEAPU8;
      dv = new DataView(heap.buffer);
    }
    const tag = heap[off];
    let rc: number;
    if (tag === 0) {
      rc = m._sqlite3_bind_null(stmt, i);
      off += 1;
    } else if (tag === 1) {
      rc = m._sqlite3_bind_int(stmt, i, dv.getInt32(off + 1, true));
      off += 5;
    } else if (tag === 2) {
      rc = m._sqlite3_bind_double(stmt, i, dv.getFloat64(off + 1, true));
      off += 9;
    } else if (tag === 5) {
      rc = sqlite.bind_int64(stmt, i, dv.getBigInt64(off + 1, true));
      off += 9;
    } else {
      const n = dv.getUint32(off + 1, true);
      rc = tag === 3
        ? m._sqlite3_bind_text(stmt, i, off + 5, n, 0)
        : m._sqlite3_bind_blob(stmt, i, off + 5, n, 0);
      off += 5 + n;
    }
    if (rc !== SQLITE_OK) {
      m._sqlite3_free(ptr);
      throw new SQLite.SQLiteError(`binding parameter ${i} failed`, rc);
    }
  }
  return ptr;
};
```

Check how `worker.ts` imports `SQLITE_OK` and the `SQLiteAPI`/`WASQLiteModule` types (its own import block, lines 15-27, and `src/wa-sqlite.d.ts`) and import them the same way; adjust the two import lines above to match. `sqlite.bind_parameter_count` and `sqlite.bind_int64` exist on wa-sqlite's API object.

`src/worker/worker.ts`, inside `open` → `query`:
- Signature: `query = async function* (callId: number, sql: string, params: ParamsBlock | undefined, options?: SQLOptions, textOf?: () => string)`. `sql` is the cache key; `textOf`, when given, builds the SQL text to prepare (Task 4 passes it; this task never does).
- At the top of the body: `const owned: number[] = [];`
- In `run(stmt)`, replace the `bind_collection` call:

```ts
        if (params) owned.push(bindBlock(module, sqlite, stmt, params));
```

- Use `textOf ? textOf() : sql` in the two `sqlite.statements(db, …)` calls and in `isSingleStatement(…, sqlite.sql(stmt))`.
- In the outer `finally` (after `preparing = undefined` and the `progress_handler` reset), free every allocation, last, after `settle()` has run on every path:

```ts
      // After settle(): the bindings pointing into these are cleared.
      for (const p of owned) module._sqlite3_free(p);
```

(`module._sqlite3_free` — check the `WASQLiteModule` type declares it; if not, cast as `bind.ts` does.)
- The savepoint `control()` helper calls `query(callId, statement, [])`: pass `undefined`.
- In the `'query'` case: `const { callId, sql, params, options } = data;` stays; the call becomes `query(callId, sql, params, options)`.

- [ ] **Step 4: The pool and the entry points**

`src/pool.ts`:
- `import { EncodedParams, encodeParams, type QueryParams } from './encode';`
- `PoolWorker['query']`, `runQuery` and `query`: `params?: QueryParams`.
- `debugQuery = debugWorker?.query(sql, params instanceof EncodedParams ? undefined : (params as unknown[] | undefined), internal);`
- The `postMessage` of the query:

```ts
      // Encoded at each send: a retried read re-sends the caller's converted
      // values, and a transferred buffer is gone from the page.
      const encoded =
        params instanceof EncodedParams
          ? params
          : params?.length
            ? encodeParams(params)
            : undefined;
      const block = encoded?.toMessage();
      worker.postMessage(
        {
          type: 'query',
          callId: ++currentCallId,
          sql,
          ...(block ? { params: block } : {}),
          ...(encoded?.pattern !== undefined ? { pattern: encoded.pattern } : {}),
          options: { /* unchanged */ },
        },
        block ? block.chunks : [],
      );
```

`src/queries.ts`: every `params?: unknown[]` parameter → `params?: QueryParams` (import the type from `./encode`). Nothing else changes there.

`src/transaction.ts`: the facades in `exec` and `via` take `params?: QueryParams`. In `db.read`, `db.write`, `db.first` add `const bound = prepareParams(params);` right after `const query = checksql(sql);` and pass `bound` down; in `db.chunk` and `db.stream` the same, right after `checksql`. In `bulkFor`'s `read` and `write`, same line after `checksql`, typed `params?: unknown[] | EncodedParams`. `checksql` throws synchronously in these non-async methods, so `INVALID_VALUE` does too — the test expects exactly that.

`src/client.ts`: in `read`, `first`, `write`: `const bound = prepareParams(params);` on the line after `assertReadable(...)` / `assertStatementAllowed(...)`, pass `bound` to the worker helper. In `chunk` and `stream` (async generators) the same, after `assertReadable`. Widen the five methods' own `params` parameter to `unknown[] | EncodedParams` — the public types in `src/api.ts` keep `unknown[]` (a wider parameter is assignable to them), and `EncodedParams` is not exported from `src/index.ts`, so a consumer cannot build one.

`src/bulk.ts`: `WriteFn`, `ReadFn` and the `write` inside `TransactionFn` take `params?: unknown[] | EncodedParams`.

- [ ] **Step 5: Run everything**

```bash
pnpm exec tsc --noEmit
pnpm exec rstest --project unit run
pnpm exec rstest --project 'chromium*' run tests/browser/params.test.ts tests/browser/bulk-write.test.ts tests/browser/statement-cache.test.ts tests/browser/transaction.test.ts tests/browser/queries.test.ts
```

Expected: all PASS. Then `pnpm test` (three reports: read `status`, `failedFiles`, passed and skipped on each; skips must match the baseline in `mem:state` — 8 on the chromium report, 4 on the firefox one).

- [ ] **Step 6: Format and commit**

```bash
pnpm exec biome check --write src tests/browser/params.test.ts
pnpm exec tsc --noEmit
git add -A src tests/browser/params.test.ts
git commit -m "feat(protocol): params cross to the worker as a transferred binary block

Every parameterised method converts its params as bulkWrite does and the
worker binds them from one wasm allocation, instead of cloning a JS array
and binding it value by value.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `bulkWrite()` encodes at `enqueue()` under a row pattern

**Files:**
- Modify: `src/bulk.ts` — `createBulk`'s `bulkWrite` body: the buffer, `flush`, `enqueue`, `close`
- Modify: `src/worker/worker.ts` — the `'query'` case: pattern expansion and cache key
- Modify: `tests/unit/bulk.test.ts` — the recorders expand patterned calls
- Test: `tests/browser/bulk-write.test.ts`

**Interfaces:**
- Consumes: `ParamsWriter`, `EncodedParams` (Task 2); `query(…, textOf)` (Task 3); `toBindable(value, jsonb, what)` (Task 1); `expandCall` (Task 2)
- Produces: a flush calls `write(head, encoded, { signal })` with `head = \`INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(',')}) VALUES \`` and `encoded.pattern === rowTemplate`, `encoded.rows` the batch's rows

- [ ] **Step 1: Adapt the unit recorders, then write the failing browser test**

In `tests/unit/bulk.test.ts`, every fake `write` records through `expandCall` so existing assertions on the full SQL and the flat values keep their meaning:

```ts
import { expandCall } from './helpers/params';
// recorder():
  const write = async (statement: string, params?: unknown) => {
    sql.push(expandCall(statement, params).sql);
    return { result: [] as any[], affected: 0 };
  };
// and the transaction fake's write the same way.
// capture():
    const write = async (sql: string, params?: unknown) => {
      const call = expandCall(sql, params);
      calls.push(call);
      return { result: [] as unknown[], affected: call.params?.length ?? 0 };
    };
```

Apply the same to the other fake writes in the file that read `params` (search `params` in it). Run `pnpm exec rstest --project unit run tests/unit/bulk.test.ts`: PASS before any production change (the expansion is the identity on arrays).

In `tests/browser/bulk-write.test.ts`, add:

```ts
describe('bulkWrite() refusals', () => {
  it('refuses one row at enqueue() and writes the others', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE r (id INTEGER, v)');
    const bulk = db.bulkWrite('r', ['id', 'v']);
    let refused = 0;
    for (let id = 0; id < 5000; id++) {
      try {
        bulk.enqueue({ id, v: id % 1000 === 999 ? Symbol('bad') : `v${id}` });
      } catch (e) {
        expect(e).toMatchObject({ code: 'INVALID_VALUE' });
        expect((e as Error).message).toContain('column "v"');
        refused++;
      }
    }
    expect(await bulk.close()).toBe(4995);
    expect(refused).toBe(5);
    const [row] = await db.read<{ n: number; bad: number }>(
      "SELECT count(*) AS n, sum(v <> 'v' || id) AS bad FROM r",
    );
    expect(row).toEqual({ n: 4995, bad: 0 });
    await db.close();
  });

  it('rebinds a cached batch statement with the next batch', async () => {
    const db = await createTestClient({ poolSize: 1 } as never);
    await db.write('CREATE TABLE r (a, b)');
    const per = Math.floor(32766 / 2);
    const bulk = db.bulkWrite('r', ['a', 'b']);
    for (let i = 0; i < per * 2; i++) bulk.enqueue({ a: i, b: `x${i}` });
    await bulk.close();
    const [row] = await db.read<{ n: number; bad: number }>(
      "SELECT count(*) AS n, sum(b <> 'x' || a) AS bad FROM r",
    );
    expect(row).toEqual({ n: per * 2, bad: 0 });
    await db.close();
  });
});
```

Run: `pnpm exec rstest --project 'chromium*' run tests/browser/bulk-write.test.ts`
Expected: both PASS already — since Task 1, `enqueue()` refuses the `Symbol` with `INVALID_VALUE` before buffering it. They pin that behaviour, and Review Focus 1, across the rewrite below.

- [ ] **Step 2: Rewrite the batch in `src/bulk.ts`**

- Replace `const buffer: unknown[][] = [];` with `let writer = new ParamsWriter();`, and add `const head = \`INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(',')}) VALUES \`;` next to `rowTemplate`.
- `enqueue`, in place of the `buffer.push(...)` and its flush test:

```ts
          // Each row under a mark: a value that cannot be bound throws here and
          // leaves the batch holding whole rows only.
          writer.mark();
          try {
            for (let i = 0; i < keys.length; i++) {
              const key = keys[i] as KEYS;
              writer.value(toBindable(data[key], jsonb[i] as boolean, `column "${key}"`));
            }
          } catch (error) {
            writer.rollback();
            throw error;
          }
          writer.endRow();
          if (writer.rows >= maxBufferSize) flush();
```

- `flush`, its first lines:

```ts
      const flush = () => {
        const rowCount = writer.rows;
        const params = writer.finish(rowTemplate);
        writer = new ParamsWriter();
        queuedRows += rowCount;
```

  and every later `toInsert.length` in `flush` becomes `rowCount`; the `write(...)` call becomes `await write(head, params, { signal })`.
- `close`: `if (buffer.length) flush();` → `if (writer.rows) flush();`.
- `db.debug` (outside semver): a batch's recorded `sql` is now the head and its `params` is `undefined` — `pool.ts` records no values for an `EncodedParams` (Task 3). No test reads a batch's params from `db.debug`; leave it so.

- [ ] **Step 3: Expand the pattern in the worker**

`src/worker/worker.ts`, the `'query'` case, before the `for await` over `query(...)`:

```ts
          // A patterned query is cached under (sql, pattern, rows): a cached
          // statement never builds its text, which is up to ~100 KB.
          const { pattern } = data;
          const rows = params?.rows ?? 0;
          let key = sql;
          let textOf: (() => string) | undefined;
          if (pattern !== undefined) {
            key = `${sql}\u0001${pattern}\u0001${rows}`;
            let text: string | undefined;
            textOf = () => (text ??= sql + new Array(rows).fill(pattern).join(','));
          }
```

and the call becomes `query(callId, key, params, options, textOf)`. `controlSql`, `preparing`, `cache.delete/set/markUncacheable` all key on `key`, which is what `query`'s `sql` parameter already is.

- [ ] **Step 4: Run**

```bash
pnpm exec tsc --noEmit
pnpm exec rstest --project unit run
pnpm exec rstest --project 'chromium*' run tests/browser/bulk-write.test.ts tests/browser/output.test.ts tests/browser/statement-cache.test.ts tests/browser/backpressure.test.ts tests/browser/tx-write.test.ts
```

Expected: PASS. `statement-cache.test.ts`'s `retains a bulkWrite template across its batches` and `holds both templates` keep passing: the debug `sql` of a batch is the head, which starts with `INSERT INTO`. Then `pnpm test` (three reports as in Task 3).

- [ ] **Step 5: Format and commit**

```bash
pnpm exec biome check --write src/bulk.ts src/worker/worker.ts tests/unit/bulk.test.ts tests/browser/bulk-write.test.ts
pnpm exec tsc --noEmit
git add src/bulk.ts src/worker/worker.ts tests/unit/bulk.test.ts tests/browser/bulk-write.test.ts
git commit -m "perf(bulk): encode rows at enqueue() and let the worker expand the INSERT

Rows die as they are enqueued instead of living in arrays until the batch is
cloned, and the page no longer builds the batch's SQL text.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Documentation

**Files:**
- Modify: `API.md` — `#### How values are stored` (under `bulkWrite`), the error table under `## Error handling`
- Modify: `CHANGELOG.md` — `## [Unreleased]`

- [ ] **Step 1: `API.md`**

Move `#### How values are stored` out of the `bulkWrite` section into a section of its own, `## How params are bound`, placed before `## Error handling`, and keep a link to it where it was (`[How values are stored](#how-params-are-bound)` in the `types` row and one sentence in `bulkWrite`: "Values are converted as for every query: [How params are bound](#how-params-are-bound)."). Its opening, before the table:

```md
Every method that takes `params` — and `bulkWrite()`'s rows — converts each value before it leaves the page. A query that wants JSONB writes `jsonb(?)` itself; `bulkWrite()` does it for the columns its `types` declares.
```

Keep the table and the paragraphs as they are, then change the sentence about refusals to:

```md
**A value no rule can bind is refused before anything is sent.**<br>A `Symbol`, a function, a `bigint` outside SQLite's 64-bit range, or a value `JSON.stringify` refuses — a nested `bigint`, a cycle — throws `INVALID_VALUE`, naming the param or the column. In `bulkWrite()` it is thrown by `enqueue()`, and that row alone is not written.
```

Add the row to the error table, after `INVALID_PRAGMA`:

```md
| `INVALID_VALUE` | A param, or a cell given to `bulkWrite()`, has no SQLite value: a `Symbol`, a function, a `bigint` outside the 64-bit range, or a value `JSON.stringify` refuses. Raised before any worker runs; the message names the param or the column, and `cause` carries the conversion's own error. |
```

- [ ] **Step 2: `CHANGELOG.md`** — read the `changelog-maintenance` skill first, then under `## [Unreleased]`:

```md
### Added

- `INVALID_VALUE`, thrown when a param or a `bulkWrite()` cell has no SQLite value.

### Changed

- **Breaking:** an array passed as a param is bound as JSON text, no longer as bytes. Pass a `Uint8Array` to bind bytes.
- `bulkWrite()` and queries with large params use less memory.

### Fixed

- An object or a `Date` passed as a param is no longer bound as `NULL`.
- A value `bulkWrite()` cannot bind is refused by `enqueue()` for its own row, instead of failing the whole batch.
```

Merge into existing subsections if `[Unreleased]` already has them; a `**Breaking:**` entry stays first in `Changed`.

- [ ] **Step 3: Check and commit**

```bash
pnpm docs:vfs && git diff --exit-code VFS.md
git add API.md CHANGELOG.md
git commit -m "docs: params conversion, INVALID_VALUE, and the binary protocol in the changelog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Delivery verification and the footprint re-measured

**Files:**
- Modify: `.serena/memories/measurements/footprint.md` (BINARY-PROTOCOL), `.serena/memories/state.md` (baseline table if it moved), `.serena/memories/follow-ups.md` (the binary protocol entry)

- [ ] **Step 1: The full gate**

```bash
pnpm exec tsc --noEmit
pnpm exec biome ci .
pnpm build
pnpm test
pnpm test:conformance
pnpm test:consumer
pnpm test:matrix
```

Expected: everything green; `pnpm test` three reports with `status: pass`, `failedFiles: 0`, skips as the `mem:state` baseline; conformance Chromium 83/14 and Firefox 79/18 unless a new test changed it; the matrix 66 of 66. Arm a progress report every two minutes for the matrix (~40 min).

- [ ] **Step 2: Re-measure on the implementation**

Reuse `.scratchpad/binary-protocol-2026-10-07/` (`direct.mjs`, `page.html`): build `main` and this branch into two `dist` copies, and run, direct on Chromium and Firefox, n=3: the 500 MiB `bulkWrite` on `OPFSAdaptiveVFS`, `OPFSCoopSyncVFS`, `OPFSWriteAheadVFS`; the 4 000 000 small rows; the 200 × 1 MiB params; and the per-query micro (`main` against the branch, interleaved by running the two `dist` alternately per round). The page's `__bsq*` switches do not exist on the branch: drive both builds with the defaults. Expected: peaks and times within the spike's ranges (BINARY-PROTOCOL); a regression is a finding to report, not to tune away.

- [ ] **Step 3: Memories and commit**

Record the re-measurement under BINARY-PROTOCOL (date, method, figures), refresh `mem:state`'s verification baseline in one pass if any figure moved, and rewrite the binary protocol entry of `mem:follow-ups` to what is left (worker → page). Commit on the branch:

```bash
git add .serena/memories
git commit -m "docs(memory): binary protocol shipped on the branch, footprint re-measured

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Merging into `main` is the user's call.
