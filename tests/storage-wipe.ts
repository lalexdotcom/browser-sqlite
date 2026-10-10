import { afterAll } from 'vitest';

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

/** A worker that just closed releases its handles a moment later. */
const SETTLE_MS = 3_000;
const RETRY_MS = 50;
const IDB_DELETE_MS = 5_000;

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

async function wipeIndexedDb(problems: string[]): Promise<void> {
  for (const { name } of await indexedDB.databases()) {
    if (name === undefined) continue;
    const problem = await deleteIndexedDb(name);
    if (problem !== undefined) problems.push(problem);
  }
}

afterAll(async () => {
  const problems: string[] = [];
  await removeOpfsEntries(problems, Date.now() + SETTLE_MS);
  await wipeIndexedDb(problems);

  // Verified, not assumed: whatever the removals did not take is a leak.
  const root = await navigator.storage.getDirectory();
  const left: string[] = [];
  for await (const name of root.keys()) left.push(`OPFS "${name}"`);
  for (const { name } of await indexedDB.databases()) {
    left.push(`IndexedDB "${name}"`);
  }
  if (problems.length > 0 || left.length > 0) {
    throw new Error(
      `This file left storage behind that could not be wiped: ${[...new Set([...problems, ...left])].join('; ')}`,
    );
  }
}, 60_000);
