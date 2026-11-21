import { afterAll, beforeAll, inject } from 'vitest';

/**
 * Registered as a setup file by every browser project: after each test file's
 * own cleanups, wipe what the file left in the origin's storage, then verify
 * it. The files of a run share one browser profile, so a database a file
 * leaves behind (an `AccessHandlePoolVFS` slot, an IndexedDB database) would
 * break the files after it. What can be removed is erased without a failure;
 * what cannot (a handle still held, a connection still open) fails this file,
 * by name.
 *
 * Hooks registered first run last under Vitest's default `stack` order, so
 * this one follows every `afterAll` the file registers.
 */

/** `BSQ_TIME_SCALE`: every bound below follows it, as the tests' own do. */
const TIME_SCALE = inject('bsqTimeScale') ?? 1;
/** A worker that just closed releases its handles a moment later. */
const SETTLE_MS = 3_000 * TIME_SCALE;
const RETRY_MS = 50;
const IDB_DELETE_MS = 5_000 * TIME_SCALE;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The replies after which a worker holds no IndexedDB transaction: its VFS is
 * closed (`closed`, `quiesced`), or the delete worker is done (`deleted`,
 * `not-found`). The library waits for one of them before it terminates a
 * worker, unless the worker cannot answer.
 */
const SETTLED = new Set(['closed', 'quiesced', 'deleted', 'not-found']);

/** Workers this file terminated before they gave one of those replies. */
let unanswered = 0;

/**
 * Counts the workers terminated unanswered. Installed before the file's own
 * modules load, so the pool, `interceptWorkers` and `killSilently` all reach
 * this terminate().
 */
const EngineWorker = globalThis.Worker;
class WatchedWorker extends EngineWorker {
  #settled = false;
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.addEventListener('message', (event: MessageEvent) => {
      const type = (event.data as { type?: unknown } | null)?.type;
      if (typeof type === 'string' && SETTLED.has(type)) this.#settled = true;
    });
  }
  override terminate(): void {
    if (!this.#settled) unanswered += 1;
    super.terminate();
  }
}
globalThis.Worker = WatchedWorker;

/**
 * Safari keeps the IndexedDB connection of a worker terminated with a
 * transaction live, for the life of the process (WebKit 324094). The library
 * terminates a worker that cannot answer — stalled past `drainTimeout`, then
 * past its quiesce grace — and a test may kill one on purpose: the database
 * then cannot be deleted, with every behaviour of the library as intended.
 * On Safari, after such a termination, an IndexedDB database still open is
 * reported with this reason instead of failing the file. A database left
 * open by a worker that did answer still fails it, on every engine: that is
 * a close path keeping a transaction, the defect this wipe exists to catch.
 */
const ENGINE_KEEPS_KILLED_CONNECTIONS =
  inject('bsqEnvironment')?.browser === 'safari';

const STILL_OPEN = /^IndexedDB "(.*)" \(still open after/;

/** The file's meta key the merged report reads (scripts/skip-notes.ts). */
const STORAGE_NOTE = 'bsqStorageNote';

const describeError = (error: unknown) =>
  error instanceof DOMException
    ? `${error.name}: ${error.message}`
    : String(error);

async function removeOpfsEntries(
  problems: string[],
  deadline: number,
): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for (;;) {
    const names: string[] = [];
    for await (const name of root.keys()) names.push(name);
    if (names.length === 0) return;
    const held: string[] = [];
    for (const name of names) {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch (error) {
        held.push(`OPFS "${name}" (${describeError(error)})`);
      }
    }
    // Checked on every pass, so entries something keeps recreating end the
    // loop at the deadline too: the next listing is the evidence.
    if (Date.now() >= deadline) {
      if (held.length > 0) problems.push(...held);
      return;
    }
    if (held.length > 0) await sleep(RETRY_MS);
  }
}

function deleteIndexedDb(name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () =>
        resolve(`IndexedDB "${name}" (still open after ${IDB_DELETE_MS} ms)`),
      IDB_DELETE_MS,
    );
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    request.onerror = () => {
      clearTimeout(timer);
      resolve(`IndexedDB "${name}" (${describeError(request.error)})`);
    };
  });
}

async function wipeIndexedDb(
  problems: string[],
  inherited: ReadonlySet<string>,
): Promise<void> {
  for (const { name } of await indexedDB.databases()) {
    if (name === undefined) continue;
    const problem = await deleteIndexedDb(name);
    // An earlier file left it and failed for it; this file is not charged.
    if (problem !== undefined && !inherited.has(name)) problems.push(problem);
  }
}

/**
 * The IndexedDB databases present before this file ran. The wipe after every
 * file deletes them all, so one still present here is one an earlier file's
 * wipe could not delete — and that file already failed for it. Safari keeps
 * a connection open for the life of its process once a worker ended with a
 * transaction live (WebKit 324094): failing every later file for the same
 * database turned one fault into a whole red cell, its tests all green
 * (2026-11-18, 64 files after `backpressure`).
 */
const inherited = new Set<string>();

beforeAll(async () => {
  for (const { name } of await indexedDB.databases()) {
    if (name !== undefined) inherited.add(name);
  }
});

// Vitest parses the first argument for fixtures: it must be a destructuring
// pattern, even an empty one.
// biome-ignore lint/correctness/noEmptyPattern: required by Vitest, see above
afterAll(async ({}, file) => {
  const problems: string[] = [];
  await removeOpfsEntries(problems, Date.now() + SETTLE_MS);
  await wipeIndexedDb(problems, inherited);

  // Verified, not assumed: whatever the removals did not take is a leak.
  const root = await navigator.storage.getDirectory();
  const left: string[] = [];
  for await (const name of root.keys()) left.push(`OPFS "${name}"`);
  for (const { name } of await indexedDB.databases()) {
    if (name !== undefined && inherited.has(name)) continue;
    left.push(`IndexedDB "${name}"`);
  }

  // WebKit 324094's signature: a database still open, on Safari, after a
  // worker was terminated unanswered. Reported, not failed (see above).
  const stranded = new Set(
    problems.flatMap((problem) => STILL_OPEN.exec(problem)?.[1] ?? []),
  );
  if (ENGINE_KEEPS_KILLED_CONNECTIONS && unanswered > 0 && stranded.size > 0) {
    const excused = (entry: string) =>
      [...stranded].some((name) => entry.startsWith(`IndexedDB "${name}"`));
    const names = [...stranded].map((name) => `"${name}"`).join(', ');
    (file.meta as Record<string, unknown>)[STORAGE_NOTE] =
      `IndexedDB ${names} still open after ${unanswered} worker(s) terminated unanswered: Safari keeps such a connection (WebKit 324094)`;
    problems.splice(0, problems.length, ...problems.filter((p) => !excused(p)));
    left.splice(0, left.length, ...left.filter((l) => !excused(l)));
  }

  if (problems.length > 0 || left.length > 0) {
    throw new Error(
      `This file left storage behind that could not be wiped: ${[...new Set([...problems, ...left])].join('; ')}`,
    );
  }
  // Raw 60 s failed a file on Windows Firefox (2026-11-04, run 41875605671),
  // where each OPFS removal pays fsyncs.
}, 60_000 * TIME_SCALE);
