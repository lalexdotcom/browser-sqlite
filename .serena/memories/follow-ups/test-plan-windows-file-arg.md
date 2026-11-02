# Follow-up — `scripts/test-plan.ts` rejects every file argument on Windows (2026-10-30)

**Status: CLOSED** — 2026-11-02, `fix/test-plan-windows-file-arg`: `collectFamily` compares through `namedTestFiles()` (relative paths), unit-tested under `path.win32`, and verified on `windows-latest` (run 41459385537, § Fix).

Part of `mem:follow-ups`.

On `windows-latest`, `node scripts/test-plan.ts --browser firefox --modes not-isolated --pair OPFSCoopSyncVFS/sync tests/browser/pairs/probe-coopsync-open.test.ts` exited 2 with `test-plan: tests/browser/pairs/probe-coopsync-open.test.ts is not a test file of the selected projects` (a throwaway probe run of 2026-10-30, since deleted; COOPSYNC-OPEN-DEFAULT in `mem:measurements/held-handles`). The same command passed on Linux.

**Cause, read and not run:** the guard against a typo in a file argument compares `relative(ROOT, resolve(ROOT, file))` with the paths the projects collected (`scripts/test-plan.ts`, the `unknown` filter after the `collectFamily` loop). On Windows `relative()` returns backslashes and Vitest's collected paths are posix, so no file argument ever matches. `pnpm test` without a file argument is unaffected, which is why the Windows workflow never met it.

**Fix to weigh:** normalise both sides to posix separators before comparing (e.g. `split(sep).join('/')`), with a unit test of the comparison under `path.win32`. Workaround meanwhile: run `vitest --project "<cell>" <file>` directly (`--silent=false` to see a passing test's console).

## Fix (2026-11-02)

**The cause above was in the wrong place.** `test-plan.ts`'s guard is sound on Windows: both its sides go through `relative()`, which gives `\` for both. The mismatch was one step earlier, in `collectFamily` (`scripts/plan-io.ts`): it filtered `project.globTestFiles()` — `/` on every platform, Vitest's own `filterFiles` slashes its filters on `win32` for that reason — against `resolve(ROOT, file)`, `\` on Windows. So no file survived, `matched` stayed empty, and the guard reported every argument. Checked with `path.win32` in Node: `resolve` vs the globbed path false, `relative` of both equal (a `\` argument too).

**Fix:** `namedTestFiles(testFiles, files, path = node:path, root = ROOT)` in `scripts/plan-io.ts` compares `relative(root, resolve(root, file))` with `relative(root, globbed)`, the form the guard already uses; `collectFamily` calls it. `tests/unit/tooling/plan-io.test.ts` runs it under `posix` and `win32` (`C:\repo`, globbed `C:/repo/…`, arguments with `/` and `\`); the Windows case was red with the old comparison (nothing kept, CI's symptom). On Linux `test-plan.ts` with a file argument runs it, and a typo still exits 2. **Verified on `windows-latest` on 2026-11-02** (run 41459385537, a throwaway `spike/windows-file-arg` whose `tests.yaml` passed `tests/browser/pairs/open-retry.test.ts` to `pnpm test`, conformance step dropped; branch deleted after): the plan accepted the argument and ran 5 jobs. That run also turned up a defect of the WriteAhead restart test, below.

**Found by that run, not this follow-up's: the `OPFSWriteAheadVFS` restart test of the same day fails on Windows Firefox `sync`** (`mem:follow-ups/lifecycle-restart-held`): with no announcement from the VFS the holder lets go at `ANNOUNCE_TIMEOUT_MS`, which `BSQ_TIME_SCALE=4` stretches to 4 s, over the library's unscaled `OPEN_RETRY_BUDGET_MS` (2.5 s): the replacement gives up (`WORKER_CRASHED`, `NoModificationAllowedError`, 7.3 s).
