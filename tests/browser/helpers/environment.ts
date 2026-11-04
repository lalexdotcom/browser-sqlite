import { detectFeatures } from 'browser-sqlite';
import { inject } from 'vitest';
import { defaultBuildFor } from '../../../src/capabilities';
import {
  BUILD_CAPABILITIES,
  type SQLiteBuild,
} from '../../../src/const/builds';
import type { PlatformFeature } from '../../../src/const/platform';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../../src/const/vfs';

// What this browser can do, probed once per page: shared by every browser
// suite (the pairs, conformance, the planner's probe and the need guard).

/** Every wired VFS, in declaration order. */
export const ALL_VFS = Object.keys(VFS_CAPABILITIES) as SQLiteVFS[];

/**
 * Probes for OPFS sync access handles, then for `mode: 'readwrite-unsafe'`, by
 * attempting to open two handles on the same file. createSyncAccessHandle is
 * only available in dedicated workers, so we spawn an inline blob worker and
 * relay the result back. `sync` is whether the first handle opened, `unsafe`
 * whether the second did too; any error leaves the rest false — missing OPFS,
 * denied permissions, or a browser that ignores the mode and enforces
 * exclusive locking (which blocks the second open).
 */
/**
 * One attempt. Resolves `'wedged'` rather than an answer when the worker
 * started and does not report inside `PROBE_BOUND_MS` — see `probeHandles`
 * for why that case exists at all — and `'unstarted'` when it did not start
 * inside `STARTUP_BOUND_MS`.
 */
/** What the probe worker found: one sync access handle, then a second one. */
type HandleProbe = { readonly sync: boolean; readonly unsafe: boolean };

/** Test seams of one attempt: code the worker runs first, and its bounds. */
type ProbeOptions = {
  readonly prelude?: string;
  readonly startupBoundMs?: number;
  readonly answerBoundMs?: number;
};

