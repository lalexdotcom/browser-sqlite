import { beforeAll } from 'vitest';

/**
 * The isolated projects' precondition (spec § 3): a project that declares
 * itself isolated and is not would run every `requires:interruptible` test
 * of a `sync` pair against a build that cannot cut a step. Not a test of the
 * library — it fails the file, by name, before any of its tests.
 */
beforeAll(async () => {
  if (
    globalThis.crossOriginIsolated !== true ||
    typeof SharedArrayBuffer !== 'function'
  ) {
    throw new Error(
      'ISOLATION_MISSING: this isolated project is not cross-origin isolated (COOP/COEP headers, vitest.config.ts)',
    );
  }
  const worker = new Worker(
    URL.createObjectURL(
      new Blob(
        [
          `self.onmessage = (e) => { const v = new Int32Array(e.data);
             Atomics.store(v, 0, 7); self.postMessage(Atomics.load(v, 0)); };`,
        ],
        { type: 'application/javascript' },
      ),
    ),
  );
  try {
    const seen = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = (e) => reject(e);
      worker.postMessage(new SharedArrayBuffer(8));
    });
    if (seen !== 7) {
      throw new Error(
        `ISOLATION_MISSING: a SharedArrayBuffer did not reach a worker (read ${String(seen)})`,
      );
    }
  } finally {
    worker.terminate();
  }
});
