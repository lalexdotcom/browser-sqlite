import type { SQLiteBuild } from '../../src/const/builds';
import type { SQLiteVFS } from '../../src/const/vfs';

/**
 * A (vfs, build) pair the browser suite runs on. Each browser project injects
 * one, and a test follows it (spec 2026-09-15, A5): `TEST_TARGET` in
 * `helpers.ts`.
 */
export type TestTarget = {
  readonly vfs: SQLiteVFS;
  readonly build: SQLiteBuild;
};
