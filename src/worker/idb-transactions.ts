/**
 * Every IndexedDB transaction a worker starts, until it fires `complete` or
 * `abort`.
 *
 * Safari before WebKit 321564@main (26.x, 27.0.x; WebKit bug 324094) keeps the
 * connection of a worker terminated before its last transaction completed — a
 * readonly one included — for the life of the browser process:
 * `indexedDB.deleteDatabase` and upgrades of that database then block, through
 * reloads. Measured through the library on Safari 26.6.2 (2026-10-20): the
 * delete worker's last readonly transaction stranded 45 of 75 test files'
 * cleanups on IDBBatchAtomicVFS, and a forced kill mid-write 3-22 % of kills.
 * A worker that waits here before its last reply, and refuses new work before
 * a kill, leaves nothing live to strand.
 *
 * Not `error`: a request's error bubbles to its transaction, which goes on
 * unless it aborts — and an abort fires `abort`.
 */
export type IdbTransactionTracker = {
  /** Resolves once no tracked transaction is live, or after `ms`. */
  settled: (ms: number) => Promise<void>;
  /** From now on, `transaction()` throws `InvalidStateError`. */
  refuseNew: () => void;
};

export const trackIdbTransactions = (
  prototype: IDBDatabase,
): IdbTransactionTracker => {
  const live = new Map<IDBTransaction, Promise<void>>();
  let refusing = false;
  const transaction = prototype.transaction;

  prototype.transaction = function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase['transaction']>
  ) {
    if (refusing) {
      throw new DOMException(
        'The worker is being terminated.',
        'InvalidStateError',
      );
    }
    const tx = transaction.apply(this, args);
    live.set(
      tx,
      new Promise<void>((resolve) => {
        const done = () => {
          live.delete(tx);
          resolve();
        };
        tx.addEventListener('complete', done);
        tx.addEventListener('abort', done);
      }),
    );
    return tx;
  } as IDBDatabase['transaction'];

  return {
    settled: async (ms) => {
      const deadline = Date.now() + ms;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
      try {
        // Again after each wait: a transaction may start while we wait.
        while (live.size > 0 && Date.now() < deadline) {
          await Promise.race([Promise.all(live.values()), expired]);
        }
      } finally {
        clearTimeout(timer);
      }
    },
    refuseNew: () => {
      refusing = true;
    },
  };
};
