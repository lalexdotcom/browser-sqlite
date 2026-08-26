// `describeMissing` and `KNOWN_FEATURES` are intentionally NOT exported:
// their messages are written for this library's own guard, and consumers
// building their own messages want their own words.
export { detectFeatures, missingFeature } from './capabilities';
export * from './client';
export * from './errors';
// Named rather than `export *`: the wire-protocol types in types.ts are
// internal and must not reach the public surface.
export {
  defaultBuildFor,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
  type VFSCapability,
  type VFSMemoryModel,
} from './types';
