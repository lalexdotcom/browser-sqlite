# STACK.md — Tech Stack

## Language
- **TypeScript** (strict mode, ESNext, `isolatedModules: true`)
- Target environments: **browser main thread** (client) + **Web Workers** (SQLite execution)

## Runtime
- **Browser** — designed specifically for web environments
- Relies on browser APIs: `Web Workers`, `SharedArrayBuffer`, `Atomics`, OPFS (Origin Private File System), IndexedDB
- No Node.js dependencies in the library itself

## Build System
- **Rslib** (`@rslib/core ^0.20.0`) — library bundler based on Rspack/Rsbuild
- Three output formats:
  - ESM → `dist/esm/index.js` (esnext syntax)
  - CJS → `dist/cjs/index.cjs` (es2015 syntax)
  - UMD → `dist/umd/index.js` (es2015 syntax, globalName: `wsqlite`)
- Declaration files: generated for ESM and CJS (`dts: true`)

## Package Manager
- **pnpm** (workspace with pnpm-lock.yaml)

## Runtime Dependencies
| Package | Version | Purpose |
|---|---|---|
| `wa-sqlite` | `github:rhashimoto/wa-sqlite#v1.0.9` | WebAssembly SQLite bindings with multiple VFS backends |
| `@lalex/console` | `2.0.0-rc.1` | Scoped logger with level control and date tagging |
| `@lalex/promises` | (implied by usage) | `defer()` utility for deferred Promise creation |

## Dev Dependencies
| Package | Purpose |
|---|---|
| `@rslib/core ^0.20.0` | Library build toolchain |
| `@rstest/core ^0.9.0` | Test framework (Rstest) |
| `@rstest/adapter-rslib ^0.2.1` | Rstest adapter for Rslib projects |
| `@biomejs/biome 2.4.6` | Linter + formatter |
| `@types/node ^24.12.0` | Node type definitions |
| `typescript ^5.9.3` | TypeScript compiler |

## TypeScript Configuration
- `lib: ["ES2022"]`, `module: ESNext`, `noEmit: true`
- `strict: true`, `isolatedModules: true`, `resolveJsonModule: true`
- `moduleResolution: bundler`, `allowImportingTsExtensions: true`
- Source: `src/` only

## wa-sqlite WebAssembly Modules
Three WASM builds, selected per VFS:
- `wa-sqlite.mjs` — synchronous WASM
- `wa-sqlite-async.mjs` — async WASM (OPFS async VFS)
- `wa-sqlite-jspi.mjs` — Java Promise Integration API build
