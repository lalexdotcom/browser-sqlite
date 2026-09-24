import type { PlatformFeature } from './platform';

/** What a build needs from the engine, and what it loses without it. */
export type BuildCapability = {
  /** Platform features this build cannot run without, beyond plain WebAssembly. */
  readonly requires: readonly PlatformFeature[];
  /**
   * Platform features without which a running statement cannot be interrupted.
   * The `sync` build carries an abort into `step()` through a SharedArrayBuffer,
   * which is absent outside a cross-origin isolated context (measured
   * 2026-09-04). COOP/COEP and Document-Isolation-Policy all satisfy the probe.
   */
  readonly interruptibleWithout: readonly PlatformFeature[];
};

/**
 * The build registry. Every other build-keyed table is typed against its keys,
 * so a build missing from one, or extra in one, fails to compile. Preference
 * order is per VFS, in `VFS_CAPABILITIES[vfs].builds`.
 */
export const BUILD_CAPABILITIES = {
  sync: { requires: [], interruptibleWithout: ['cross-origin-isolated'] },
  async: { requires: [], interruptibleWithout: [] },
  jspi: { requires: ['jspi'], interruptibleWithout: [] },
} as const satisfies Record<string, BuildCapability>;

/** Which wa-sqlite WebAssembly build a worker loads. */
export type SQLiteBuild = keyof typeof BUILD_CAPABILITIES;
