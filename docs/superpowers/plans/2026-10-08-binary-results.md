# Worker → page binary results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send every chunk of result rows from the worker to the page as one transferred binary buffer, encoded from SQLite's column API, and decode it on the page into exactly the objects the consumer receives today.

**Architecture:** In the worker, a `RowWriter` (`src/worker/binary.ts`) writes each row of a statement into one growable buffer per chunk with the params block's tags; `worker.ts` posts the resulting `RowsBlock` with its buffer as a transferable. On the page, `pool.ts` queues the block as received and decodes it with `decodeRows` (`src/binary.ts`) when it hands the chunk over. Nothing above `pool.ts` changes.

**Tech Stack:** TypeScript, wa-sqlite (vendored, `jspi`/`async`/`sync` builds), rstest (unit + browser via Playwright Chromium/Firefox), biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-08-binary-results-design.md` — read it before any task; decisions D1-D5 there are binding.

## Global Constraints

- Branch `feat/binary-results`, already created off `main`, already holding the spec and this plan. Every commit lands on it, on green: `pnpm exec tsc --noEmit` clean and the unit project green before each commit. Check `git branch --show-current` reads `feat/binary-results` in the same command as every commit.
- **Code tools:** Serena's symbolic tools are PRIMARY for code (`get_symbols_overview`, `find_symbol` with `include_body`, `find_referencing_symbols`; edits with `replace_symbol_body`, `insert_before_symbol`/`insert_after_symbol`, `replace_content`). Built-in Read/Edit/Grep on code files only as a fallback when Serena fails. Read/Edit are fine for `.md`, JSON, YAML. File renames: `git mv`.
- **Never** `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`. Run `pnpm exec tsc --noEmit` yourself before each commit. If a hook fails, stop and report its output verbatim. After committing, confirm with `git log --oneline -1` and `git show --stat HEAD`.
- After every modification: `pnpm exec biome check --write <files>`.
- Commit messages: Conventional Commits, body says why, ending with the implementing model's own `Co-Authored-By:` line.
- Comments state the fact in one or two lines. No counts in docs or comments ("the methods above", never "the five methods") — numbers only for measurements and real values.
- Unit tests: `pnpm exec rstest --project unit run <file>`. Browser tests: `pnpm exec rstest --project 'chromium*' run <file>` and `pnpm exec rstest --config rstest.firefox.config.ts run <file>`. The `'chromium*'` glob is required.
- The tags (spec § 2), verbatim: `0` NULL; `1` int32 (4 bytes); `2` float64 (8 bytes); `3` text (u32 byte length + UTF-8 bytes as SQLite gives them); `4` BLOB (u32 byte length + bytes); `5` int64 (8 bytes, two 32-bit halves, low first); little-endian. The worker writes tag 1 when `hi === lo >> 31`, tag 5 otherwise.
- **No `ArrayBuffer.prototype.transfer`**: it is newer than the library's Firefox floor. Grow by allocating a new buffer and copying.
- **Text decodes with `new TextDecoder('utf-8', { ignoreBOM: true })`**, as wa-sqlite's `readUTF8` (`node_modules/wa-sqlite/src/sqlite-api.js:42`); a default `TextDecoder` strips a leading byte-order mark.
- **A blob is a copy (`slice()`)** owning its own `ArrayBuffer`, never a view on the received buffer.
- Integers decode with wa-sqlite's `cvt32x2AsSafe` rule: a `number` when the high half is within `[-2097152, 2097151]`, a `bigint` otherwise.
- Out of scope: Firefox's narrow-row slowness, recycling result buffers, lazy or columnar decoding.

## Review Focus

1. **A leading byte-order mark in text.** `SELECT char(65279) || 'x'` must return the two-character string `'﻿x'` as today. Test in Task 2 (unit) and Task 4 (browser).
2. **The ±2^53 boundary of integers.** `9007199254740992` → `9007199254740992n`, `-9007199254740992` → the number `-9007199254740992`, `-9007199254740993` → `-9007199254740993n` (wa-sqlite's asymmetric rule). Test in Task 2 and Task 4.
3. **A value larger than the chunk's current buffer.** A 300 000-byte text after small rows in the same chunk, and a first value larger than 4 KiB. Expected: intact, and the buffers grown by copy (no `transfer`). Test in Task 3 and Task 4.
4. **A blob the consumer keeps.** Expected: each blob owns a buffer of exactly its length (`v.buffer.byteLength === v.length`), so keeping it keeps no chunk alive and reading `v.buffer` whole gives only its bytes. Test in Task 2 and Task 4.
5. **A multi-statement string whose statements return different columns.** Expected: each statement's rows carry their own column names; no chunk mixes two statements. Test in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/encode.ts` → `src/binary.ts` (rename, then modify) | The page side of the binary format: params encoding (existing) and `decodeRows` (new) |
| `src/worker/bind.ts` → `src/worker/binary.ts` (rename, then modify) | The worker side: `bindBlock` (existing) and `RowWriter` (new) |
| `src/types/protocol.ts` (modify) | `RowsBlock`; the `chunk` message's `data` |
| `src/wa-sqlite.d.ts` (modify) | The `sqlite3_column_*` exports and `getTempRet0` on `WASQLiteModule` |
| `src/worker/worker.ts` (modify) | `run()` writes rows through `RowWriter`; `reply` transfers |
| `src/pool.ts` (modify) | Queue the block, decode at hand-over |
| `tests/unit/encode.test.ts` → `tests/unit/binary.test.ts` | Existing encoder tests plus `decodeRows` and `RowWriter` tests |
| `tests/unit/helpers/rows.ts` (create) | Test-only: build a `RowsBlock` from typed cells; a fake module for `RowWriter` |
| `tests/browser/results.test.ts` (create) | Parity of every value through every read path |
| `CHANGELOG.md` (modify) | One `Changed` entry |

---

### Task 1: One binary module per side of the boundary

Pure rename; no behaviour changes.

**Files:**
- Rename: `src/encode.ts` → `src/binary.ts`, `src/worker/bind.ts` → `src/worker/binary.ts`, `tests/unit/encode.test.ts` → `tests/unit/binary.test.ts`
- Modify imports in: `src/queries.ts:9`, `src/pool.ts:7`, `src/bulk.ts:9`, `src/client.ts:13`, `src/transaction.ts:10`, `src/worker/worker.ts:46`, `tests/unit/binary.test.ts:7`, `tests/unit/helpers/params.ts:1`, `tests/browser/params.test.ts:2`
- Modify comments in: `src/wa-sqlite.d.ts` (the two that name `src/worker/bind.ts`)

