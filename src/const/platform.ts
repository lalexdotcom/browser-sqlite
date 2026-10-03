/**
 * A platform feature a VFS may need. Which browser versions ship each one is
 * documentation data, not runtime data, so it lives in the VFS.md generator
 * (`scripts/render-vfs-matrix.ts`) with its sources — not here, where it would
 * ship to every consumer for nothing.
 */
export type PlatformFeature =
  | 'opfs'
  | 'readwrite-unsafe'
  | 'jspi'
  | 'writable-stream'
  | 'cross-origin-isolated'
  | 'web-locks';
