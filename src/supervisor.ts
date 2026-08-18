/**
 * Pure restart policy for worker slots.
 *
 * Deliberately free of `Worker`, DOM and orchestrator imports so Node tests can
 * drive it in milliseconds — the same reason `scheduler.ts` is pure. B1 lived
 * for months because the only way to reach the pool's decisions was a browser.
 *
 * The caller reports facts; this module returns a decision and never acts.
 */
export type SupervisorDecision = 'restart' | 'evict' | 'fail-client';

export type Supervisor = {
  report: (
    index: number,
    event: 'ready' | 'served' | 'died',
  ) => SupervisorDecision | undefined;
};

type Slot = { everReady: boolean; alive: boolean; restarts: number };

export const createSupervisor = (options: {
  size: number;
  maxWorkerRestarts?: number;
}): Supervisor => {
  const { size, maxWorkerRestarts = 1 } = options;

  const slots: Slot[] = Array.from({ length: size }, () => ({
    everReady: false,
    alive: true,
    restarts: 0,
  }));

  const liveCount = () => slots.filter((slot) => slot.alive).length;

  return {
    report: (index, event) => {
      const slot = slots[index];
      if (!slot) return undefined;

      if (event === 'ready') {
        slot.everReady = true;
        slot.alive = true;
        // Deliberately NOT resetting `restarts`: a worker that boots fine and
        // dies on every query would otherwise restart forever, silently.
        return undefined;
      }

      if (event === 'served') {
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

      return liveCount() === 0 ? 'fail-client' : 'evict';
    },
  };
};