**Interfaces:**
- Produces: `src/binary.ts` exporting everything `src/encode.ts` exported (`EncodedParams`, `ParamsWriter`, `encodeParams`, `prepareParams`, `QueryParams`, …); `src/worker/binary.ts` exporting `bindBlock`.

- [ ] **Step 1: Rename**

```bash
git mv src/encode.ts src/binary.ts
git mv src/worker/bind.ts src/worker/binary.ts
git mv tests/unit/encode.test.ts tests/unit/binary.test.ts
```

- [ ] **Step 2: Fix every import**

In each file listed above, `'./encode'` → `'./binary'`, `'../../src/encode'` → `'../../src/binary'`, `'../../../src/encode'` → `'../../../src/binary'`, and in `src/worker/worker.ts` `'./bind'` → `'./binary'`. Then find any mention left:

```bash
grep -rn "encode'\|/bind'\|encode\.ts\|bind\.ts\|encode\.test" src tests scripts rstest*.ts
```

Expected: no output. Fix any line it shows (a comment naming `src/worker/bind.ts` or `src/encode.ts` names the new file). Do not touch `docs/` — earlier specs and plans are history.

- [ ] **Step 3: Verify**

```bash
pnpm exec tsc --noEmit && pnpm exec rstest --project unit run && pnpm exec biome check --write src tests
```

Expected: tsc clean; unit project all green (648 tests on `main` at the time of writing, same count after the rename).

- [ ] **Step 4: Commit**

```bash
test "$(git branch --show-current)" = feat/binary-results && git add -A src tests && git commit -m "refactor: one binary module per side of the worker boundary

The page side gains a row decoder and the worker side a row writer in
the next commits; each pairs with the half of the format it already
holds (params encoding, params binding).

Co-Authored-By: <your model line>"
```

---

### Task 2: `RowsBlock` and `decodeRows` on the page

**Files:**
- Modify: `src/types/protocol.ts` (add `RowsBlock` after `ParamsBlock`)
- Modify: `src/binary.ts` (add `decodeRows`)
- Create: `tests/unit/helpers/rows.ts`
- Test: `tests/unit/binary.test.ts`

**Interfaces:**
- Produces: `export type RowsBlock = { columns: string[]; rows: number; buffer: ArrayBuffer; used: number }` in `src/types/protocol.ts`; `export const decodeRows = <T = Record<string, unknown>>(block: RowsBlock): T[]` in `src/binary.ts`; test helper `rowsBlock(columns: string[], cells: Cell[]): RowsBlock` and type `Cell` in `tests/unit/helpers/rows.ts`.

- [ ] **Step 1: Add the type**

In `src/types/protocol.ts`, after `ParamsBlock`:

```ts
/**
 * Result rows encoded in the worker: `rows` rows of `columns.length` values,
 * row after row, with `ParamsBlock`'s tags; tag 5 holds the int64 as two
 * 32-bit halves, low first. The first `used` bytes of `buffer` are written.
 */
export type RowsBlock = {
  columns: string[];
  rows: number;
  buffer: ArrayBuffer;
  used: number;
};
```

- [ ] **Step 2: Write the test helper**

Create `tests/unit/helpers/rows.ts`:

```ts
import type { RowsBlock } from '../../../src/types/protocol';

/** One encoded value, by tag. */
export type Cell =
  | null
  | { int32: number }
  | { int64: bigint }
  | { float: number }
  | { text: string | Uint8Array }
  | { blob: Uint8Array };

const utf8 = new TextEncoder();

/** Test-only: a block of `cells.length / columns.length` rows. */
export const rowsBlock = (columns: string[], cells: Cell[]): RowsBlock => {
  const parts: Uint8Array[] = [];
  for (const c of cells) {
    if (c === null) {
      parts.push(Uint8Array.of(0));
    } else if ('int32' in c) {
      const b = new Uint8Array(5);
      b[0] = 1;
      new DataView(b.buffer).setInt32(1, c.int32, true);
      parts.push(b);
    } else if ('int64' in c) {
      const b = new Uint8Array(9);
      b[0] = 5;
      const dv = new DataView(b.buffer);
      dv.setInt32(1, Number(BigInt.asIntN(32, c.int64)), true);
      dv.setInt32(5, Number(c.int64 >> 32n), true);
      parts.push(b);
    } else if ('float' in c) {
      const b = new Uint8Array(9);
      b[0] = 2;
      new DataView(b.buffer).setFloat64(1, c.float, true);
      parts.push(b);
    } else {
      const isText = 'text' in c;
      const raw = isText ? c.text : c.blob;
      const bytes = typeof raw === 'string' ? utf8.encode(raw) : raw;
      const b = new Uint8Array(5 + bytes.length);
      b[0] = isText ? 3 : 4;
      new DataView(b.buffer).setUint32(1, bytes.length, true);
      b.set(bytes, 5);
      parts.push(b);
    }
  }
  const used = parts.reduce((n, p) => n + p.length, 0);
  // Larger than `used`, as the worker's buffers are.
  const buffer = new ArrayBuffer(used + 16);
  const u8 = new Uint8Array(buffer);
  let off = 0;
  for (const p of parts) {
    u8.set(p, off);
    off += p.length;
  }
  return {
    columns,
    rows: columns.length ? cells.length / columns.length : 0,
    buffer,
    used,
  };
};
```

- [ ] **Step 3: Write the failing tests**

Append to `tests/unit/binary.test.ts` (add `decodeRows` to the import from `'../../src/binary'`, and `import { rowsBlock } from './helpers/rows';`):