export function probeOnce(
  attempt: number,
  {
    prelude = '',
    startupBoundMs = STARTUP_BOUND_MS,
    answerBoundMs = PROBE_BOUND_MS,
  }: ProbeOptions = {},
): Promise<HandleProbe | 'wedged' | 'unstarted'> {
  return new Promise<HandleProbe | 'wedged' | 'unstarted'>((resolve) => {
    const src = `
      ${prelude}
      self.postMessage('up');
      self.onmessage = async () => {
        let h1;
        let sync = false;
        try {
          const root = await navigator.storage.getDirectory();
          const fh = await root.getFileHandle('__probe_unsafe_handles', { create: true });
          h1 = await fh.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
          sync = true;
          const h2 = await fh.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
          h2.close();
          self.postMessage({ sync, unsafe: true });
        } catch {
          self.postMessage({ sync, unsafe: false });
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
    //
    // Two bounds, told apart by the worker's 'up': before it, the worker is
    // starting — slow on a starved runner (a 3-core macOS runner left one
    // silent over 10 s, run 41714043416), and a fresh worker would only start
    // as slowly; after it, the worker has started and only the Firefox
    // getDirectory() hang keeps it from answering.
    let answerBound: ReturnType<typeof setTimeout> | undefined;
    const giveUp = (answer: 'wedged' | 'unstarted', message: string) => {
      // Terminate it so it cannot hold an OPFS entry; the caller decides
      // whether a fresh one is worth starting.
      worker.terminate();
      URL.revokeObjectURL(url);
      console.error(
        `[conformance] readwrite-unsafe probe attempt ${attempt} ${message}`,
      );
      resolve(answer);
    };
    const startupBound = setTimeout(
      () => giveUp('unstarted', `did not start in ${startupBoundMs} ms`),
      startupBoundMs,
    );
    worker.onmessage = (e: MessageEvent<HandleProbe | 'up'>) => {
      if (e.data === 'up') {
        clearTimeout(startupBound);
        answerBound = setTimeout(
          () =>
            giveUp(
              'wedged',
              `did not report in ${answerBoundMs} ms once started — see the Firefox getDirectory() hang in mem:follow-ups`,
            ),
          answerBoundMs,
        );
        worker.postMessage(null);
        return;
      }
      clearTimeout(answerBound);
      resolve(e.data);
      URL.revokeObjectURL(url);
    };
    worker.onerror = () => {
      clearTimeout(startupBound);
      clearTimeout(answerBound);
      resolve({ sync: false, unsafe: false });
      worker.terminate();
      URL.revokeObjectURL(url);
    };
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
/** The run's `BSQ_TIME_SCALE`, read as `tests/browser/helpers/library.ts` reads it. */
const TIME_SCALE = inject('bsqTimeScale') ?? 1;
/** How long a started worker gets to answer before it is written off as wedged. */
const PROBE_BOUND_MS = 10_000 * TIME_SCALE;
/**
 * How long a worker gets to start at all: the library's open timeout
 * (`tests/browser/helpers/library.ts`), the time a client's own worker gets.
 * A worker that has not started by then is a starved machine, which no fresh
 * worker cures: the probe throws instead of trying again.
 */
const STARTUP_BOUND_MS = 30_000 * TIME_SCALE;
/** How many workers get to try before the suite gives up and says so. */
const PROBE_ATTEMPTS = 3;

/**
 * The answer, or a thrown error — never a guess.
 *
 * This runs at module scope behind a TOP-LEVEL AWAIT, in every browser test
 * file's page, and a runner may run those files in parallel pages (rstest did). On Firefox,
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
async function probeHandles(): Promise<HandleProbe> {
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    const answer = await probeOnce(attempt);
    if (answer === 'unstarted') {
      throw new Error(
        `OPFS handle probe: the worker did not start within ${STARTUP_BOUND_MS} ms (the library's open timeout under BSQ_TIME_SCALE). The machine is starved; the probe is not wedged.`,
      );
    }
    if (answer !== 'wedged') return answer;
  }
  throw new Error(
    `OPFS handle probe: ${PROBE_ATTEMPTS} workers in a row started and failed to report within ${PROBE_BOUND_MS} ms each. On Firefox this is navigator.storage.getDirectory() never settling inside a worker (mem:follow-ups). The suite refuses to guess the answer.`,
  );
}

const HANDLES = await probeHandles();

export const HAS_UNSAFE_HANDLES = HANDLES.unsafe;

/**
 * Every platform feature this engine has. The probeable ones come from the
 * shipped guard, so a feature added to `PlatformFeature` is answered here with
 * no edit in this file; `sync-access-handle` and `readwrite-unsafe` have no
 * probe from the page — which is why `detectFeatures` cannot report them — and
 * come from the worker probe above.
 */
export const AVAILABLE_FEATURES: ReadonlySet<PlatformFeature> = new Set([
  ...detectFeatures(),
  ...(HANDLES.sync ? (['sync-access-handle'] as const) : []),
  ...(HANDLES.unsafe ? (['readwrite-unsafe'] as const) : []),
]);

/**
 * The first feature this (vfs, build) pair needs and this engine lacks, or
 * null when the pair can run. Both requirement lists are read from the tables
 * rather than restated here, so a feature added to a VFS's `requires` or to
 * a build's `requires` is honoured with no edit in this file — which is how
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
  build: SQLiteBuild = defaultBuildFor(vfs, AVAILABLE_FEATURES),
): PlatformFeature | null =>
  // The widening casts mirror client.ts's build guard: `as const` on the tables
  // narrows an empty requirement list to `readonly []`, where `.find` takes never.
  [
    ...(VFS_CAPABILITIES[vfs].requires as readonly PlatformFeature[]),
    ...(BUILD_CAPABILITIES[build].requires as readonly PlatformFeature[]),
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
 * Removes one OPFS entry by path, walking its folders. Missing is success. The
 * folders themselves are left: the library never removes them either.
 */
export const removeOpfsPath = async (path: string): Promise<void> => {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) return;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
    await dir.removeEntry(name, { recursive: true });
  } catch {
    // Never created, or this VFS does not use OPFS at all.
  }
};
