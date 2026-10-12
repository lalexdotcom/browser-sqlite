import { createSQLiteClient, deleteDatabase } from 'browser-sqlite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { TEST_TARGET } from './helpers';

// The directory the worker resolves its `.wasm` from by default: the build
// under test, served beside this file's `tests/` parent.
const WASM_DIR = new URL('../build/worker/', import.meta.url).href;

describe('the wasmUrl option', () => {
  // Falsifiable: drop `wasm` from the open message in client.ts.
  it('takes a callback, called once with the build, and serves a query', async () => {
    const { vfs, build } = TEST_TARGET;
    const name = `bsq-test-${crypto.randomUUID()}`;
    const wasmUrl = vi.fn(() => WASM_DIR);
    const db = createSQLiteClient(name, { vfs, build, wasmUrl });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(name, { vfs, build }).catch(() => {});
    });
    const rows = await db.read<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
    expect(wasmUrl).toHaveBeenCalledTimes(1);
    expect(wasmUrl).toHaveBeenCalledWith(build);
  });

  it('takes a string and serves a query', async () => {
    const { vfs, build } = TEST_TARGET;
    const name = `bsq-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(name, { vfs, build, wasmUrl: WASM_DIR });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(name, { vfs, build }).catch(() => {});
    });
    const rows = await db.read<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  });
});