```ts
describe('decodeRows', () => {
  const one = (cell: Parameters<typeof rowsBlock>[1][number]) =>
    decodeRows(rowsBlock(['v'], [cell]))[0]?.v;

  it('decodes every tag', () => {
    expect(one(null)).toBe(null);
    expect(one({ int32: -(2 ** 31) })).toBe(-(2 ** 31));
    expect(one({ int32: 2 ** 31 - 1 })).toBe(2 ** 31 - 1);
    expect(one({ float: 1.5 })).toBe(1.5);
    expect(Object.is(one({ float: -0 }), -0)).toBe(true);
    expect(one({ float: 1e308 })).toBe(1e308);
    expect(one({ text: 'é€😀' })).toBe('é€😀');
    expect(one({ text: '' })).toBe('');
    expect(one({ blob: Uint8Array.of(0, 255) })).toEqual(Uint8Array.of(0, 255));
    expect(one({ blob: new Uint8Array(0) })).toEqual(new Uint8Array(0));
  });

  it('applies wa-sqlite cvt32x2AsSafe rule to int64', () => {
    expect(one({ int64: 2n ** 31n })).toBe(2 ** 31);
    expect(one({ int64: -1n })).toBe(-1);
    expect(one({ int64: 2n ** 53n - 1n })).toBe(2 ** 53 - 1);
    expect(one({ int64: -(2n ** 53n) + 1n })).toBe(-(2 ** 53) + 1);
    expect(one({ int64: 2n ** 53n })).toBe(2n ** 53n);
    expect(one({ int64: -(2n ** 53n) })).toBe(-(2 ** 53));
    expect(one({ int64: -(2n ** 53n) - 1n })).toBe(-(2n ** 53n) - 1n);
    expect(one({ int64: 2n ** 63n - 1n })).toBe(2n ** 63n - 1n);
    expect(one({ int64: -(2n ** 63n) })).toBe(-(2n ** 63n));
  });

  it('decodes text as wa-sqlite readUTF8 does', () => {
    expect(one({ text: Uint8Array.of(0xff) })).toBe('�');
    expect(one({ text: Uint8Array.of(0x61, 0, 0x62) })).toBe('a\0b');
    // ignoreBOM: true keeps a leading byte-order mark.
    expect(one({ text: Uint8Array.of(0xef, 0xbb, 0xbf, 0x78) })).toBe('﻿x');
  });

  it('copies each blob into a buffer of its own', () => {
    const block = rowsBlock(['a', 'b'], [{ blob: Uint8Array.of(1, 2, 3) }, { int32: 7 }]);
    const v = decodeRows(block)[0]?.a as Uint8Array;
    expect(v.buffer).not.toBe(block.buffer);
    expect(v.buffer.byteLength).toBe(3);
    new Uint8Array(block.buffer).fill(0);
    expect(v).toEqual(Uint8Array.of(1, 2, 3));
  });

  it('builds the rows in order, a duplicated column keeping its last value', () => {
    expect(
      decodeRows(rowsBlock(['id', 'x', 'x'], [{ int32: 1 }, { text: 'a' }, { text: 'b' }, { int32: 2 }, null, { float: 0.5 }])),
    ).toEqual([
      { id: 1, x: 'b' },
      { id: 2, x: 0.5 },
    ]);
  });

  it('decodes an empty block', () => {
    expect(decodeRows(rowsBlock(['a'], []))).toEqual([]);
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm exec rstest --project unit run tests/unit/binary.test.ts`
Expected: FAIL — `decodeRows` is not exported from `src/binary.ts`.

- [ ] **Step 5: Implement**

In `src/binary.ts`, add `import type { RowsBlock } from './types/protocol';` (merge with the existing `ParamsBlock` import) and, at the end of the file:

```ts
// wa-sqlite's readUTF8: ignoreBOM keeps a leading byte-order mark.
const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });
// wa-sqlite's cvt32x2AsSafe bounds: the high halves of ±Number.MAX_SAFE_INTEGER.
const HI_MAX = 2097151;
const HI_MIN = -2097152;

/** A chunk of rows as wa-sqlite's `row()` and the worker's loop built them. */
export const decodeRows = <T = Record<string, unknown>>(
  block: RowsBlock,
): T[] => {
  const { columns, rows } = block;
  const n = columns.length;
  const u8 = new Uint8Array(block.buffer, 0, block.used);
  const dv = new DataView(block.buffer, 0, block.used);
  const out = new Array<T>(rows);
  let off = 0;
  for (let r = 0; r < rows; r++) {
    // Deliberately not `Object.fromEntries(...)`: one two-element array per
    // column per row. Measured 2026-08-31 over 50 000 rows x 12 columns —
    // 17.5 ms against 4.4 ms on Chromium, 23 ms against 14 ms on Firefox
    // (`mem:measurements`). Do not "simplify" it back.
    const row: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      const tag = u8[off];
      let v: unknown;
      if (tag === 0) {
        v = null;
        off += 1;
      } else if (tag === 1) {
        v = dv.getInt32(off + 1, true);
        off += 5;
      } else if (tag === 2) {
        v = dv.getFloat64(off + 1, true);
        off += 9;
      } else if (tag === 5) {
        const lo = dv.getInt32(off + 1, true);
        const hi = dv.getInt32(off + 5, true);
        v =
          hi > HI_MAX || hi < HI_MIN
            ? (BigInt(hi) << 32n) | (BigInt(lo) & 0xffffffffn)
            : hi * 0x100000000 + (lo & 0x7fffffff) - (lo & 0x80000000);
        off += 9;
      } else {
        const len = dv.getUint32(off + 1, true);
        const start = off + 5;
        v =
          tag === 3
            ? utf8Decoder.decode(u8.subarray(start, start + len))
            : u8.slice(start, start + len);
        off = start + len;
      }
      row[columns[i] as string] = v;
    }
    out[r] = row as T;
  }
  return out;
};
```

- [ ] **Step 6: Run the tests**

Run: `pnpm exec rstest --project unit run tests/unit/binary.test.ts`
Expected: PASS, every case.

- [ ] **Step 7: Verify and commit**

```bash
pnpm exec biome check --write src/binary.ts src/types/protocol.ts tests/unit/binary.test.ts tests/unit/helpers/rows.ts
pnpm exec tsc --noEmit && pnpm exec rstest --project unit run
test "$(git branch --show-current)" = feat/binary-results && git add src/binary.ts src/types/protocol.ts tests/unit/binary.test.ts tests/unit/helpers/rows.ts && git commit -m "feat(binary): decode a chunk of result rows on the page

The worker will send rows as one buffer per chunk with the params
block's tags; this turns it into the objects wa-sqlite's row() gives
today, with its integer rule and its BOM-keeping text decoder.

Co-Authored-By: <your model line>"
```

---

### Task 3: `RowWriter` in the worker

**Files:**
- Modify: `src/wa-sqlite.d.ts` (declare the column exports on `WASQLiteModule`)
- Modify: `src/worker/binary.ts` (add `RowWriter`)
- Modify: `tests/unit/helpers/rows.ts` (add `fakeModule`)
- Test: `tests/unit/binary.test.ts`

