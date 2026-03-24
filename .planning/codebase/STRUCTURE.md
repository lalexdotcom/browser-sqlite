# STRUCTURE.md — Directory Structure

## Root Layout
```
wsqlite/
├── src/                     # Source code (TypeScript)
├── tests/                   # Test files
├── dist/                    # Build output (gitignored)
│   ├── esm/                 # ESM build (esnext)
│   ├── cjs/                 # CJS build (es2015)
│   └── umd/                 # UMD build (es2015, globalName: wsqlite)
├── .planning/               # GSD project planning artifacts
│   └── codebase/            # Codebase analysis documents (this dir)
├── .github/                 # GitHub config + GSD skills/agents
├── node_modules/            # Dependencies (managed by pnpm)
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── rslib.config.ts          # Build configuration
├── rstest.config.ts         # Test configuration
├── biome.json               # Linter + formatter config
├── README.md
├── LICENSE
└── AGENTS.md                # AI agent instructions
```

## Source Files — `src/`
```
src/
├── index.ts         # Package entry point — re-exports from client.ts
├── client.ts        # Main client API (createSQLiteClient, SQLiteDB type)
├── orchestrator.ts  # WorkerOrchestrator — SharedArrayBuffer + Atomics sync
├── worker.ts        # Web Worker entrypoint — wa-sqlite execution
├── types.ts         # TypeScript message types and VFS type definitions
├── utils.ts         # sqlParams() builder, isWriteQuery() heuristic
└── debug.ts         # Debug utilities for SQL query interpolation
```

## Key File Responsibilities

| File | Exported | Runs in |
|---|---|---|
| `src/index.ts` | All public exports | Main thread |
| `src/client.ts` | `createSQLiteClient`, `SQLiteDB`, `CreateSQLLiteClientOptions` | Main thread |
| `src/orchestrator.ts` | `WorkerOrchestrator`, `WorkerStatuses` | Both threads |
| `src/worker.ts` | (Web Worker, not imported directly) | Worker thread |
| `src/types.ts` | All message/VFS types | Type-only |
| `src/utils.ts` | `sqlParams`, `isWriteQuery` | Main thread |
| `src/debug.ts` | `debugSQLQuery`, `createClientDebug` | Main thread |

## Test Files — `tests/`
```
tests/
└── index.test.ts    # Placeholder test for squared() (not yet the real API)
```

## Config Files
| File | Tool | Purpose |
|---|---|---|
| `rslib.config.ts` | Rslib | Multi-format build configuration (ESM/CJS/UMD) |
| `rstest.config.ts` | Rstest | Test runner extending rslib config |
| `tsconfig.json` | TypeScript | Strict mode, bundler resolution, ESNext modules |
| `biome.json` | Biome | Lint rules + formatter (single quotes, spaces) |

## Naming Conventions
- **Files:** `camelCase.ts` (e.g., `orchestrator.ts`, `client.ts`)
- **Types:** `PascalCase` (e.g., `SQLiteDB`, `WorkerOrchestrator`, `CreateSQLLiteClientOptions`)
- **Constants:** `UPPER_SNAKE_CASE` for fixed records (e.g., `WorkerStatuses`, `WorkerLock`, `FlagsIndexes`)
- **Functions:** `camelCase` (e.g., `createSQLiteClient`, `acquireWorker`, `isWriteQuery`)
- **Logger instances:** `LL` (short for "local logger") per module scope
