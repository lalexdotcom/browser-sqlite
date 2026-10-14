// Test-only entry, built by rslib.vitest.config.ts beside index.js in
// tests/build/. It re-exports the public surface AND the internals the
// white-box tests drive, so such a test takes everything from one bundle —
// two bundles are two copies of the code, and an `instanceof` or a module
// singleton does not cross between them. Never part of the published package.

export { encodeParams } from '../../src/binary';
export * from '../../src/index';
export { resolveRealmId } from '../../src/inspect';
export { createLocks } from '../../src/locks';
export { createLogger } from '../../src/logger';
export { createPoolWorker, type PoolWorker } from '../../src/pool';
