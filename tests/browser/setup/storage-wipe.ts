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

afterAll(async () => {
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
  if (problems.length > 0 || left.length > 0) {
    throw new Error(
      `This file left storage behind that could not be wiped: ${[...new Set([...problems, ...left])].join('; ')}`,
    );
  }
  // Raw 60 s failed a file on Windows Firefox (2026-11-04, run 41875605671),
  // where each OPFS removal pays fsyncs.
}, 60_000 * TIME_SCALE);
