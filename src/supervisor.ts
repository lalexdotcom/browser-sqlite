/**
 * Pure restart policy for worker slots.
 *
 * Deliberately free of `Worker` and DOM imports so Node tests can
 * drive it in milliseconds — the same reason `scheduler.ts` is pure. B1 lived
 * for months because the only way to reach the pool's decisions was a browser.
 *
 * The caller reports facts; this module returns a decision and never acts.
 */
export type SupervisorDecision = 'restart' | 'lost' | 'fail-client';

export type Supervisor = {
  report: (
    index: number,
    event: 'spawned' | 'ready' | 'served' | 'died' | 'lost',
  ) => SupervisorDecision | undefined;
};

type Slot = {
  everReady: boolean;
  alive: boolean;
  lost: boolean;
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
    lost: false,
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
        if (slot.lost) return undefined;
        slot.alive = true;
        return undefined;
      }

      if (event === 'ready') {
        // A lost slot cannot be revived: the loss was permanent and a
        // late ready would inflate liveCount, masking an empty pool.
        if (slot.lost) return undefined;
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

      if (event === 'lost') {
        // A death the caller has ALREADY judged terminal, which 'died' cannot
        // express. The startup retry round is capped at one, so a slot the
        // client has announced through `onWorkerLost` must never come back.
        // Reported as 'died' it would take the restart branch instead: `lost`
        // would stay false, leaving the slot revivable by a later
        // 'spawned'/'ready', and a restart would be charged against a budget
        // for a restart that never happens. The supervisor's view and the
        // consumer's would then disagree, with no source of truth to arbitrate.
        //
        // Same duplicate-signal guard as 'died': one report per slot.
        if (!slot.alive) return undefined;
        slot.alive = false;
        slot.lost = true;
        return liveCount() === 0 ? 'fail-client' : 'lost';
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

      slot.lost = true;
      return liveCount() === 0 ? 'fail-client' : 'lost';
    },
  };
};
