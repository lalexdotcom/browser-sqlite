/**
 * Makes a value safe to hand to `postMessage`.
 *
 * The whole point is a failure the caller cannot recover from: a cause that
 * cannot be structured-cloned makes `postMessage` itself throw, and every call
 * site here is already inside a `catch` building an error reply. The throw
 * would replace that reply with nothing, and the client would wait for ever on
 * a request that was answered by no message at all.
 *
 * Pure, and in its own module for the reason `statement-cache.ts` is: the
 * remainder of `worker.ts` only runs in a browser, and this decides something
 * worth testing in Node against a value that is deliberately unclonable.
 */

/**
 * Returns `value` when it survives the structured-clone algorithm, and its
 * string form when it does not.
 *
 * `MessageChannel` rather than `structuredClone()`: the two run the same
 * algorithm and throw the same `DataCloneError`, but `structuredClone` lands at
 * Chrome 98 where `MessageChannel` is Chrome 2 / Firefox 41 / Safari 5. Using
 * it would have raised this library's floor by six Chrome versions to protect
 * an error *cause* — see `scripts/render-vfs-matrix.ts`, which computes that
 * floor from the APIs named here.
 */
export const cloneable = (value: unknown): unknown => {
  const channel = new MessageChannel();
  try {
    // Never received, and it does not need to be: the clone — and its
    // DataCloneError — happens synchronously inside postMessage.
    channel.port1.postMessage(value);
    return value;
  } catch {
    return String(value);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
};
