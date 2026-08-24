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

/**
 * Probes for `mode: 'readwrite-unsafe'` OPFS access handle support by
 * attempting to open two handles on the same file. createSyncAccessHandle is
 * only available in dedicated workers, so we spawn an inline blob worker and
 * relay the result back. Returns false for any error — missing OPFS, denied
 * permissions, or a browser that ignores the mode and enforces exclusive
 * locking (which blocks the second open).
 */
async function probeUnsafeHandles(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const src = `
      self.onmessage = async () => {
        let h1;
        try {
          const root = await navigator.storage.getDirectory();
          const fh = await root.getFileHandle('__probe_unsafe_handles', { create: true });
          h1 = await fh.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
          const h2 = await fh.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
          h2.close();
          self.postMessage(true);
        } catch {
          self.postMessage(false);
        } finally {
          try { h1?.close(); } catch {}
          try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry('__probe_unsafe_handles');
          } catch {}
        }
      };
    `;
    const blob = new Blob([src], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker.onmessage = (e: MessageEvent<boolean>) => {
      resolve(e.data);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.onerror = () => {
      resolve(false);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.postMessage(null);
  });
}

/**
 * True when the browser supports `mode: 'readwrite-unsafe'` for OPFS sync
 * access handles — verified by opening two handles on the same file, which
 * only succeeds when the mode is genuinely honoured. False on Firefox and any
 * engine that silently ignores the mode (exclusive lock prevents the second
 * open). Resolved once at module load via top-level await so the skip
 * decision can be made synchronously at test-declaration time.
 */
export const HAS_UNSAFE_HANDLES = await probeUnsafeHandles();

/** The VFS's declared pool cap when it has one, or 2 when the pool is unbounded. */
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

/**
 * A second client on an existing database file, for the close-and-reopen
 * invariant. It deliberately registers no cleanup: the first client already
 * did, on the same name.
 */
export const createReopened = (file: string, vfs: SQLiteVFS) =>
  createSQLiteClient(file, {
    vfs,
    build: defaultBuildFor(vfs),
    poolSize: poolFor(vfs),
  });
