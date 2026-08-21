/**
 * Pure restart policy for worker slots.
 *
 * Deliberately free of `Worker` and DOM imports so Node tests can
 * drive it in milliseconds — the same reason `scheduler.ts` is pure. B1 lived
 * for months because the only way to reach the pool's decisions was a browser.
 *
 * The caller reports facts; this module returns a decision and never acts.
 */
export type SupervisorDecision = 'restart' | 'evict' | 'fail-client';

export type Supervisor = {
  report: (
    index: number,
    event: 'spawned' | 'ready' | 'served' | 'died',
  ) => SupervisorDecision | undefined;
};

type Slot = {
  everReady: boolean;
  alive: boolean;
  evicted: boolean;
  restarts: number;
};

export const createSupervisor = (options: {
  size: number;
  maxWorkerRestarts?: number;
}): Supervisor => {
  const { size, maxWorkerRestarts = 1 } = options;

  const slots: Slot[] = Array.from({ length: size }, () => ({
    everReady: false,
    alive: true,
    evicted: false,
    restarts: 0,
  }));

  const liveCount = () => slots.filter((slot) => slot.alive).length;

  return {
    report: (index, event) => {
      const slot = slots[index];
      if (!slot) return undefined;

      if (event === 'spawned') {
        // A slot is alive from the moment a worker is created for it — which is
        // what the constructor's `alive: true` already encodes for the first
        // spawn. Without this event a restarted slot never re-enters that
        // state, so the replacement's death reads as a duplicate signal for the
        // worker that died before it: the guard below returns no decision, the
        // client neither restarts nor fails, and every queued request waits on
        // a pool that will never have a worker again.
        if (slot.evicted) return undefined;
        slot.alive = true;
        return undefined;
      }

      if (event === 'ready') {
        // An evicted slot cannot be revived: the eviction was permanent and a
        // late ready would inflate liveCount, masking an empty pool.
        if (slot.evicted) return undefined;
        slot.everReady = true;
        slot.alive = true;
        // Deliberately NOT resetting `restarts`: a worker that boots fine and
        // dies on every query would otherwise restart forever, silently.
        return undefined;
      }

      if (event === 'served') {
        // A stale done message can arrive after the slot was declared dead; if
        // it reset restarts then, it would silently refill the spent budget.
        if (!slot.alive) return undefined;
        slot.restarts = 0;
        return undefined;
      }

      // 'died' — a slot already counted as dead reports once per signal
      // (onerror and a drain timeout can both fire), so ignore repeats.
      if (!slot.alive) return undefined;
      slot.alive = false;

      // R1: a slot that never worked is a configuration error, not an
      // accident. Restarting it only delays the diagnostic.
      if (slot.everReady && slot.restarts < maxWorkerRestarts) {
        slot.restarts += 1;
        return 'restart';
      }

      slot.evicted = true;
      return liveCount() === 0 ? 'fail-client' : 'evict';
    },
  };
};
