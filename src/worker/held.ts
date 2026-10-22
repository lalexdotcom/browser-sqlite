/**
 * The DOMException names `createSyncAccessHandle` throws on a file another
 * context holds: `NoModificationAllowedError` on Chromium and Firefox, as the
 * File System spec says, and `InvalidStateError` on WebKit (measured
 * 2026-09-13; wa-sqlite #381 and #382 retry on both). Never match on the
 * message, which is engine prose.
 *
 * `InvalidStateError` is a generic name in WebKit, so on Safari it does not
 * prove the file is held. That is acceptable where this is used: only the
 * open path's retries, both bounded, which then rethrow the original error —
 * an unrelated `InvalidStateError` arrives a few seconds later, unchanged.
 */
const HELD_ERRORS: ReadonlySet<string> = new Set([
  'NoModificationAllowedError',
  'InvalidStateError',
]);

/** Whether `error` says the file is held by another context. */
export const isHeldElsewhere = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && HELD_ERRORS.has(name);
};
