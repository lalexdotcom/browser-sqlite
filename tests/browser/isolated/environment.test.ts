import { describe, expect, it } from '@rstest/core';

describe('the isolated project', () => {
  it('really is cross-origin isolated', () => {
    expect(globalThis.crossOriginIsolated).toBe(true);
    expect(typeof SharedArrayBuffer).toBe('function');
  });

  it('can hand a SharedArrayBuffer to a worker', async () => {
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
    const seen = await new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage(new SharedArrayBuffer(8));
    });
    worker.terminate();
    expect(seen).toBe(7);
  });
});
