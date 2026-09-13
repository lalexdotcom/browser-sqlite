/**
 * Platform features a worker can probe for itself, synchronously, before it
 * loads anything. Pure, and tested in Node for the reason `cloneable.ts` is.
 *
 * `readwrite-unsafe` cannot be probed from the page: `FileSystemSyncAccessHandle`
 * is exposed to dedicated workers only, which is why `capabilities.ts` lists
 * it as unprobeable. A worker can, and without opening a file: the engines that
 * implement the mode also ship the handle's `mode` ATTRIBUTE. That is not the
 * trap `capabilities.ts` warns about — WebIDL ignores an unknown DICTIONARY
 * member, so passing the option proves nothing, but an attribute an engine does
 * not implement is simply absent from the prototype. Measured 2026-09-13 in a
 * dedicated worker: Chromium true, Firefox false, Safari false
 * (spec 2026-09-13, §3.1).
 */
import type { PlatformFeature } from '../types';

/** The globals a probe reads; `globalThis` in a worker, a stub in tests. */
export type ProbeScope = { FileSystemSyncAccessHandle?: unknown };

const hasModeAttribute = (scope: ProbeScope): boolean => {
  const Handle = scope.FileSystemSyncAccessHandle;
  return typeof Handle === 'function' && 'mode' in Handle.prototype;
};

export const WORKER_PROBES: Partial<
  Record<PlatformFeature, (scope: ProbeScope) => boolean>
> = {
  'readwrite-unsafe': hasModeAttribute,
};

/**
 * The first feature of `features` this worker lacks, or null. A feature with
 * no probe here is never reported missing: declining on something unprobeable
 * would shrink every pool on every engine.
 */
export const firstMissing = (
  features: readonly PlatformFeature[],
  scope: ProbeScope = globalThis as ProbeScope,
): PlatformFeature | null => {
  for (const feature of features) {
    const probe = WORKER_PROBES[feature];
    if (probe && !probe(scope)) return feature;
  }
  return null;
};
