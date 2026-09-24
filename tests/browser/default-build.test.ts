import { describe, expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { BUILD_CAPABILITIES, type SQLiteBuild } from '../../src/const/builds';
import { VFS_CAPABILITIES } from '../../src/const/vfs';
import { deleteDatabase } from '../../src/delete';
import { pairFor } from './helpers';

type WithSuspending = typeof WebAssembly & { Suspending?: unknown };

describe('the default build without JSPI', () => {
  // Falsifiable: make defaultBuildFor return `builds[0]` whatever `available`
  // says — on a jspi-first VFS the client then refuses the pair, JSPI missing.
  it('falls back to the first declared build that requires nothing', async () => {
    const wasm = WebAssembly as WithSuspending;
    // The premise: both engines under test have JSPI to take away.
    expect(typeof wasm.Suspending).toBe('function');

    const { vfs } = pairFor();
    const expected = (
      VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]
    ).find((build) => BUILD_CAPABILITIES[build].requires.length === 0);
    const file = `bsq-test-${crypto.randomUUID()}`;
    const saved = wasm.Suspending;
    delete wasm.Suspending;
    try {
      const db = createSQLiteClient(file, { vfs });
      try {
        expect(db.build).toBe(expected);
        expect(await db.read<{ one: number }>('SELECT 1 AS one')).toEqual([
          { one: 1 },
        ]);
      } finally {
        await db.close();
      }
      // No `build` here either: deleteDatabase resolves on its own.
      await deleteDatabase(file, { vfs });
    } finally {
      wasm.Suspending = saved;
    }
  });

  // Falsifiable: resolve before reading `clientOptions.build`, or drop the
  // `??` — the engine has JSPI, so the explicit `async` would be overridden.
  it('keeps an explicit build where the engine could run a preferred one', async () => {
    const { vfs } = pairFor();
    const file = `bsq-test-${crypto.randomUUID()}`;
    const db = createSQLiteClient(file, { vfs, build: 'async' });
    try {
      expect(db.build).toBe('async');
      await db.read('SELECT 1');
    } finally {
      await db.close();
    }
    await deleteDatabase(file, { vfs, build: 'async' });
  });
});
