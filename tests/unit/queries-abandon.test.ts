import { describe, expect, it } from '@rstest/core';
import type { Abandoned, AbandonRegistry } from '../../src/abandon';
import { reclaim } from '../../src/abandon';
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

/**
 * A worker that yields `chunks` and records the calls that matter.
 *
 * Models the identity check `src/pool.ts` makes rather than acting as a bare
 * spy: `servingQuery` names the transport the worker is currently serving —
 * set only once a transport's body actually starts running, exactly as
 * `runQuery` sets it on the pool — and `interrupt(on)` is a no-op unless `on`
 * is that transport, exactly as the real one is. `query()` may be called more
 * than once on the same worker, the way a transaction reuses one worker for
 * several statements, so a test can hold a stale transport past the point
 * where the worker has moved on to a live one.
 */
const fakeWorker = (chunks: Record<string, unknown>[][]) => {
  const calls: string[] = [];
  /** What each interrupt() named, so that a stale stop can be told apart. */
  const stopped: unknown[] = [];
  /** Every interrupt() that actually landed, i.e. named the transport the
   * worker was serving at the time — the effect a bare spy cannot tell apart
   * from a no-op. */
  const interrupted: unknown[] = [];
  let servingQuery: object | undefined;
  return {
    calls,
    stopped,
    interrupted,
    index: 0,
    interrupt: (on?: object) => {
      calls.push('interrupt');
      stopped.push(on);
      // src/pool.ts: interrupt(on) acts on whatever query the worker is
      // running now and cannot know which query asked for it, so it is a
      // no-op unless the worker still serves `on`.
      if (on !== servingQuery) return;
      interrupted.push(on);
    },
    quiesce: async () => {},
    query: (): AsyncGenerator<Record<string, unknown>[]> => {
      const self: { gen?: AsyncGenerator<Record<string, unknown>[]> } = {};
      self.gen = (async function* () {
        calls.push('query');
        // Claim the worker, the way runQuery's `servingQuery = self.gen` does.
        // Nothing runs before the first next(), so an unstarted transport
        // never reaches this line.
        servingQuery = self.gen;
        try {
          for (const c of chunks) yield c;
        } finally {
          // Only the transport the worker is actually serving may run this
          // teardown — src/pool.ts's own comment on the same guard. A stale
          // transport resumed by a late reclaim() must not clobber the query
          // the worker has since moved on to.
          if (servingQuery === self.gen) {
            calls.push('transport-finally');
            servingQuery = undefined;
          }
        }
      })();
      return self.gen;
    },
  };
};

describe('chunk() and abandonment', () => {
  it('registers the generator before it is started', () => {
    const { registry, watched } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    chunk(worker as never, 'SELECT 1', undefined, { registry });
    expect(watched).toHaveLength(1);
    // Registered and armed, with nothing asked of the transport yet.
    expect(watched[0]?.held.state.done).toBe(false);
    expect(worker.calls).not.toContain('query');
  });

  it('holds the transport it registered, and not the generator', () => {
    // D3: a held value that reaches its own target keeps the target alive and
    // the callback never fires — a failure no green test can report. What is
    // checkable here is the positive half: the held value is the transport.
    const { registry, watched } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const gen = chunk(worker as never, 'SELECT 1', undefined, { registry });
    const held = watched[0]?.held;
    expect(held?.iterator).not.toBe(gen);
    expect(Object.values(held ?? {})).not.toContain(gen);
  });

  it('closes the cleanup for good when the generator ends', async () => {
    const { registry, watched } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const gen = chunk(worker as never, 'SELECT 1', undefined, { registry });
    for await (const _rows of gen) {
      // A streaming test must await in its loop body.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(watched[0]?.held.state.done).toBe(true);
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
  it('does not stop the worker on behalf of a generator that never started', async () => {
    // This used to be `state.started`'s job in `reclaim` itself: a generator
    // whose next() was never called owns no query, so a cleanup must not stop
    // the worker on its behalf. `state.started` is gone (A1) because it
    // answered the wrong question; the rule survives, but it is now the
    // WORKER's rule, not reclaim's — reclaim calls interrupt() unconditionally
    // and leaves the decision to whatever the worker is actually serving.
    const { registry } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }]]);
    const controller = new AbortController();
    chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal: controller.signal,
    });
    controller.abort(new Error('deadline'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // interrupt() is still called...
    expect(worker.calls).toContain('interrupt');
    // ...but the never-started transport was never the worker's current
    // query, so the call never actually stopped anything.
    expect(worker.interrupted).toEqual([]);
    // And the transport's own body never ran: return() on a generator still
    // at "suspended start" completes it without ever entering the try.
    expect(worker.calls).not.toContain('query');
  });

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

  it('names the transport when it stops the worker', async () => {
    // The abort may land long after this query ended, on a signal the caller
    // owns and keeps. An unnamed stop would then break whatever the worker had
    // moved on to, and that consumer would see a short result with no error.
    const { registry, watched } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }], [{ a: 2 }]]);
    const controller = new AbortController();
    const gen = chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal: controller.signal,
    });
    await gen.next();
    controller.abort(new Error('deadline'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.stopped).toEqual([watched[0]?.held.iterator]);
  });

  it('runs the cleanup once, however many times the abort is repeated', async () => {
    const { registry } = fakeRegistry();
    const worker = fakeWorker([[{ a: 1 }], [{ a: 2 }]]);
    const controller = new AbortController();
    const released: string[] = [];
    const gen = chunk(worker as never, 'SELECT 1', undefined, {
      registry,
      signal: controller.signal,
      onAbandon: () => released.push('released'),
    });
    await gen.next();
    controller.abort(new Error('deadline'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The consumer comes back and the generator's own finally runs too: the
    // three routes to the cleanup must add up to one run.
    await expect(gen.next()).rejects.toThrow('deadline');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toEqual(['released']);
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

describe('a cleanup naming a transport the worker has moved on from', () => {
  it('does not stop the live query it is not the transport of', async () => {
    // A1: `done` can clear a query's state while its own transport is still
    // suspended at its `yield`, so the reuse guard lets the WORKER move on to
    // a new query before the stale transport's cleanup ever runs. A cleanup
    // that named "the worker", rather than the specific transport, would then
    // stop whatever the worker is serving now — a live, unrelated query. That
    // was a real regression, bisected against `main` and reproduced at 100
    // rows of 4000.
    const worker = fakeWorker([[{ a: 1 }], [{ a: 2 }]]);

    const { registry: staleRegistry, watched: staleWatched } = fakeRegistry();
    const stale = chunk(worker as never, 'SELECT 1', undefined, {
      registry: staleRegistry,
    });
    await stale.next(); // Starts the stale transport; the worker serves it.
    const [{ held: staleHeld }] = staleWatched;

    const { registry: liveRegistry } = fakeRegistry();
    const live = chunk(worker as never, 'SELECT 2', undefined, {
      registry: liveRegistry,
    });
    await live.next(); // The worker moves on: it now serves the live one.

    // The stale generator's cleanup arrives late, naming its OWN transport —
    // never the worker's current one.
    reclaim(staleHeld);

    expect(worker.interrupted).toEqual([]);
    // The live query is unaffected: it still has its second chunk to give.
    const outcome = await live.next();
    expect(outcome).toEqual({ value: [{ a: 2 }], done: false });
  });
});
