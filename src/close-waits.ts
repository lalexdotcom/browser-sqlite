/**
 * How long `close()` waits on a worker or on the drain, which depends on
 * whether the close is `immediate`.
 *
 * A draining close waits `drainTimeout`. An immediate one waits `grace`, and a
 * close made immediate while it waits stops waiting out the rest of
 * `drainTimeout`: it gets one fresh `grace` from that moment. Kept apart from
 * the client so the timing can be tested without a browser.
 */
export type CloseWaits = {
  /** Whether the close is immediate, from the start or since `escalate()`. */
  immediate: () => boolean;
  /**
   * Makes the close immediate. Returns whether this call did it: `false` when
   * it already was, so the steps that go with it run once.
   */
  escalate: () => boolean;
  /** Waits for `promise` as long as the close in its current mode allows. */
  waitOn: (promise: Promise<unknown>) => Promise<void>;
};

/** Resolves when `promise` settles or after `ms`, whichever comes first. */
const bounded = async (promise: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const createCloseWaits = (
  drainTimeout: number,
  grace: number,
): CloseWaits => {
  let immediate = false;
  const escalated = Promise.withResolvers<void>();
  return {
    immediate: () => immediate,
    escalate: () => {
      if (immediate) return false;
      immediate = true;
      escalated.resolve();
      return true;
    },
    waitOn: async (promise) => {
      if (!immediate) {
        await bounded(Promise.race([promise, escalated.promise]), drainTimeout);
      }
      // Re-read: the close may have been made immediate during the wait above.
      if (immediate) await bounded(promise, grace);
    },
  };
};