**Interfaces:**
- Consumes: `RowsBlock` (Task 2), `decodeRows` (Task 2, in the tests).
- Produces: `export class RowWriter { rows: number; constructor(initial?: number); row(module: WASQLiteModule, stmt: number, n: number): void; finish(columns: string[]): RowsBlock }` in `src/worker/binary.ts`; test helper `fakeModule(cells: FakeCell[]): WASQLiteModule` and type `FakeCell`.

- [ ] **Step 1: Declare the exports**

In `src/wa-sqlite.d.ts`, inside `type WASQLiteModule`, before `HEAPU8`:

```ts
  /**
   * The `sqlite3_column_*` entry points `RowWriter` (`src/worker/binary.ts`)
   * reads a row through. Exported by all three builds (checked 2026-10-08).
   */
  _sqlite3_column_type: (stmt: number, col: number) => number;
  /** The low 32 bits; the high 32 are read with `getTempRet0()` right after. */
  _sqlite3_column_int64: (stmt: number, col: number) => number;
  _sqlite3_column_double: (stmt: number, col: number) => number;
  _sqlite3_column_text: (stmt: number, col: number) => number;
  _sqlite3_column_blob: (stmt: number, col: number) => number;
  _sqlite3_column_bytes: (stmt: number, col: number) => number;
  /** The high 32 bits of the last 64-bit result: wasm i64 is legalised to two halves. */
  getTempRet0: () => number;
```

- [ ] **Step 2: Write the fake module**

Append to `tests/unit/helpers/rows.ts`:

```ts
/** One column of the fake statement's current row, as SQLite would type it. */
export type FakeCell =
  | { type: 1; value: bigint }
  | { type: 2; value: number }
  | { type: 3 | 4; bytes: Uint8Array }
  | { type: 5 };

/**
 * Test-only: the column API of a statement whose current row is `cells`,
 * text and blobs placed in a fake heap. A blob of length 0 has pointer 0, as
 * `sqlite3_column_blob` returns for an empty blob.
 */
export const fakeModule = (cells: FakeCell[]): WASQLiteModule => {
  const HEAPU8 = new Uint8Array(1 << 20);
  const ptrs: number[] = [];
  let at = 8;
  for (const c of cells) {
    if ((c.type === 3 || c.type === 4) && c.bytes.length > 0) {
      HEAPU8.set(c.bytes, at);
      ptrs.push(at);
      at += c.bytes.length;
    } else {
      ptrs.push(0);
    }
  }
  let tempRet = 0;
  const cell = (i: number) => cells[i] as FakeCell;
  return {
    HEAPU8,
    _sqlite3_column_type: (_s: number, i: number) => cell(i).type,
    _sqlite3_column_int64: (_s: number, i: number) => {
      const v = (cell(i) as { value: bigint }).value;
      tempRet = Number(v >> 32n);
      return Number(BigInt.asIntN(32, v));
    },
    getTempRet0: () => tempRet,
    _sqlite3_column_double: (_s: number, i: number) =>
      (cell(i) as { value: number }).value,
    _sqlite3_column_text: (_s: number, i: number) => ptrs[i] as number,
    _sqlite3_column_blob: (_s: number, i: number) => ptrs[i] as number,
    _sqlite3_column_bytes: (_s: number, i: number) =>
      (cell(i) as { bytes: Uint8Array }).bytes.length,
  } as unknown as WASQLiteModule;
};
```

- [ ] **Step 3: Write the failing tests**

Append to `tests/unit/binary.test.ts` (import `RowWriter` from `'../../src/worker/binary'` and `fakeModule` from `'./helpers/rows'`):

```ts
describe('RowWriter', () => {
  const roundTrip = (cells: Parameters<typeof fakeModule>[0]) => {
    const w = new RowWriter();
    w.row(fakeModule(cells), 0, cells.length);
    const block = w.finish(cells.map((_, i) => `c${i}`));
    return { block, values: Object.values(decodeRows(block)[0] ?? {}) };
  };

  it('writes every column type and decodes back to it', () => {
    const { values } = roundTrip([
      { type: 1, value: 0n },
      { type: 1, value: -(2n ** 31n) },
      { type: 1, value: 2n ** 31n },
      { type: 1, value: 2n ** 53n },
      { type: 1, value: -(2n ** 63n) },
      { type: 2, value: 1.5 },
      { type: 3, bytes: new TextEncoder().encode('é€😀') },
      { type: 3, bytes: new Uint8Array(0) },
      { type: 4, bytes: Uint8Array.of(9, 8) },
      { type: 4, bytes: new Uint8Array(0) },
      { type: 5 },
    ]);
    expect(values).toEqual([
      0,
      -(2 ** 31),
      2 ** 31,
      2n ** 53n,
      -(2n ** 63n),
      1.5,
      'é€😀',
      '',
      Uint8Array.of(9, 8),
      new Uint8Array(0),
      null,
    ]);
  });

  it('writes an int32 in 5 bytes and a wider integer in 9', () => {
    expect(roundTrip([{ type: 1, value: -1n }]).block.used).toBe(5);
    expect(roundTrip([{ type: 1, value: 2n ** 31n }]).block.used).toBe(9);
  });

  it('grows past its initial size for a large value, by copy', () => {
    const big = new Uint8Array(300_000).fill(7);
    const w = new RowWriter();
    const m1 = fakeModule([{ type: 3, bytes: Uint8Array.of(0x61) }]);
    for (let i = 0; i < 100; i++) w.row(m1, 0, 1);
    w.row(fakeModule([{ type: 4, bytes: big }]), 0, 1);
    const block = w.finish(['v']);
    expect(block.rows).toBe(101);
    expect(block.buffer.byteLength).toBeGreaterThanOrEqual(block.used);
    const rows = decodeRows(block);
    expect(rows[99]).toEqual({ v: 'a' });
    expect(rows[100]?.v).toEqual(big);
  });

  it('starts at the size it is given', () => {
    expect(new RowWriter(10_000).finish([]).buffer.byteLength).toBeGreaterThanOrEqual(10_000);
    expect(new RowWriter().finish([]).buffer.byteLength).toBe(4096);
  });

  it('counts its rows', () => {
    const w = new RowWriter();
    const m = fakeModule([{ type: 5 }, { type: 2, value: 2 }]);
    w.row(m, 0, 2);
    w.row(m, 0, 2);
    expect(w.rows).toBe(2);
    expect(decodeRows(w.finish(['a', 'b']))).toEqual([
      { a: null, b: 2 },
      { a: null, b: 2 },
    ]);
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm exec rstest --project unit run tests/unit/binary.test.ts`
Expected: FAIL — `RowWriter` is not exported from `src/worker/binary.ts`.

