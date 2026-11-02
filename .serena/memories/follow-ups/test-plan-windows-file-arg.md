# Follow-up — `scripts/test-plan.ts` rejects every file argument on Windows (2026-10-30)

**Status: OPEN** — seen once, cause read in the code, not fixed.

Part of `mem:follow-ups`.

On `windows-latest`, `node scripts/test-plan.ts --browser firefox --modes not-isolated --pair OPFSCoopSyncVFS/sync tests/browser/pairs/probe-coopsync-open.test.ts` exited 2 with `test-plan: tests/browser/pairs/probe-coopsync-open.test.ts is not a test file of the selected projects` (a throwaway probe run of 2026-10-30, since deleted; COOPSYNC-OPEN-DEFAULT in `mem:measurements/held-handles`). The same command passed on Linux.

**Cause, read and not run:** the guard against a typo in a file argument compares `relative(ROOT, resolve(ROOT, file))` with the paths the projects collected (`scripts/test-plan.ts`, the `unknown` filter after the `collectFamily` loop). On Windows `relative()` returns backslashes and Vitest's collected paths are posix, so no file argument ever matches. `pnpm test` without a file argument is unaffected, which is why the Windows workflow never met it.

**Fix to weigh:** normalise both sides to posix separators before comparing (e.g. `split(sep).join('/')`), with a unit test of the comparison under `path.win32`. Workaround meanwhile: run `vitest --project "<cell>" <file>` directly (`--silent=false` to see a passing test's console).
