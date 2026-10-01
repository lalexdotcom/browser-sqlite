// `describeMissing` and `KNOWN_FEATURES` are intentionally NOT exported:
// their messages are written for this library's own guard, and consumers
// building their own messages want their own words.
export * from './api';
export { detectFeatures, missingFeature } from './capabilities';
export * from './client';
export type { SQLiteBuild } from './const/builds';
export type { PlatformFeature } from './const/platform';
export {
  SQLITE_CODES,
  SQLITE_EXTENDED_CODES,
  type SQLiteExtendedResultCode,
  type SQLiteResultCode,
} from './const/sqlite';
export type { SQLiteVFS } from './const/vfs';
export type {
  ClientDebugState,
  QueryDebugState,
  RequestDebugState,
  WorkerDebugState,
} from './debug';
export * from './delete';
export {
  type ClientInspection,
  type DatabaseClient,
  type DatabaseInspection,
  type InspectDatabaseOptions,
  type InspectionBase,
  inspectDatabase,
} from './inspect';
// Nothing exports from `./types/protocol`: the wire protocol stays internal.
export * from './types/errors';