- [ ] **Step 5: Implement**

In `src/worker/binary.ts`, extend the constants import with `SQLITE_BLOB, SQLITE_FLOAT, SQLITE_INTEGER, SQLITE_TEXT` (from `'wa-sqlite/src/sqlite-constants.js'`), add `RowsBlock` to the type import from `'../types/protocol'`, and append:

```ts
const MIN_ROW_BYTES = 4096;

/**
 * Writes a chunk of result rows into one buffer, read straight from SQLite's
 * column API, in `RowsBlock`'s format. The buffer starts at 4 KiB or at
 * `initial` — the size the query's previous chunk needed — and doubles by
 * copy: `ArrayBuffer.prototype.transfer` is newer than the Firefox floor.
 */
export class RowWriter {
  rows = 0;
  #buffer: ArrayBuffer;
  #u8: Uint8Array;
  #dv: DataView;
  #off = 0;

  constructor(initial = 0) {
    this.#buffer = new ArrayBuffer(Math.max(MIN_ROW_BYTES, initial));
    this.#u8 = new Uint8Array(this.#buffer);
    this.#dv = new DataView(this.#buffer);
  }

  #room(n: number) {
    const need = this.#off + n;
    if (need <= this.#buffer.byteLength) return;
    let size = this.#buffer.byteLength * 2;
    while (size < need) size *= 2;
    const next = new ArrayBuffer(size);
    const u8 = new Uint8Array(next);
    u8.set(this.#u8.subarray(0, this.#off));
    this.#buffer = next;
    this.#u8 = u8;
    this.#dv = new DataView(next);
  }

  /** Appends the statement's current row, its first `n` columns. */
  row(module: WASQLiteModule, stmt: number, n: number) {
    for (let i = 0; i < n; i++) {
      const type = module._sqlite3_column_type(stmt, i);
      if (type === SQLITE_INTEGER) {
        const lo = module._sqlite3_column_int64(stmt, i);
        const hi = module.getTempRet0();
        if (hi === lo >> 31) {
          this.#room(5);
          this.#u8[this.#off] = 1;
          this.#dv.setInt32(this.#off + 1, lo, true);
          this.#off += 5;
        } else {
          this.#room(9);
          this.#u8[this.#off] = 5;
          this.#dv.setInt32(this.#off + 1, lo, true);
          this.#dv.setInt32(this.#off + 5, hi, true);
          this.#off += 9;
        }
      } else if (type === SQLITE_FLOAT) {
        this.#room(9);
        this.#u8[this.#off] = 2;
        this.#dv.setFloat64(
          this.#off + 1,
          module._sqlite3_column_double(stmt, i),
          true,
        );
        this.#off += 9;
      } else if (type === SQLITE_TEXT || type === SQLITE_BLOB) {
        // Pointer first, then the byte count: SQLite's recommended order,
        // which wa-sqlite's column_text follows.
        const ptr =
          type === SQLITE_TEXT
            ? module._sqlite3_column_text(stmt, i)
            : module._sqlite3_column_blob(stmt, i);
        const len = module._sqlite3_column_bytes(stmt, i);
        this.#room(5 + len);
        this.#u8[this.#off] = type === SQLITE_TEXT ? 3 : 4;
        this.#dv.setUint32(this.#off + 1, len, true);
        // HEAPU8 read after the calls: the heap may have grown during them.
        this.#u8.set(module.HEAPU8.subarray(ptr, ptr + len), this.#off + 5);
        this.#off += 5 + len;
      } else {
        this.#room(1);
        this.#u8[this.#off] = 0;
        this.#off += 1;
      }
    }
    this.rows++;
  }

  /** The chunk, ready to send; its buffer is transferred, so the writer is spent. */
  finish(columns: string[]): RowsBlock {
    return {
      columns,
      rows: this.rows,
      buffer: this.#buffer,
      used: this.#off,
    };
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm exec rstest --project unit run tests/unit/binary.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify and commit**

```bash
pnpm exec biome check --write src/worker/binary.ts src/wa-sqlite.d.ts tests/unit/binary.test.ts tests/unit/helpers/rows.ts
pnpm exec tsc --noEmit && pnpm exec rstest --project unit run
test "$(git branch --show-current)" = feat/binary-results && git add src/worker/binary.ts src/wa-sqlite.d.ts tests/unit/binary.test.ts tests/unit/helpers/rows.ts && git commit -m "feat(worker): write a chunk of result rows from SQLite's column API

No JS value is built per row in the worker: each column goes from the
wasm heap into one buffer per chunk, small integers in 5 bytes.

Co-Authored-By: <your model line>"
```

---

### Task 4: Send rows as blocks, decode them at hand-over

**Files:**
- Modify: `src/types/protocol.ts` (the `chunk` message)
- Modify: `src/worker/worker.ts` (`query`'s `run()`, the `query` case, `reply`)
- Modify: `src/pool.ts` (`inbox`, the `chunk` handler, the delivery loop)
- Create: `tests/browser/results.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `RowsBlock`, `decodeRows` (Task 2); `RowWriter` (Task 3).
- Produces: the `chunk` message `{ type: 'chunk'; callId: number; data: RowsBlock }`.

- [ ] **Step 1: Write the parity test, and run it on the current code**

Create `tests/browser/results.test.ts`. It characterises today's rows; it must pass **before** any production change in this task. If a case fails on the current code, the current code is the reference: correct that expectation and say so in the report.

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

// Every case of the spec's § 4, written by SQL so no param conversion is involved.
const CASES: [sql: string, expected: unknown][] = [
  ['0', 0],
  ['-1', -1],
  ['2147483647', 2147483647],
  ['-2147483648', -2147483648],
  ['2147483648', 2147483648],
  ['-2147483649', -2147483649],
  ['9007199254740991', 9007199254740991],
  ['-9007199254740991', -9007199254740991],
  ['9007199254740992', 9007199254740992n],
  ['-9007199254740992', -9007199254740992],
  ['-9007199254740993', -9007199254740993n],
  ['9223372036854775807', 9223372036854775807n],
  ['-9223372036854775807 - 1', -9223372036854775808n],
  ['1.5', 1.5],
  ['1e308', 1e308],
  ["''", ''],
  ["'é€😀'", 'é€😀'],
  ["CAST(x'ff' AS TEXT)", '�'],
  ["'a' || char(0) || 'b'", 'a\0b'],
  ["char(65279) || 'x'", '﻿x'],
  ["x''", new Uint8Array(0)],
  ["x'00ff'", Uint8Array.of(0, 255)],
  ['NULL', null],
];

