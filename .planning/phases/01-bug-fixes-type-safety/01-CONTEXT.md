# Phase 1: Bug Fixes & Type Safety - Context

**Gathered:** 2026-03-24 (discuss mode)
**Status:** Ready for planning

<domain>
## Phase Boundary

Eliminate all known runtime bugs and restore full TypeScript type safety across the public API.
No new features, no test infrastructure, no documentation — only correctness.
Scope anchored to requirements BUG-01 through BUG-05 and TYPE-01 through TYPE-02.

</domain>

<decisions>
## Implementation Decisions

### Logger Level API (BUG-05)
- **D-01:** Remove `debug?: boolean` from `CreateSQLiteClientOptions` entirely. Replace with `logLevel?: 'debug' | 'info' | 'warn' | 'error'`.
- **D-02:** Default value is `'warn'` — silent in production, important warnings still surface.
- **D-03:** Apply `logLevel` to both the client logger (`LL` in `client.ts`) and the worker logger (`LL` in `worker.ts`). The worker receives the option in the `open` message payload.

### satisfies Cast Removal (BUG-03)
- **D-04:** Widen the `SQLiteDB` type (in `client.ts`) to include all methods the factory actually returns: `transaction`, `bulkWrite`, `output`, `close`, and `debug`.
- **D-05:** Remove the `satisfies (...args: any[]) => SQLiteDB` cast on `createSQLiteClient` once `SQLiteDB` covers the full return surface.
- **D-06:** `SQLiteDB` remains the canonical public type for the database API — no second type created.

### wa-sqlite Ambient Declarations (TYPE-01)
- **D-07:** `src/wa-sqlite.d.ts` covers ONLY the surface used in `worker.ts` — nothing more:
  - `wa-sqlite/src/sqlite-api.js` — `Factory()` + the SQLite instance methods: `open_v2`, `statements`, `bind_collection`, `column_names`, `step`, `row`, `changes`, `vfs_register`
  - `wa-sqlite/src/sqlite-constants.js` — `SQLITE_ROW` constant
  - `wa-sqlite/dist/wa-sqlite.mjs`, `wa-sqlite-async.mjs`, `wa-sqlite-jspi.mjs` — default export is a `() => Promise<WASQLiteModule>` factory
  - `wa-sqlite/src/examples/OPFSPermutedVFS.js` etc. — each exports a class with a static `create(name: string, module: WASQLiteModule, options?: object): Promise<any>` method
- **D-08:** All 6 `@ts-expect-error` directives in `worker.ts` must be removed after the declarations are authored.

### Mechanical Fixes (no user decision needed)
- **D-09 (BUG-01):** Fix the inverted condition in `worker.ts:79` — change `Object.keys(pragmas).length` to `!Object.keys(pragmas).length` so pragmas are applied when the object is non-empty.
- **D-10 (BUG-02):** Rename `CreateSQLLiteClientOptions` → `CreateSQLiteClientOptions` across all files (`client.ts`, `index.ts`, any re-exports).
- **D-11 (BUG-04):** Add `"@lalex/promises": "*"` to the `dependencies` section of `package.json`.
- **D-12 (TYPE-02):** Remove all commented-out debug blocks from `client.ts` (the `// LL.wth(...)` lines on ~398, 403, 433, 439, 475, 480, 517, 521) and the dead `log` lambda (lines 55–57) and `log = ...` assignment (lines 65–67) in `worker.ts`.

### Claude's Discretion
- Exact TypeScript type shapes inside `wa-sqlite.d.ts` (e.g., whether SQLite row values are typed as `unknown` or `any`)
- Whether to use `declare module` or `declare namespace` syntax in ambient declarations
- Whether `SQLiteDB.debug` field has a precise type or `unknown`

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

No external specs — requirements are fully captured in decisions above.

### Source files to read before modifying
- `src/client.ts` — `CreateSQLiteClientOptions`, `createSQLiteClient`, `SQLiteDB`, commented-out log calls
- `src/worker.ts` — `allQueryPragmas` bug, `@ts-expect-error` directives, dead `log` lambda, hardcoded logger level
- `src/types.ts` — type exports, not currently used for `SQLiteDB` (defined inline in client.ts)
- `src/index.ts` — public re-exports (rename must propagate here)
- `package.json` — `dependencies` section (BUG-04)

### Requirements
- `.planning/REQUIREMENTS.md` — BUG-01 through BUG-05, TYPE-01, TYPE-02

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Logger.scope(name)` from `@lalex/console` — already used in both `client.ts` and `worker.ts`. The returned logger has a `.level` property that accepts string log levels.
- `ClientMessageData` union type in `types.ts` — the `open` message payload needs a new `logLevel?` field to carry the setting from client to worker.

### Established Patterns
- Logger created at module level: `const LL = Logger.scope('sqlite/client'); LL.level = 'info';` — the fix changes the hardcoded level to use the option value.
- `as const satisfies Record<K, V>` pattern used throughout — appropriate for typed constant sets but not for function return type constraints.
- Options bags use optional fields with `??` defaults — `logLevel` should follow the same pattern.

### Integration Points
- Worker receives configuration via the `open` message (`ClientMessageData` union in `types.ts`). The `logLevel` option must be added there so `worker.ts` can apply it when initializing its own `LL`.
- `index.ts` re-exports `CreateSQLLiteClientOptions` (with the typo) — the rename must be reflected there too.

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for type shapes and module declaration syntax.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-bug-fixes-type-safety*
*Context gathered: 2026-03-24*
