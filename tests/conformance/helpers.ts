import { afterEach, expect } from '@rstest/core';
import { detectFeatures } from '../../src/capabilities';
import { createSQLiteClient, type WorkerLostEvent } from '../../src/client';
import {
  BUILD_REQUIREMENTS,
  defaultBuildFor,
  type PlatformFeature,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';

/** Every wired VFS, in declaration order. */
export const ALL_VFS = Object.keys(VFS_CAPABILITIES) as SQLiteVFS[];

/**
 * Probes for `mode: 'readwrite-unsafe'` OPFS access handle support by
 * attempting to open two handles on the same file. createSyncAccessHandle is
 * only available in dedicated workers, so we spawn an inline blob worker and
 * relay the result back. Returns false for any error — missing OPFS, denied
 * permissions, or a browser that ignores the mode and enforces exclusive
 * locking (which blocks the second open).
 */
/**
 * One attempt. Resolves `'wedged'` rather than an answer when the worker does
 * not report inside `PROBE_BOUND_MS` — see `probeUnsafeHandles` for why that
 * case exists at all.
 */
function probeOnce(attempt: number): Promise<boolean | 'wedged'> {
  return new Promise<boolean | 'wedged'>((resolve) => {
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
          self.close();
        }
      };
    `;
    const blob = new Blob([src], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    // The worker ends itself with `self.close()` once it has removed the probe
    // file; terminating it here on the answer would race that cleanup and win
    // often enough to leave `__probe_unsafe_handles` in the OPFS root (4 of 6
    // Chromium loads, measured on the bench page's copy of this probe — see
    // BENCH-DRIFT in mem:follow-ups). `onerror` means no cleanup will run.
    const bound = setTimeout(() => {
      // The worker is wedged, not slow: terminate it so it cannot hold an OPFS
      // entry, and let the caller start a fresh one.
      worker.terminate();
      URL.revokeObjectURL(url);
      console.error(
        `[conformance] readwrite-unsafe probe attempt ${attempt} did not report in ${PROBE_BOUND_MS} ms — see the Firefox getDirectory() hang in mem:follow-ups`,
      );
      resolve('wedged');
    }, PROBE_BOUND_MS);
    worker.onmessage = (e: MessageEvent<boolean>) => {
      clearTimeout(bound);
      resolve(e.data);
      URL.revokeObjectURL(url);
    };
    worker.onerror = () => {
      clearTimeout(bound);
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
/** How long one attempt gets before its worker is written off as wedged. */
const PROBE_BOUND_MS = 10_000;
/** How many workers get to try before the suite gives up and says so. */
const PROBE_ATTEMPTS = 3;

/**
 * The answer, or a thrown error — never a guess.
 *
 * This runs at module scope behind a TOP-LEVEL AWAIT, in every browser test
 * file's page, and rstest runs those files in parallel pages. On Firefox,
 * `await navigator.storage.getDirectory()` inside the worker below sometimes
 * NEVER SETTLES under that concurrency — no resolve, no reject (established
 * 2026-09-16, `mem:follow-ups`). An unbounded probe therefore hangs its page
 * before any test starts, where neither `testTimeout` nor `hookTimeout` can
 * fire: the file stays "running" for ever and the whole run never ends. Four
 * sightings, and `pnpm test` bounds nothing on its own.
 *
 * So each attempt is bounded and a wedged worker is terminated and replaced.
 * It THROWS rather than answering false after the last attempt, because false
 * is a real answer here — Firefox's and Safari's — and a silent false on
 * Chromium would flip `readwrite-unsafe` for the whole run and make tests pass
 * for the wrong reason.
 */
async function probeUnsafeHandles(): Promise<boolean> {
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    const answer = await probeOnce(attempt);
    if (answer !== 'wedged') return answer;
  }
  throw new Error(
    `readwrite-unsafe probe: ${PROBE_ATTEMPTS} workers in a row failed to report within ${PROBE_BOUND_MS} ms each. On Firefox this is navigator.storage.getDirectory() never settling inside a worker (mem:follow-ups). The suite refuses to guess the answer.`,
  );
}

export const HAS_UNSAFE_HANDLES = await probeUnsafeHandles();

/**
 * Every platform feature this engine has. The probeable ones come from the
 * shipped guard, so a feature added to `PlatformFeature` is answered here with
 * no edit in this file; `readwrite-unsafe` has no synchronous probe — which is
 * why `detectFeatures` cannot report it — and comes from the async probe above.
 */
export const AVAILABLE_FEATURES: ReadonlySet<PlatformFeature> = new Set([
  ...detectFeatures(),
  ...(HAS_UNSAFE_HANDLES ? (['readwrite-unsafe'] as const) : []),
]);

/**
 * The first feature this (vfs, build) pair needs and this engine lacks, or
 * null when the pair can run. Both requirement lists are read from the tables
 * rather than restated here, so a feature added to a VFS's `requires` or to
 * `BUILD_REQUIREMENTS` is honoured with no edit in this file — which is how
 * `writable-stream` was missed once already.
 *
 * Returned by name, not as a boolean, so the skip message states the reason it
 * actually found instead of restating the only one anybody remembered.
 *
 * A VFS that merely *degrades* without a feature — `OPFSAdaptiveVFS` — does not
 * appear in `requires` and must still be exercised here.
 */
export const missingHere = (
  vfs: SQLiteVFS,
  build: SQLiteBuild = defaultBuildFor(vfs),
): PlatformFeature | null =>
  // The widening casts mirror client.ts's build guard: `as const` on the tables
  // narrows an empty requirement list to `readonly []`, where `.find` takes never.
  [
    ...(VFS_CAPABILITIES[vfs].requires as readonly PlatformFeature[]),
    ...(BUILD_REQUIREMENTS[build] as readonly PlatformFeature[]),
  ].find((feature) => !AVAILABLE_FEATURES.has(feature)) ?? null;

/** The VFS's declared pool cap when it has one, or 2 when the pool is unbounded. */
export const poolFor = (vfs: SQLiteVFS): number =>
  VFS_CAPABILITIES[vfs].maxPoolSize ?? 2;

/**
 * True when this VFS runs a single worker in this browser — declared
 * (`maxPoolSize: 1`) or because it lacks a `singleConnectionWithout` feature
 * here (spec 2026-09-13, §10). An invariant about two workers is skipped
 * there, never "passed" on one.
 */
export const oneWorkerHere = (vfs: SQLiteVFS): boolean =>
  VFS_CAPABILITIES[vfs].maxPoolSize === 1 ||
  VFS_CAPABILITIES[vfs].singleConnectionWithout.some(
    (feature) => !AVAILABLE_FEATURES.has(feature),
  );

/**
 * Every worker a conformance client lost, as `"<vfs> slot <index>: <message>"`.
 * A conformance pass with a lost worker is not a pass: on 2026-08-27 Firefox
 * "passed" OPFSWriteAheadVFS at poolSize 2 and 4 on ONE live worker, because
 * nothing here counted them (spec 2026-09-13). Drained by `expectNoWorkerLost`.
 */
const workerLosses: string[] = [];
const recordLoss =
  (vfs: SQLiteVFS) =>
  ({ index, cause }: WorkerLostEvent) => {
    workerLosses.push(`${vfs} slot ${index}: ${cause.message}`);
  };

/** Register with `afterEach` at the top level of every conformance file. */
export const expectNoWorkerLost = () => {
  expect(workerLosses.splice(0)).toEqual([]);
};

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

  return {
    file,
    db: createSQLiteClient(file, {
      vfs,
      build,
      poolSize,
      onWorkerLost: recordLoss(vfs),
    }),
  };
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
    onWorkerLost: recordLoss(vfs),
  });
