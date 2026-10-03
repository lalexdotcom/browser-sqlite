import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createTestClient, sleep } from './helpers';

/**
 * `createVfsInstance` retries `create()` in the same worker while the VFS's
 * files are held elsewhere, so a failed attempt must keep nothing: a handle it
 * kept would refuse every later attempt of that worker.
 *
 * One VFS, named on purpose: `AccessHandlePoolVFS` is the one that acquires
 * its files at creation, and its pool is a directory named after it.
 */
const VFS = 'AccessHandlePoolVFS';
/** Between the attempt seen and the release, so that attempt has failed. */
const GRACE_MS = 30;
/** No attempt seen: release anyway rather than hang the test. */
const WITNESS_TIMEOUT_MS = 3_000;
const WITNESS_POLL_MS = 5;
/** How long to wait out the handles of the client just closed. */
const SETTLE_BUDGET_MS = 3_000;

/**
 * Takes, probes and releases exclusive OPFS access handles. A dedicated
 * worker, because `createSyncAccessHandle` is worker-only.
 */
const handleWorker = () => {
  const src = `
    const held = new Map();
    const fileAt = async (path) => {
      const segments = path.split('/');
      const name = segments.pop();
      let dir = await navigator.storage.getDirectory();
      for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
      return dir.getFileHandle(name);
    };
    self.onmessage = async ({ data: { id, type, path, budgetMs } }) => {
      const answer = (value) => self.postMessage({ id, value });
      try {
        if (type === 'release') {
          held.get(path)?.close();
          held.delete(path);
          return answer('released');
        }
        const deadline = Date.now() + budgetMs;
        for (;;) {
          try {
            const handle = await (await fileAt(path)).createSyncAccessHandle();
            if (type === 'take') held.set(path, handle);
            else handle.close();
            return answer(type === 'take' ? 'taken' : 'free');
          } catch (e) {
            if (e.name !== 'NoModificationAllowedError') throw e;
            if (Date.now() >= deadline) return answer('held');
            await new Promise((r) => setTimeout(r, 25));
          }
        }
      } catch (e) {
        answer('failed: ' + e.name);
      }
    };
  `;
  const url = URL.createObjectURL(
    new Blob([src], { type: 'application/javascript' }),
  );
  const worker = new Worker(url);
  const pending = new Map<number, (value: string) => void>();
  worker.onmessage = (e: MessageEvent<{ id: number; value: string }>) => {
    pending.get(e.data.id)?.(e.data.value);
    pending.delete(e.data.id);
  };
  let next = 0;
  const ask = (type: string, path: string, budgetMs = 0) =>
    new Promise<string>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      worker.postMessage({ id, type, path, budgetMs });
    });
  return {
    /** `taken`, or `held` once the budget is spent. */
    take: (path: string, budgetMs: number) => ask('take', path, budgetMs),
    /** `free` or `held`, the handle closed at once where it was granted. */
    probe: (path: string, budgetMs = 0) => ask('probe', path, budgetMs),
    release: (path: string) => ask('release', path),
    dispose: () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
};

/** The pool's files, by path. */
const poolFiles = async (): Promise<string[]> => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(VFS);
  const paths: string[] = [];
  // `any`: the DOM lib lacks the directory's async iterators.
  for await (const name of (dir as any).keys()) paths.push(`${VFS}/${name}`);
  return paths.sort();
};

describe('creating a VFS whose files are partly held', () => {
  // Falsifiable: revert rhashimoto/wa-sqlite#368 in the vendored wa-sqlite
  // with a `pnpm patch` of AccessHandlePoolVFS.js — the first attempt keeps what
  // it acquired beside the held file, and the open fails once the 10 s are spent.
  it('opens once the held file is let go', async () => {
    // A first client, so the pool exists before anything holds one of its files.
    const creator = await createTestClient({ vfs: VFS });
    await creator.write('CREATE TABLE t (a)');
    await creator.close();

    const [heldFile, witness] = (await poolFiles()) as [string, string];
    const holder = handleWorker();
    onTestFinished(() => holder.dispose());
    expect(await holder.take(heldFile, SETTLE_BUDGET_MS)).toBe('taken');
    expect(await holder.probe(witness, SETTLE_BUDGET_MS)).toBe('free');

    const db = await createTestClient({ vfs: VFS });
    const read = db.read<{ n: number }>('SELECT 1 AS n');
    // Awaited only after the release; a failure before then is still reported.
    read.catch(() => {});

    // An attempt takes the pool's other files while it fails on the held one,
    // so the witness held is that attempt seen.
    const giveUp = performance.now() + WITNESS_TIMEOUT_MS;
    while (
      (await holder.probe(witness)) === 'free' &&
      performance.now() < giveUp
    ) {
      await sleep(WITNESS_POLL_MS);
    }
    await sleep(GRACE_MS);
    await holder.release(heldFile);

    expect((await read)[0]?.n).toBe(1);
    // Closed here: an open client holds the whole pool, and the first
    // client's cleanup deletes through it.
    await db.close();
  });
});
