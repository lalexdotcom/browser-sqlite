import { describe, expect, it, vi } from 'vitest';
import { createSQLiteClient } from '../../src/client';
import { SQLiteError } from '../../src/types/errors';

// Node has neither OPFS nor `location`: an option guard that throws here ran
// before both the environment guard and the `.wasm` URL resolution.
describe('createSQLiteClient validates its options before the environment', () => {
  // Falsifiable: move assertPragmasAllowed back after missingFeature.
  it('refuses a pragma the VFS refuses before reporting a missing OPFS', () => {
    let caught: unknown;
    try {
      createSQLiteClient(`bsq-test-${crypto.randomUUID()}`, {
        vfs: 'OPFSCoopSyncVFS',
        pragmas: { busy_timeout: '100' },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SQLiteError);
    expect((caught as SQLiteError).code).toBe('INVALID_PRAGMA');
  });

  // Falsifiable: move resolveWasmLocation back before the pool guard.
  it('does not call wasmUrl when the pool guard throws', () => {
    const wasmUrl = vi.fn(() => 'https://example.test/wasm/');
    expect(() =>
      createSQLiteClient(`bsq-test-${crypto.randomUUID()}`, {
        vfs: 'AccessHandlePoolVFS',
        poolSize: 2,
        wasmUrl,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_OPTION' }));
    expect(wasmUrl).not.toHaveBeenCalled();
  });

  // Falsifiable: move resolveWasmLocation back before missingFeature.
  it('does not call wasmUrl when the environment lacks what the VFS requires', () => {
    const wasmUrl = vi.fn(() => 'https://example.test/wasm/');
    expect(() =>
      createSQLiteClient(`bsq-test-${crypto.randomUUID()}`, {
        vfs: 'OPFSAdaptiveVFS',
        wasmUrl,
      }),
    ).toThrow(/does not support OPFS/);
    expect(wasmUrl).not.toHaveBeenCalled();
  });
});