const seed = async (db: Awaited<ReturnType<typeof createTestClient>>) => {
  await db.write('CREATE TABLE r (id INTEGER PRIMARY KEY, v)');
  for (const [sql] of CASES) await db.write(`INSERT INTO r (v) VALUES (${sql})`);
};
const expected = CASES.map(([, v], i) => ({ id: i + 1, v }));

describe('result rows', () => {
  it('come back as today through every read path', async () => {
    const db = await createTestClient();
    await seed(db);
    const sql = 'SELECT id, v FROM r ORDER BY id';
    expect(await db.read(sql)).toEqual(expected);
    expect(await db.first(sql)).toEqual(expected[0]);
    const streamed: unknown[] = [];
    for await (const row of db.stream(sql, [], { chunkSize: 5 })) streamed.push(row);
    expect(streamed).toEqual(expected);
    const chunked: unknown[] = [];
    for await (const rows of db.chunk(sql, [], { chunkSize: 7 })) chunked.push(...rows);
    expect(chunked).toEqual(expected);
    expect(await db.transaction((tx) => tx.read(sql))).toEqual(expected);
    await db.close();
  });

  it('keeps a negative zero and the SQL types', async () => {
    const db = await createTestClient();
    const [row] = await db.read('SELECT -0.0 AS z, typeof(-0.0) AS t');
    expect(row).toEqual({ z: -0, t: 'real' });
    expect(Object.is(row?.z, -0)).toBe(true);
    await db.close();
  });

  it('gives each blob a buffer of its own', async () => {
    const db = await createTestClient();
    const rows = await db.read<{ b: Uint8Array }>(
      "SELECT x'010203' AS b UNION ALL SELECT zeroblob(102400)",
    );
    expect(rows[0]?.b).toEqual(Uint8Array.of(1, 2, 3));
    expect(rows[0]?.b.buffer.byteLength).toBe(3);
    expect(rows[1]?.b.length).toBe(102400);
    expect(rows[1]?.b.buffer.byteLength).toBe(102400);
    await db.close();
  });

  it('carries values larger than a chunk buffer, after small rows', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE k (id INTEGER PRIMARY KEY, v TEXT)');
    await db.write(
      "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 50) INSERT INTO k SELECT i, 'x' || i FROM s",
    );
    await db.write("INSERT INTO k VALUES (51, printf('%.300000c', 'é'))");
    const rows = await db.read<{ id: number; v: string }>('SELECT * FROM k ORDER BY id');
    expect(rows).toHaveLength(51);
    expect(rows[49]).toEqual({ id: 50, v: 'x50' });
    expect(rows[50]?.v).toBe('é'.repeat(300000));
    await db.close();
  });

  it('keeps duplicated column names as today', async () => {
    const db = await createTestClient();
    expect(await db.read('SELECT 1 AS a, 2 AS a')).toEqual([{ a: 2 }]);
    await db.close();
  });

  it('gives each statement of a multi-statement string its own columns', async () => {
    const db = await createTestClient();
    const rows: unknown[] = [];
    for await (const chunk of db.chunk('SELECT 1 AS a; SELECT 2 AS b, 3 AS c', [], { chunkSize: 10 }))
      rows.push(chunk);
    expect(rows).toEqual([[{ a: 1 }], [{ b: 2, c: 3 }]]);
    await db.close();
  });
});
```

Before running, check two things against the current code and adapt the test, not the code: whether `createTestClient` takes the client's options as its argument (see `tests/browser/helpers.ts`), and whether `db.chunk` accepts a multi-statement string — if it refuses it (`assertReadable` or `isSingleStatement`), replace that last test's call with whatever entry point accepts one today (`db.query`, or `db.write` returning rows), and if none returns rows for several statements, delete that test and say so in the report.

Run on the current code:
`pnpm exec rstest --project 'chromium*' run tests/browser/results.test.ts` and `pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/results.test.ts`
Expected: PASS on both (it describes today's behaviour). Do not commit yet.

- [ ] **Step 2: The protocol**

In `src/types/protocol.ts`, the `WorkerMessageData` member `| { type: 'chunk'; callId: number; data: unknown[] }` becomes:

```ts
  | { type: 'chunk'; callId: number; data: RowsBlock }
```

- [ ] **Step 3: The worker writes blocks**

In `src/worker/worker.ts`:

a. Import `RowWriter` beside `bindBlock` from `'./binary'`, and `RowsBlock` with the other protocol types.

b. In `query`, replace

```ts
    const buffer: Record<string, unknown>[] = [];
```

with

```ts
    // The size the query's previous chunk needed: the next one starts there.
    let chunkBytes = 0;
```

c. In `run()`, declare the writer next to `cols` (per statement: a chunk never mixes two statements' columns):

```ts
      let cols: string[] | undefined;
      let writer: RowWriter | undefined;
