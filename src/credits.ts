/**
 * The credit gate: back-pressure for chunk production, and the task turn that
 * makes a worker reachable by `postMessage` while it is inside a query.
 *
 * Pure and Node-testable on purpose. B1 survived for months because the
 * scheduler was reachable only through slow browser tests; this module has the
 * same profile — subtle state transitions otherwise buried behind a worker, a
 * VFS and a real database.
 */

/** One turn of the task queue. Injected so Node tests can drive it. */
export type Tick = () => Promise<void>;

/** Chunks a worker may send before waiting for a credit. Spec §3.4. */
export const DEFAULT_CREDIT_WINDOW = 2;

export type CreditGate = {
  /** Begin a query: `window` credits, not stopped, credit counter cleared. */
  reset: (callId: number, window: number) => void;
  /** Add credits for `callId`. A stale `callId` is ignored (§5.4). */
  grant: (callId: number, n: number) => void;
  /** Stop the current query, waking any wait in progress (§5.1). */
  stop: () => void;
  /** Spend one credit. Always costs one task turn first. */
  take: (callId: number) => Promise<'go' | 'stopped'>;
  isStopped: () => boolean;
  tick: Tick;
};

/**
 * A task turn via MessageChannel. NOT setTimeout: nested setTimeout is clamped
 * to 4 ms, which would cost seconds over a few hundred chunks (spec §3.1).
 */
export const createMessageChannelTick = (): Tick => {
  const channel = new MessageChannel();
  const waiters: (() => void)[] = [];
  channel.port1.onmessage = () => {
    waiters.shift()?.();
  };
  return () =>
    new Promise<void>((resolve) => {
      waiters.push(resolve);
      channel.port2.postMessage(0);
    });
};

export const createCreditGate = (tick: Tick): CreditGate => {
  let credits = 0;
  let currentCallId = -1;
  let stopped = false;
  let signal = Promise.withResolvers<void>();

  /** Settle whoever is waiting, and arm a fresh signal for the next wait. */
  const wake = () => {
    const previous = signal;
    signal = Promise.withResolvers<void>();
    previous.resolve();
  };

  return {
    reset: (callId, window) => {
      currentCallId = callId;
      credits = window;
      stopped = false;
    },

    grant: (callId, n) => {
      if (callId !== currentCallId) return;
      credits += n;
      wake();
    },

    stop: () => {
      stopped = true;
      wake();
    },

    take: async (callId) => {
      if (callId !== currentCallId) return 'stopped';
      // Unconditional, before the credit check: this is the task turn, and it
      // is the only reason a queued `stop` or `close` is ever delivered.
      await tick();
      while (credits <= 0 && !stopped) {
        await signal.promise;
      }
      if (stopped) return 'stopped';
      credits -= 1;
      return 'go';
    },

    isStopped: () => stopped,
    tick,
  };
};
