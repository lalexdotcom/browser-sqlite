# Changelog

## Unreleased

### Breaking

- **`vfs` is now required.** If you relied on the default, pass
  `vfs: 'OPFSAdaptiveVFS'` to keep reading your existing database. A VFS decides
  where the bytes live, so a default that moved between versions would leave you
  reading an empty database while your data sat in a store nothing queries.
- **`DEFAULT_VFS` is no longer exported.** There is no default. Write the VFS
  name in your own source, where it cannot move.

### Added

- `createSQLiteClient` now checks platform support at construction and throws
  `SQLiteError('INVALID_OPTION')` naming the missing feature and an alternative,
  instead of failing later inside a worker.
- `detectFeatures()` and `missingFeature()` are exported, so an application can
  ask whether a browser can run a given VFS and build before constructing a
  client.