```

and replace the `SQLITE_ROW` branch and its `else` — from `if (result === SQLITE_ROW) {` through the `break;` that ends the `else` — with:

```ts
        if (result === SQLITE_ROW) {
          cols ??= sqlite.column_names(stmt) as string[];
          writer ??= new RowWriter(chunkBytes);
          writer.row(module, stmt, cols.length);
          if (writer.rows >= chunkSize) {
            const block = writer.finish(cols);
            chunkBytes = block.used;
            writer = undefined;
            yield block;
          }
        } else {
          if (writer && cols) yield writer.finish(cols);
          break;
        }
```

The comment block about `Object.fromEntries` above the old object loop goes with it — Task 2 moved it into `decodeRows`. Keep the comment about column names being read after the first `SQLITE_ROW`.

d. `reply` takes a transfer list. `self` is typed as a `Window` in this file, whose `postMessage` takes a target origin second, hence the cast:

```ts
  const reply = (data: WorkerMessageData, transfer: Transferable[] = []) => {
    (
      self as unknown as {
        postMessage(data: WorkerMessageData, transfer: Transferable[]): void;
      }
    ).postMessage(data, transfer);
  };
```

e. In the `query` case, the chunk is sent with its buffer transferred:

```ts
            reply({ type: 'chunk', callId, data: chunk }, [chunk.buffer]);
```

Run `pnpm exec tsc --noEmit`. The generator's yield type is now `RowsBlock | number`; fix any remaining site that assumed an array (the control-statement path that discards its rows needs no change).

- [ ] **Step 4: The pool decodes at hand-over**

In `src/pool.ts`:

a. Import `decodeRows` from `'./binary'` (beside the existing imports from it) and `RowsBlock` from `'./types/protocol'`.

b. `let inbox: (unknown[] | number)[] = [];` becomes `let inbox: (RowsBlock | number)[] = [];`.

c. In the `chunk` handler, `debugQuery?.chunk(data.data.length);` becomes `debugQuery?.chunk(data.data.rows);` — `inbox.push(data.data)` is unchanged.

d. In the delivery loop, replace

```ts
        const chunk = inbox.shift() as T[] | number;
        yield chunk;
```

with

```ts
        const chunk = inbox.shift() as RowsBlock | number;
        // Decoded as it is handed over: the inbox keeps the compact form, and
        // a chunk a stop leaves behind is never decoded.
        yield typeof chunk === 'number' ? chunk : decodeRows<T>(chunk);
```

The credit below it still tests `typeof chunk !== 'number'`, unchanged. Search `inbox` in the file: every push is now a `RowsBlock` or the `affected` number.

- [ ] **Step 5: Run the parity test and the suites**

```bash
pnpm exec tsc --noEmit
pnpm exec rstest --project unit run
pnpm exec rstest --project 'chromium*' run tests/browser/results.test.ts
pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/results.test.ts
pnpm test
```

Expected: tsc clean; `results.test.ts` PASS on both engines, unchanged since Step 1; `pnpm test` three reports with `status: pass` and `failedFiles: 0` each, and no test in the existing files changed. Read `status` and `failedFiles` in each report, not only the counts.

- [ ] **Step 6: The changelog**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Changed` (create the subsection if absent, after any `**Breaking:**` entries), add:

```md
- Query results cross from the worker to the page in binary form: faster reads, and lower memory for large results.
```

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write src/worker/worker.ts src/pool.ts src/types/protocol.ts tests/browser/results.test.ts
pnpm exec tsc --noEmit
test "$(git branch --show-current)" = feat/binary-results && git add src/worker/worker.ts src/pool.ts src/types/protocol.ts tests/browser/results.test.ts CHANGELOG.md && git commit -m "feat: result rows cross from the worker as transferred binary chunks

Each chunk is one buffer written from SQLite's column API and decoded
into the same objects when pool.ts hands it over. Measured on a spike:
neutral for one row, faster from a hundred, and streamed reads peak far
lower on Firefox (RESULT-BINARY).

Co-Authored-By: <your model line>"
```

---

### Task 5: Delivery (controller, not a subagent)

- [ ] `pnpm exec tsc --noEmit`, `pnpm exec biome ci .`, `pnpm lint` (warning count unchanged: 4), `pnpm test` (three reports, four fields each), `pnpm test:conformance` (both engines; 83/14 and 79/18 on `main`), `pnpm docs:vfs` with `git diff --exit-code`, `pnpm test:consumer`.
- [ ] `pnpm test:matrix` — `src/pool.ts` and `src/worker/` changed. Progress line every two minutes.
- [ ] RESULT-BINARY re-run with the direct harness, `main` against the branch: the per-query micro (both builds in one page, alternating) and the large-result cases, both engines; numbers into `mem:measurements/footprint`.
- [ ] Memories: `mem:history/2026-10` row, `mem:follow-ups` binary-protocol entry closed, `mem:state` baseline re-measured.
- [ ] Final whole-branch review (capable tier), then `git merge --no-ff` into `main` on the user's go.

---

### Task 6: Short texts decoded in JS (spec D6, amendment of 2026-10-08)

Added after the delivery measurement found that, on Chromium, strings `TextDecoder` returns on the page hold ~150-190 bytes more each than cloned ones. Runs before Task 5's remaining steps resume.

**Files:**
- Modify: `src/binary.ts` (`decodeRows`'s text branch, plus a short-text decoder above it)
- Test: `tests/unit/binary.test.ts`, `tests/browser/results.test.ts`

**Interfaces:**
- Consumes: `decodeRows` (Task 2), `rowsBlock` (Task 2's test helper, which accepts `{ text: Uint8Array }`).
- Produces: no new export; `decodeRows`'s output is unchanged by definition (parity with `TextDecoder('utf-8', { ignoreBOM: true })`).

- [ ] **Step 1: Write the failing-or-guarding unit tests**

Append to `tests/unit/binary.test.ts`:

```ts
describe('decodeRows short texts', () => {
  const reference = new TextDecoder('utf-8', { ignoreBOM: true });
  const decodeText = (bytes: Uint8Array) =>
    decodeRows(rowsBlock(['v'], [{ text: bytes }]))[0]?.v;
  const utf8 = new TextEncoder();

  it('decodes valid UTF-8 on both sides of 32 bytes as TextDecoder does', () => {
    const texts: string[] = [];
    for (let n = 0; n <= 40; n++) texts.push('a'.repeat(n));
    for (let n = 1; n <= 20; n++) texts.push('é'.repeat(n));
    for (let n = 1; n <= 12; n++) texts.push('€'.repeat(n));
    for (let n = 1; n <= 10; n++) texts.push('😀'.repeat(n));
    texts.push('aé€😀', '\0', 'a\0b', '﻿x', '﻿', '￿', '\u{10ffff}', '\u0080', '߿', 'ࠀ');
    for (const t of texts) {
      const bytes = utf8.encode(t);
      expect(decodeText(bytes)).toBe(reference.decode(bytes));
      expect(decodeText(bytes)).toBe(t);
    }
  });

  it('decodes invalid UTF-8 exactly as TextDecoder does, short or long', () => {
    const invalid = [
      [0xff],
      [0x80],
      [0xc0, 0xaf],
      [0xc1, 0xbf],
      [0xc3],
      [0xc3, 0x41],
      [0x41, 0xc3],
      [0xe0, 0x80, 0x8f],
      [0xe2, 0x82],
      [0xed, 0xa0, 0x80],
      [0xed, 0xbf, 0xbf],
      [0xf0],
      [0xf0, 0x8f, 0xbf, 0xbf],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf5, 0x80, 0x80, 0x80],
      [0xf0, 0x9f, 0x98],
    ];
    for (const seq of invalid) {
      for (const pad of [0, 28, 40]) {
        const bytes = Uint8Array.from([...Array(pad).fill(0x61), ...seq]);
        expect(decodeText(bytes)).toBe(reference.decode(bytes));
        const after = Uint8Array.from([...seq, ...Array(pad).fill(0x62)]);
        expect(decodeText(after)).toBe(reference.decode(after));
      }
    }
  });

  it('decodes texts of exactly 31, 32 and 33 bytes', () => {
    for (const n of [31, 32, 33]) {
      const ascii = utf8.encode('x'.repeat(n));
      expect(decodeText(ascii)).toBe('x'.repeat(n));
      // A four-byte character straddling the threshold.
      const mixed = utf8.encode(`${'y'.repeat(n - 4)}😀`);
      expect(decodeText(mixed)).toBe(reference.decode(mixed));
    }
  });
});
```

Run: `pnpm exec rstest --project unit run tests/unit/binary.test.ts`
Expected: PASS on the current code (it uses `TextDecoder` for everything, which is the reference) — these tests guard the change, they do not drive it. Do not commit yet.

- [ ] **Step 2: Implement the short-text decoder**

In `src/binary.ts`, just above `decodeRows`'s doc comment, add:

```ts
// Texts up to this many bytes are decoded in JS (spec 2026-10-08, D6): on
// Chromium a string TextDecoder returns holds ~150-190 bytes more than a
// cloned one, and is slower to make for short texts (RESULT-BINARY).
const SHORT_TEXT = 32;
const shortUnits = new Uint16Array(SHORT_TEXT);

