import type { PoolWorker } from './pool';

/**
 * Whether this cleanup has already run.
 *
 * A plain object rather than a boolean because the held value must observe a
 * change the generator makes after registration. Three routes reach the
 * cleanup — the registry, the abort listener and the generator's own `finally`
 * — and whichever arrives first closes the door on the other two.
 *
 * What it deliberately does NOT record is whether the query ever started. That
 * answers "did this generator run", where the only question that matters is
 * "is the worker still serving this query" — and the worker is the one that
 * knows, which is why `interrupt()` is asked rather than told.
 */
export type AbandonState = { done: boolean };

/**
 * What the cleanup needs, and all it may hold.
 *
 * **It must never refer to the registered generator.** A `FinalizationRegistry`
 * held value that reaches its own target keeps the target alive and the
 * callback then never fires. Every field here points downward or sideways: the
 * worker and the transport iterator are reachable from the pool anyway, `state`
 * is a plain flag, `detach` closes over the caller's signal and its listener,
 * and `release` is the owning layer's teardown.
 */
export type Abandoned = {
  worker: Pick<PoolWorker, 'interrupt'>;
  iterator: { return: (value?: undefined) => Promise<unknown> };
  state: AbandonState;
  /**
   * Removes the abort listener that carries this very cleanup. Without it a
   * listener stays armed on a signal the CALLER owns, long after the query it
   * belonged to has ended — and fires against whatever the worker is doing
   * then.
   */
  detach: () => void;
  release?: (() => void) | undefined;
};

/**
 * What the `finally` of `queries.chunk` would have done, for a generator that
 * will never run it.
 *
 * The order is that `finally`'s and for its reason: `interrupt()` first, so the
 * queued `return()` is not parked behind a `next()` that will not settle.
 *
 * **Nothing here may assume the worker is still ours.** This runs at a moment
 * nobody chose — a collection, or the caller tidying up its own controller —
 * and by then the worker may be serving a query that has nothing to do with
 * this one. So the transport is named in both calls: `interrupt(iterator)` is a
 * no-op unless the worker is still serving it, and `iterator.return()` resumes
 * a transport whose own `finally` makes the same check. `return()` on a
 * generator whose body never ran is a no-op besides, the body having never
 * entered its `try`.
 *
 * `release` is the exception and runs unconditionally: it is the owning layer's
 * resource — a lease, a timer, a merge teardown — and it is owed whatever the
 * worker has since moved on to.
 */
export const reclaim = ({
  worker,
  iterator,
  state,
  detach,
  release,
}: Abandoned): void => {
  if (state.done) return;
  state.done = true;
  detach();
  worker.interrupt(iterator);
  void iterator.return(undefined).catch(() => {});
  release?.();
};

export type AbandonRegistry = {
  /** Watch `target`; `held` is what the cleanup receives, `token` unregisters. */
  watch: (target: object, held: Abandoned, token: object) => void;
  /** The generator ended by an ordinary route — there is nothing to reclaim. */
  forget: (token: object) => void;
};

/**
 * `run` is injected so that tests drive the cleanup without a collection.
 * Nothing else here is observable: a `FinalizationRegistry` fires when the
 * engine decides, which is not a schedule a test can assert against.
 */
export const createAbandonRegistry = (
  run: (held: Abandoned) => void = reclaim,
): AbandonRegistry => {
  const registry = new FinalizationRegistry<Abandoned>(run);
  return {
    watch: (target, held, token) => registry.register(target, held, token),
    forget: (token) => registry.unregister(token),
  };
};

/** The one this library uses. */
export const abandonRegistry = createAbandonRegistry();
