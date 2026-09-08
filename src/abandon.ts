import type { PoolWorker } from './pool';

/**
 * Whether the query this cleanup belongs to ever began.
 *
 * Shared between the generator, which sets it, and the held value, which reads
 * it. A plain object rather than a boolean because the held value must observe
 * a change the generator makes after registration.
 */
export type AbandonState = { started: boolean };

/**
 * What the cleanup needs, and all it may hold.
 *
 * **It must never refer to the registered generator.** A `FinalizationRegistry`
 * held value that reaches its own target keeps the target alive and the
 * callback then never fires. Every field here points downward: the worker and
 * the transport iterator are reachable from the pool anyway, `state` is a plain
 * flag, and `release` is the owning layer's teardown.
 */
export type Abandoned = {
  worker: Pick<PoolWorker, 'interrupt'>;
  iterator: { return: (value?: undefined) => Promise<unknown> };
  state: AbandonState;
  release?: (() => void) | undefined;
};

/**
 * What the `finally` of `queries.chunk` would have done, for a generator that
 * will never run it.
 *
 * The order is that `finally`'s and for its reason: `interrupt()` first, so the
 * queued `return()` is not parked behind a `next()` that will not settle.
 *
 * **`interrupt()` is guarded by `state.started`.** It acts on whatever query the
 * worker is running now and cannot know which query asked, so interrupting on
 * behalf of a generator that never started would abort an unrelated statement —
 * reachable on the transaction path, where the same worker serves the rest of
 * the callback. `return()` needs no guard: on a generator whose body never ran
 * it is a no-op, the body having never entered its `try`.
 */
export const reclaim = ({
  worker,
  iterator,
  state,
  release,
}: Abandoned): void => {
  if (state.started) worker.interrupt();
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
