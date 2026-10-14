import type { SQLiteBuild } from 'browser-sqlite';
import { createSQLiteClient, deleteDatabase } from 'browser-sqlite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { TEST_TARGET } from '../helpers';

// The directory the worker resolves its `.wasm` from by default: the build
// under test, served beside this file's `tests/` parent. The positive tests
// pass with or without the option, so the negative ones are what prove the
// worker reads it. Vite rewrites `new URL(…, import.meta.url)` and drops the
// trailing slash, so it is put back.
const WASM_DIR = new URL('../../build/worker/', import.meta.url).href.replace(
  /\/?$/,
  '/',
);
const WASM_FILE: Record<SQLiteBuild, string> = {
  sync: 'wa-sqlite.wasm',
  async: 'wa-sqlite-async.wasm',
  jspi: 'wa-sqlite-jspi.wasm',
};

const open = (wasmUrl: string | ((build: SQLiteBuild) => string)) => {
  const { vfs, build } = TEST_TARGET;
  const name = `bsq-test-${crypto.randomUUID()}`;
  const db = createSQLiteClient(name, { vfs, build, wasmUrl });
  onTestFinished(async () => {
    await db.close().catch(() => {});
    await deleteDatabase(name, { vfs, build }).catch(() => {});
  });
  return db;
};

describe('the wasmUrl option', () => {
  it('takes a callback, called once with the build, and serves a query', async () => {
    const wasmUrl = vi.fn((build: SQLiteBuild) => WASM_DIR + WASM_FILE[build]);
    const db = open(wasmUrl);
    const rows = await db.read<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
    expect(wasmUrl).toHaveBeenCalledTimes(1);
    expect(wasmUrl).toHaveBeenCalledWith(TEST_TARGET.build);
  });

  it('takes a string and serves a query', async () => {
    const db = open(WASM_DIR);
    const rows = await db.read<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  });

  // Falsifiable: drop `wasm` from the worker's open handler (worker.ts), and
  // the worker loads its default `.wasm` and serves the query.
  it('is what the worker loads: a callback naming no file fails the client', async () => {
    const db = open((build) => `${WASM_DIR}missing/${WASM_FILE[build]}`);
    await expect(db.read('SELECT 1')).rejects.toThrow();
  });

  // Falsifiable: as above.
  it('is what the worker loads: a string naming no directory fails the client', async () => {
    const db = open(`${WASM_DIR}missing/`);
    await expect(db.read('SELECT 1')).rejects.toThrow();
  });
});