/**
 * Valid UTF-8 as a string, or undefined for anything TextDecoder would have
 * to replace — an invalid lead byte, a missing or wrong continuation byte, an
 * overlong form, an encoded surrogate, a code point above U+10FFFF — so the
 * caller's TextDecoder keeps the replacement exactly its own.
 */
const shortText = (
  u8: Uint8Array,
  start: number,
  end: number,
): string | undefined => {
  let k = 0;
  for (let i = start; i < end; ) {
    const c = u8[i] as number;
    if (c < 0x80) {
      shortUnits[k++] = c;
      i++;
      continue;
    }
    let cp: number;
    let n: number;
    if (c >= 0xc2 && c < 0xe0) {
      cp = c & 0x1f;
      n = 1;
    } else if (c >= 0xe0 && c < 0xf0) {
      cp = c & 0x0f;
      n = 2;
    } else if (c >= 0xf0 && c < 0xf5) {
      cp = c & 0x07;
      n = 3;
    } else {
      return undefined;
    }
    if (i + n >= end) return undefined;
    for (let j = 1; j <= n; j++) {
      const d = u8[i + j] as number;
      if ((d & 0xc0) !== 0x80) return undefined;
      cp = (cp << 6) | (d & 0x3f);
    }
    if (
      (n === 2 && (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000))) ||
      (n === 3 && (cp < 0x10000 || cp > 0x10ffff))
    ) {
      return undefined;
    }
    if (cp < 0x10000) {
      shortUnits[k++] = cp;
    } else {
      shortUnits[k++] = 0xd7c0 + (cp >> 10);
      shortUnits[k++] = 0xdc00 | (cp & 0x3ff);
    }
    i += n + 1;
  }
  return String.fromCharCode.apply(
    null,
    shortUnits.subarray(0, k) as unknown as number[],
  );
};
```

and in `decodeRows`, the text branch

```ts
            ? utf8Decoder.decode(u8.subarray(start, start + len))
```

becomes

```ts
            ? ((len <= SHORT_TEXT ? shortText(u8, start, start + len) : undefined) ??
              utf8Decoder.decode(u8.subarray(start, start + len)))
```

(Keep the ternary: `len <= SHORT_TEXT && …` would give `false`, which `??` does not replace.) A 32-byte text yields at most 32 UTF-16 units, so `shortUnits` never overflows.

- [ ] **Step 3: Run the unit tests**

Run: `pnpm exec rstest --project unit run`
Expected: PASS, including Step 1's tests unchanged.

- [ ] **Step 4: Browser parity of short and invalid texts**

Append to the `describe('result rows', …)` in `tests/browser/results.test.ts`:

```ts
  it('decodes short, long and invalid texts as before', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE e (id INTEGER PRIMARY KEY, v TEXT)');
    const texts: string[] = [];
    for (let n = 1; n <= 40; n++) texts.push('a'.repeat(n), 'é'.repeat(n), '😀'.repeat(Math.ceil(n / 4)));
    for (const t of texts) await db.write('INSERT INTO e (v) VALUES (?)', [t]);
    const invalid = ['ff', 'c0af', 'e0808f', 'eda080', 'f4908080', 'f0', 'e282', 'c3', '41c3', 'c341'];
    const reference = new TextDecoder('utf-8', { ignoreBOM: true });
    const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
    const expectedInvalid: string[] = [];
    for (const h of invalid) {
      for (const pad of ['', '61'.repeat(40)]) {
        await db.write(`INSERT INTO e (v) VALUES (CAST(x'${pad}${h}' AS TEXT))`);
        expectedInvalid.push(reference.decode(hexBytes(pad + h)));
      }
    }
    const rows = await db.read<{ v: string }>('SELECT v FROM e ORDER BY id');
    expect(rows.map((r) => r.v)).toEqual([...texts, ...expectedInvalid]);
    await db.close();
  });
```

Run it on both engines:
`pnpm exec rstest --project 'chromium*' run tests/browser/results.test.ts` and `pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/results.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec biome check --write src/binary.ts tests/unit/binary.test.ts tests/browser/results.test.ts
pnpm exec tsc --noEmit
pnpm test
test "$(git branch --show-current)" = feat/binary-results && git add src/binary.ts tests/unit/binary.test.ts tests/browser/results.test.ts && git commit -m "perf(binary): decode short texts in JS on the page

On Chromium a string TextDecoder returns on the page is an external
string holding ~150-190 bytes more than a cloned one; a 500 000-row
read() retained 430 MB against 354 before the binary protocol. Texts
up to 32 bytes of valid UTF-8 are now decoded in JS (237 MB, same
speed); anything else still goes through TextDecoder, so replacement
characters are unchanged.

Co-Authored-By: <your model line>"
```

`pnpm test`: three reports, `status: pass` and `failedFiles: 0` in each.
