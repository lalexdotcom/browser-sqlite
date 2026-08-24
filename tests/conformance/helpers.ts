import { afterEach } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import {
  defaultBuildFor,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';

/** Every wired VFS, in declaration order. */
export const ALL_VFS = Object.keys(VFS_CAPABILITIES) as SQLiteVFS[];

/**
 * JSPI is Chromium 126+. Feature-detected rather than sniffed from the user
 * agent, so a browser that gains it later is picked up with no edit here.
 */
export const HAS_JSPI =
  typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function';

/** The largest pool a VFS allows, capped at 2 so scenarios stay comparable. */
export const poolFor = (vfs: SQLiteVFS): number =>
  VFS_CAPABILITIES[vfs].maxPoolSize ?? 2;

/**
 * A client on a unique database, registered for cleanup. Unique names keep
 * scenarios independent; OPFS entries are removed afterwards, and the memory
 * VFS have nothing to remove.
 */
export const conformanceClient = (
  vfs: SQLiteVFS,
  build: SQLiteBuild = defaultBuildFor(vfs),
  poolSize: number = poolFor(vfs),
) => {
  const file = `conformance-${crypto.randomUUID()}`;

  afterEach(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(file, { recursive: true });
    } catch {
      // Never created, or this VFS does not use OPFS at all.
    }
  });

  return { file, db: createSQLiteClient(file, { vfs, build, poolSize }) };
};
