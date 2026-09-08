import { describe, expect, it } from '@rstest/core';
import type { Abandoned, AbandonRegistry } from '../../src/abandon';
import { chunk } from '../../src/queries';

/** Records what was watched and forgotten, and can run the cleanup on demand. */
const fakeRegistry = () => {
  const watched: { held: Abandoned; token: object }[] = [];
  const forgotten: object[] = [];
  const registry: AbandonRegistry = {
    watch: (_target, held, token) => {
      watched.push({ held, token });
    },
    forget: (token) => {
      forgotten.push(token);
    },
  };
  return { registry, watched, forgotten };
};

/** A worker that yields `chunks` and records the calls that matter. */
const fakeWorker = (chunks: Record<string, unknown>[][]) => {
  const calls: string[] = [];
  return {
    calls,
    index: 0,
    interrupt: () => {
      calls.push('interrupt');
    },
    quiesce: async () => {},
    query: async function* () {
      calls.push('query');
      try {
        for (const c of chunks) yield c;
      } finally {
        calls.push('transport-finally');
      }
    },
  };
};

describe('chunk() and abandonment', () => {
  it('registers the generator before it is started', () => {
    const { registry, watched } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    chunk(worker as never, 'SELECT 1', undefined, { registry });
    expect(watched).toHaveLength(1);
    // Not started yet, so the cleanup must not interrupt.
    expect(watched[0]?.held.state.started).toBe(false);
  });

  it('marks the query started once the generator runs', async () => {
    const { registry, watched } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const gen = chunk(worker as never, 'SELECT 1', undefined, { registry });
    await gen.next();
    expect(watched[0]?.held.state.started).toBe(true);
  });

  it('forgets the token when the consumer exhausts the generator', async () => {
    const { registry, watched, forgotten } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const gen = chunk(worker as never, 'SELECT 1', undefined, { registry });
    for await (const _rows of gen) {
      // A streaming test must await in its loop body.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(forgotten).toEqual([watched[0]?.token]);
  });

  it('forgets the token when the consumer breaks out', async () => {
    const { registry, watched, forgotten } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }], [{ a: 2 }]]);
    const gen = chunk(worker as never, 'SELECT 1', undefined, { registry });
    for await (const _rows of gen) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      break;
    }
    expect(forgotten).toEqual([watched[0]?.token]);
  });

  it('carries the owner onAbandon into the held value', () => {
    const { registry, watched } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const onAbandon = () => {};
    chunk(worker as never, 'SELECT 1', undefined, { registry, onAbandon });
    expect(watched[0]?.held.release).toBe(onAbandon);
  });

  it('rejects an already-aborted signal on the first next(), not at the call', async () => {
    const { registry } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const reason = new Error('already gone');
    const signal = AbortSignal.abort(reason);
    // The call itself must not throw: D2. Lifting the check into the factory
    // would change this line from "returns a generator" to "throws".
    const gen = chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal,
    });
    await expect(gen.next()).rejects.toBe(reason);
    // And the transport was never asked for anything.
    expect(worker.calls).not.toContain('query');
  });
});

describe('an abort reclaims rather than only rejecting', () => {
  it('runs the cleanup when the signal fires on a suspended generator', async () => {
    const { registry, watched, forgotten } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }], [{ a: 2 }]]);
    const controller = new AbortController();
    const released: string[] = [];
    const gen = chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal: controller.signal,
      onAbandon: () => released.push('released'),
    });
    // Take one chunk, then stop pulling: the generator is suspended at yield.
    await gen.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toEqual([]);

    controller.abort(new Error('deadline'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(released).toEqual(['released']);
    expect(worker.calls).toContain('interrupt');
    expect(forgotten).toEqual([watched[0]?.token]);
  });

  it('does not interrupt when the signal fires before the generator started', async () => {
    const { registry } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const controller = new AbortController();
    chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal: controller.signal,
    });
    controller.abort(new Error('deadline'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.calls).not.toContain('interrupt');
  });

  it('still rejects the consumer that comes back for another chunk', async () => {
    const { registry } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }], [{ a: 2 }]]);
    const controller = new AbortController();
    const reason = new Error('deadline');
    const gen = chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal: controller.signal,
    });
    await gen.next();
    controller.abort(reason);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(gen.next()).rejects.toBe(reason);
  });

  it('detaches its listener when the generator ends normally', async () => {
    const { registry } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const controller = new AbortController();
    const released: string[] = [];
    const gen = chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal: controller.signal,
      onAbandon: () => released.push('released'),
    });
    for await (const _rows of gen) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort(new Error('too late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The generator is finished; its abandonment cleanup must not run.
    expect(released).toEqual([]);
  });
});
