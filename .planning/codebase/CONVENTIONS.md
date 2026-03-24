# CONVENTIONS.md — Code Conventions

## Code Style
- **Formatter:** Biome (`biome.json`)
  - Indent: **2 spaces**
  - Quotes: **single quotes** (JavaScript/TypeScript)
  - CSS Modules: enabled
- **Import organization:** Biome `organizeImports: "on"` (auto-sorted)
- **VCS integration:** Biome respects `.gitignore`

## TypeScript Patterns

### Strict Mode
- `strict: true` — all strict checks enabled
- `isolatedModules: true` — each file treated independently
- `noEmit: true` — type-check only, build via Rslib

### Type Definitions
- Types and interfaces declared in `src/types.ts` and exported
- Discriminated unions for messages:
```typescript
export type ClientMessageData =
  | { type: 'open'; file: string; flags: SharedArrayBuffer; index: number; vfs?: SQLiteVFS; pragmas?: Record<string, string> }
  | { type: 'query'; callId: number; sql: string; params: any[]; options?: SQLOptions };
```
- `as const satisfies Record<K, V>` pattern for typed const objects:
```typescript
export const WorkerStatuses = {
  EMPTY: -3,
  READY: 10,
  // ...
} as const satisfies Record<string, number>;
```

### Generic Type Parameters
- Generic SQL result types: `<T extends Record<string, unknown>>`
- Default to `T = Record<string, unknown>` when not specified

## Logging Pattern
- Each module creates a scoped logger at module level:
```typescript
const LL = Logger.scope('sqlite/client');
LL.level = 'info';
LL.date = true;
```
- Log level controlled per module (not globally)
- Levels used: `debug`, `info`, `warn`, `verb` (verbose), `wth` (with context), `error`
- Debug logs include worker index for traceability: `LL.debug('[Worker 1] ...', ...)`

## Error Handling
- Errors thrown as `new Error(message, { cause: ... })`
- Worker errors forwarded to main thread as `{ type: 'error', callId, message, cause }`
- `@ts-expect-error` used for untyped wa-sqlite imports (no official TS declarations)
- Guards on invalid states (e.g., `AccessHandlePoolVFS && poolSize > 1` throws immediately)

## Asynchronous Patterns
- `async/await` for promises
- `async function*` generator for streaming results
- `defer<T>()` for manual deferred promises (avoiding Promise constructor nesting)
- `AbortController` / `AbortSignal` propagated through query options

## Module Organization
- `import type` for type-only imports (enforced by `isolatedModules`)
- Lazy dynamic imports for WASM modules (reduces initial bundle):
```typescript
const WA_SQLITE_MODULES = {
  wa_sqlite: () => import(/* webpackChunkName: "wa-sqlite" */ 'wa-sqlite/dist/wa-sqlite.mjs'),
  // ...
};
```
- Webpack magic comments (`/* webpackChunkName: "..." */`) for code splitting

## JSDoc Comments
- Public API types and functions have JSDoc blocks
- Internal helpers have brief single-line descriptions
- `@param`, `@returns` used for non-obvious signatures
- Example:
```typescript
/**
 * Creates a SQLite client with a pool of Web Workers.
 * @param file - Database file path
 * @param clientOptions - Configuration options
 * @returns SQLite database API with read/write/stream/transaction methods
 */
export const createSQLiteClient = (file: string, clientOptions?: CreateSQLLiteClientOptions) => {
```

## Constants Pattern
Numeric sets use named const-satisfies objects instead of enums:
```typescript
const WorkerLock = {
  FREE: 0,
  LOCKED: 1,
} as const satisfies Record<string, number>;
```

## SQL Parameters
- Parameterized queries only — no raw string interpolation
- Custom `sqlParams()` builder generates positional params (`?001`, `?002`, ...)
- `isWriteQuery()` uses regex to detect DML/DDL operations
