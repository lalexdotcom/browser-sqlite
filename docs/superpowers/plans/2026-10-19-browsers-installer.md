# `browsers.ts` as the only installer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every browser and driver the harnesses use is resolved and installed by `scripts/browsers.ts`, under an inter-process socket lock, published by an atomic rename; WebdriverIO receives exact binary paths and never downloads.

**Architecture:** Two new modules under `scripts/`, each with one job: `install-lock.ts` elects one installer among processes through a local socket (Unix socket / named pipe) and relays its outcome; `browser-cache.ts` builds one installation in a private staging folder, marks it complete and renames it into place. `browsers.ts` composes them into `resolveBrowsers()` and feeds the paths into `browserCapabilities()`; the Vitest projects resolve at browser open through a provider wrapper, the scripts before `remote()`.

**Tech Stack:** Node 24 (`.ts` run directly), `node:net`, `@puppeteer/browsers` 3.2.4, `geckodriver` 7.0.0, WebdriverIO 10.0.2, `@vitest/browser-webdriverio` 5.0.0, Vitest 5 (unit project).

**Spec:** `docs/superpowers/specs/2026-10-19-browsers-installer-design.md` — read it whole before any task.

## Global Constraints

- Branch `build/browsers-installer`, in the main checkout (no worktree). Check the branch in the same command as each commit: `test "$(git branch --show-current)" = build/browsers-installer && git commit …`.
- Serena symbolic tools for every read and edit of a code file (`get_symbols_overview`, `find_symbol`, `replace_symbol_body`, `insert_after_symbol`, `replace_content`); built-in Read/Edit on code only if Serena fails. Never `$1` in a `replace_content` replacement.
- Never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm store prune`, or `pnpm install` — except the single `pnpm add -D --save-exact geckodriver@7.0.0` of Task 3. Run `pnpm exec tsc --noEmit` and `pnpm check` before each commit; if the hook fails, stop and report its output verbatim; after committing, `git log --oneline -1` and `git show --stat HEAD`.
- Conventional Commits, scope `browsers`; English everywhere in files; comments state the fact in one or two lines; a test that pins a behaviour carries a `// Falsifiable: <the wrong implementation> and this goes red.` line, as `tests/unit/tooling/` does.
- Progress and diagnostics of the resolver go to **stderr**; `deps` prints only its package list on stdout.
- Every bound is multiplied by `timeScale()` (`scripts/processes.ts`).
- Nothing in `WDIO_CACHE_DIR` outside the requested installations is deleted (other versions, `geckodriver-0.37.1`, `…self-updated-…` folders stay).
- No `CHANGELOG.md` entry (tooling only).
- Unit tests touch no network and never write into the real `node_modules/.cache/wdio`: a temporary cache dir (`mkdtempSync(join(tmpdir(), …))`) and injected fetchers.

## Review Focus

1. Two processes asking for **different browsers** at once (Chrome in one, Firefox in the other): the waiter sees "ready" for the leader's request, finds its own still missing, and must lead next rather than return or fail. — Task 1 test `re-elects when ready does not cover this request`.
2. **Windows refusing a rename** for a moment (antivirus, indexer holding a fresh file: `EPERM`/`EACCES`/`EBUSY`) must be retried briefly, not reported as a broken install. — Task 2 test `retries a rename refused for a moment`.
3. **The lock path** stays under macOS's 104-byte limit whatever the checkout's depth, and two checkouts get two locks. — Task 1 test `lockPath is short and distinct per cache dir`.
4. **A leader killed mid-download** leaves a staging folder: the next leader removes it and it is never published. — Task 2 test `sweeps a staging folder left by a killed installer`.
5. **`browsers.ts deps` stdout** stays the package list alone on a cold cache, since `post-create.sh` feeds it to `apt-get install`. — Task 3 test `deps prints nothing but packages on stdout` (via the injected resolver's logger: everything goes to `process.stderr`).

---

### Task 1: The inter-process lock — `scripts/install-lock.ts`

**Files:**
- Create: `scripts/install-lock.ts`
- Create: `tests/unit/fixtures/install-lock-child.ts`
- Test: `tests/unit/tooling/install-lock.test.ts`

**Interfaces:**
- Produces:
  - `lockPath(key: string): string` — `\\.\pipe\bsq-browsers-<12 hex>` on win32, else `join(tmpdir(), 'bsq-browsers-<12 hex>.sock')`; the hex is the first 12 of `sha256(resolve(key))`.
  - `interface RunOnceOptions { path: string; done: () => Promise<boolean>; install: () => Promise<void>; installBound: number; waitBound: number; log?: (line: string) => void }`
  - `runOnce(options: RunOnceOptions): Promise<void>` — resolves when `done()` is true after the protocol; rejects with the leader's error or a bound error.
  - `INSTALL_BOUND_MS = 600_000` and `WAIT_MARGIN_MS = 60_000` (exported, unscaled; callers multiply by `timeScale()`).

The protocol (spec § The lock), which the tests pin:

```
runOnce:
  if await done(): return                      # fast path: no socket touched
  loop:
    listen(path)
      ok → LEADER: answer = bounded(installBound, async () => { if !(await done()) await install() })
           write "ready\n" or "error <message>\n" to every connection, held or later, end each; close server
           rethrow the error, else return
      EADDRINUSE → connect(path)
           line "ready"          → if await done() return, else continue loop     # Review Focus 1
           line "error <msg>"    → throw new Error(msg)
           close with no line    → continue loop                                 # leader died
           no line within waitBound → throw "browsers: waited <s> s for the install led by another process (<path>)"
           ECONNREFUSED (POSIX)  → unlink(path), ignore ENOENT; continue loop     # stale socket, spec step 4
           ENOENT                → continue loop                                 # leader just closed
```

The leader's bound error reads `browsers: install did not finish within <s> s`. A waiter's own `waitBound` passed by callers is `installBound + WAIT_MARGIN_MS × scale`.

- [ ] **Step 1: Write the child fixture `tests/unit/fixtures/install-lock-child.ts`.** Run as `node <fixture> <lockPath> <stateDir> <mode> [<item>]`; `mode` is `ok` | `throw` | `hang`; `item` defaults to `a`. `done()` = `existsSync(join(stateDir, item))`. `install()` appends `${process.pid} ${item}\n` to `join(stateDir, 'installs.log')`, writes `join(stateDir, 'started')`, then: `ok` waits 300 ms and creates `join(stateDir, item)`; `throw` throws `new Error('fixture install failed')`; `hang` never resolves. Bounds from env `INSTALL_BOUND_MS` / `WAIT_BOUND_MS` (defaults 5 000 / 8 000). Exit 0 on resolve; on reject print the message to stderr and exit 1.

- [ ] **Step 2: Write the failing tests in `tests/unit/tooling/install-lock.test.ts`.** Spawn children with `spawn(process.execPath, [fixture, …])`, a fresh `stateDir` and a fresh `lockPath(stateDir)` per test; each `it` gets an explicit timeout of `30_000 * timeScale()`.

```ts
it('lockPath is short and distinct per cache dir', () => {
  const a = lockPath(join(tmpdir(), 'x'.repeat(200), 'a'));
  expect(a.length).toBeLessThan(104);
  expect(lockPath('/one/cache')).not.toBe(lockPath('/two/cache'));
  expect(lockPath('/one/cache')).toBe(lockPath('/one/cache'));
});

it('touches no socket when already done', async () => {
  // Falsifiable: listen before checking done() and this rejects (the directory does not exist).
  await expect(runOnce({ path: join(tmpdir(), 'no-such-dir', 's.sock'), done: async () => true,
    install: async () => { throw new Error('never'); }, installBound: 1000, waitBound: 1000 })).resolves.toBeUndefined();
});

it('installs once for five processes on a cold state', async () => {
  // Falsifiable: let every process install and installs.log has five lines.
  const codes = await Promise.all(Array.from({ length: 5 }, () => child(['ok'])));
  expect(codes).toEqual([0, 0, 0, 0, 0]);
  expect(lines(installsLog)).toHaveLength(1);
});

it("hands the leader's error to every waiter", async () => {
  // Falsifiable: close the socket on error without a line and the waiters re-elect and install again.
  const results = await Promise.all(Array.from({ length: 3 }, () => childWithStderr(['throw'])));
  for (const r of results) { expect(r.code).toBe(1); expect(r.stderr).toContain('fixture install failed'); }
  expect(lines(installsLog)).toHaveLength(1);
});

it('takes over from a leader killed mid-install', async () => {
  // Falsifiable: treat a close without a line as "ready" and the waiters exit with no install done.
  const leader = spawnChild(['hang']); await waitForFile(join(stateDir, 'started'));
  const waiters = [child(['ok']), child(['ok'])];
  leader.kill('SIGKILL');
  expect(await Promise.all(waiters)).toEqual([0, 0]);
  expect(existsSync(join(stateDir, 'a'))).toBe(true);
  expect(lines(installsLog)).toHaveLength(2); // the killed one, then exactly one take-over
});

it.skipIf(process.platform === 'win32')('recovers a stale socket file (no stale file exists on Windows named pipes)', async () => {
  // Falsifiable: treat ECONNREFUSED as an error and this child exits 1.
  const leader = spawnChild(['hang']); await waitForFile(join(stateDir, 'started'));
  leader.kill('SIGKILL'); await once(leader, 'exit');
  expect(existsSync(path)).toBe(true);
  expect(await child(['ok'])).toBe(0);
});

it('re-elects when ready does not cover this request', async () => {
  // Falsifiable: return on "ready" without checking done() and item b is never installed.
  const [x, y] = await Promise.all([child(['ok', 'a']), child(['ok', 'b'])]);
  expect([x, y]).toEqual([0, 0]);
  expect(existsSync(join(stateDir, 'a')) && existsSync(join(stateDir, 'b'))).toBe(true);
});

it('fails a leader whose install outlives its bound, and its waiters with it', async () => {
  // Falsifiable: no bound on install() and both children hang until the test times out.
  const env = { INSTALL_BOUND_MS: '500', WAIT_BOUND_MS: '5000' };
  const r = await Promise.all([childWithStderr(['hang'], env), childWithStderr(['hang'], env)]);
  for (const x of r) { expect(x.code).toBe(1); expect(x.stderr).toMatch(/did not finish within/); }
});

it('fails a waiter after its own bound when the leader hangs without its bound firing', async () => {
  // Falsifiable: no waitBound and the waiter hangs.
  const leader = spawnChild(['hang'], { INSTALL_BOUND_MS: '60000' }); await waitForFile(join(stateDir, 'started'));
  const w = await childWithStderr(['ok'], { WAIT_BOUND_MS: '500' });
  leader.kill('SIGKILL');
  expect(w.code).toBe(1); expect(w.stderr).toMatch(/waited .* for the install led by another process/);
});
```

(`child`, `childWithStderr`, `spawnChild`, `waitForFile`, `lines` are local helpers of the test file; `waitForFile` polls every 20 ms.)

- [ ] **Step 3: Run them to verify they fail.** `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/tooling/install-lock.test.ts` — Expected: FAIL, `install-lock.ts` does not exist.

- [ ] **Step 4: Implement `scripts/install-lock.ts`** per the protocol above, with `node:net` only. A connection is read as one `\n`-terminated line. Node removes a Unix socket file on `server.close()`; nothing else unlinks except the `ECONNREFUSED` branch.

- [ ] **Step 5: Run the tests to verify they pass**, then three times more in a row to catch ordering flakes. Same command — Expected: PASS ×4.

- [ ] **Step 6: Commit.** `build(browsers): elect one installer through a local socket`

---

### Task 2: Staged, atomically published installations — `scripts/browser-cache.ts`

**Files:**
- Create: `scripts/browser-cache.ts`
- Test: `tests/unit/tooling/browser-cache.test.ts`

**Interfaces:**
- Consumes: `FIREFOX_POLICIES`, `firefoxPoliciesPath` from `scripts/browsers.ts` (already exported).
- Produces:
  - `interface CacheItem { dir: string; executable: string; policies: boolean; fetch: (target: string) => Promise<void> }` — `dir` is relative to the cache (`chrome/linux_arm-153.0.8010.52`); `executable` is relative to `dir`; `fetch(target)` fills the absolute folder `target` with the installation's content (the layout under `dir`).
  - `MARKER = '.bsq-complete'`
  - `isInstalled(cacheDir: string, item: CacheItem): boolean` — `existsSync(join(cacheDir, item.dir, MARKER))`.
  - `installItem(cacheDir: string, item: CacheItem): Promise<string>` — returns the absolute executable path.
  - `sweepStaging(cacheDir: string): void` — removes `join(cacheDir, '.staging')` entirely.
  - `STAGING = '.staging'`

`installItem` in order: if installed, return the path. If `join(cacheDir, item.dir)` exists unmarked, remove it (`rmSync` recursive; failure → `Error('browsers: cannot remove the incomplete installation <path>: <cause>')`). Create `join(cacheDir, STAGING, randomUUID())` as `staging`; `await item.fetch(staging)`; if `item.policies`, write `FIREFOX_POLICIES` (JSON, 2-space, trailing newline) at `firefoxPoliciesPath(join(staging, item.executable))`; write `MARKER` (empty) in `staging`; `mkdirSync(dirname(final), { recursive: true })`; `renameSync(staging, final)`. On rename failure: if `isInstalled` now holds, remove `staging` and return (the loser); else if the code is `EPERM`/`EACCES`/`EBUSY`, retry every 100 ms up to 2 s (Review Focus 2); else remove `staging` and throw `Error('browsers: cannot publish <final>: <cause>')`. On a `fetch` failure, remove `staging` and rethrow.

- [ ] **Step 1: Write the failing tests.** A fake item writes `bin/tool` (content `'x'`) under `target`, after an optional delay:

```ts
it('publishes the installation with its marker and returns the executable', async () => {
  // Falsifiable: fetch straight into the final folder and a fetch that throws leaves it behind (next test).
  const exe = await installItem(cache, fake());
  expect(exe).toBe(join(cache, 'tool/v1', 'bin', 'tool'));
  expect(isInstalled(cache, fake())).toBe(true);
  expect(readdirSync(join(cache, STAGING))).toEqual([]);
});

it('leaves nothing at the final path when the fetch fails', async () => {
  await expect(installItem(cache, fake({ fail: true }))).rejects.toThrow();
  expect(existsSync(join(cache, 'tool/v1'))).toBe(false);
});

it('does not fetch an installation already marked', async () => {
  // Falsifiable: skip the isInstalled check and the counter reads 2.
  const item = fake(); await installItem(cache, item); await installItem(cache, item);
  expect(item.fetches).toBe(1);
});

it('replaces an installation found without its marker', async () => {
  mkdirSync(join(cache, 'tool/v1/bin'), { recursive: true }); writeFileSync(join(cache, 'tool/v1/bin/tool'), 'half');
  // Falsifiable: accept an existing executable as installed (what @puppeteer/browsers does) and this reads 'half'.
  await installItem(cache, fake());
  expect(readFileSync(join(cache, 'tool/v1/bin/tool'), 'utf8')).toBe('x');
});

it('lets two installers race on one item without damage', async () => {
  // Falsifiable: rethrow the loser's rename error and one of the two rejects.
  const [a, b] = await Promise.all([installItem(cache, fake({ delay: 50 })), installItem(cache, fake({ delay: 80 }))]);
  expect(a).toBe(b); expect(isInstalled(cache, fake())).toBe(true);
  expect(readdirSync(join(cache, STAGING))).toEqual([]);
});

it('writes the Firefox policy before the marker', async () => {
  // Falsifiable: write the policy after the rename and it is missing from what was published.
  await installItem(cache, fake({ policies: true }));
  expect(JSON.parse(readFileSync(firefoxPoliciesPath(join(cache, 'tool/v1', 'bin', 'tool')), 'utf8'))).toEqual(FIREFOX_POLICIES);
});

it('sweeps a staging folder left by a killed installer', () => {
  mkdirSync(join(cache, STAGING, 'dead', 'bin'), { recursive: true });
  sweepStaging(cache);
  expect(existsSync(join(cache, STAGING))).toBe(false);
});

it('retries a rename refused for a moment', async () => { /* Review Focus 2 */ });
```

For the last test, make `installItem` take an optional third parameter `rename: typeof renameSync = renameSync` (test seam), and pass a rename that throws an `EPERM` error twice then delegates; assert it resolves and that the installation is marked. Falsifiable: no retry and it rejects with `cannot publish`.

- [ ] **Step 2: Run to verify they fail.** `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/tooling/browser-cache.test.ts` — Expected: FAIL, module missing.

- [ ] **Step 3: Implement `scripts/browser-cache.ts`** as described above (`node:fs` sync calls; `randomUUID` from `node:crypto`).

- [ ] **Step 4: Run to verify they pass.** Same command — Expected: PASS.

- [ ] **Step 5: Commit.** `build(browsers): stage each installation and publish it by rename`

---

### Task 3: The resolver — `resolveBrowsers()` in `scripts/browsers.ts`

**Files:**
- Modify: `scripts/browsers.ts` (new exports; `deps()` through the resolver)
- Modify: `package.json`, `pnpm-lock.yaml` (`geckodriver` 7.0.0 in `devDependencies`, exact)
- Test: `tests/unit/tooling/browsers.test.ts` (extended)

**Interfaces:**
- Consumes: `lockPath`, `runOnce`, `INSTALL_BOUND_MS`, `WAIT_MARGIN_MS` (Task 1); `CacheItem`, `installItem`, `isInstalled`, `sweepStaging` (Task 2); `timeScale` (`scripts/processes.ts`).
- Produces:
  - `interface BrowserBinaries { browser: string; driver: string }` (absolute paths)
  - `cacheItems(name: BrowserName, env?: NodeJS.ProcessEnv): { browser: CacheItem; driver: CacheItem }` — Chrome: `@puppeteer/browsers` `Browser.CHROME` and `Browser.CHROMEDRIVER` at `browserVersion('chrome', env)`; Firefox: `Browser.FIREFOX` at `browserVersion('firefox', env)` with `policies: true`, and geckodriver at `GECKODRIVER_VERSION` in `dir` `geckodriver/<platform>-<version>`, `executable` `geckodriver-<version>` (`.exe` on win32). A puppeteer item's `dir` and `executable` come from `computeExecutablePath({ cacheDir: '.', … })` split at the installation folder; its `fetch(target)` runs `install({ browser, buildId, cacheDir: <fresh temp dir inside target's parent> })` and moves the installation folder to `target`. geckodriver's `fetch(target)` is `download(GECKODRIVER_VERSION, target)` from `geckodriver`.
  - `interface ResolveOptions { env?: NodeJS.ProcessEnv; cacheDir?: string; items?: typeof cacheItems; log?: (line: string) => void }`
  - `resolveBrowsers(names: readonly BrowserName[], options?: ResolveOptions): Promise<Record<BrowserName, BrowserBinaries>>` — the record holds exactly the requested names. `done` = every item installed; `install` = `sweepStaging`, then `installItem` for each missing item, logging `browsers: installing <dir>` through `log` (default: a write to `process.stderr`); `path = lockPath(cacheDir)`; `installBound = INSTALL_BOUND_MS × timeScale()`, `waitBound = installBound + WAIT_MARGIN_MS × timeScale()`.

- [ ] **Step 1: Add the dependency.** `pnpm add -D --save-exact geckodriver@7.0.0` — Expected: `package.json` lists `"geckodriver": "7.0.0"` under `devDependencies`, and `dependencies` stays absent.

- [ ] **Step 2: Write the failing tests** (fake `items` returning Task 2-style fake items, temp `cacheDir`):

```ts
it('resolves the requested browsers to absolute paths in the cache', async () => {
  const r = await resolveBrowsers(['firefox'], { cacheDir, items: fakeItems });
  expect(Object.keys(r)).toEqual(['firefox']);
  expect(r.firefox.browser.startsWith(cacheDir)).toBe(true);
  expect(r.firefox.driver.startsWith(cacheDir)).toBe(true);
});

it('fetches nothing on a second call', async () => {
  // Falsifiable: skip the done() fast path and the fetch counters read 2.
  await resolveBrowsers(['chrome'], { cacheDir, items: fakeItems });
  await resolveBrowsers(['chrome'], { cacheDir, items: fakeItems });
  expect(fetchCount).toBe(2); // browser + driver, once each
});

it('deps prints nothing but packages on stdout', async () => {
  // Falsifiable: log progress with console.log and stdout carries it.
  const stdout = vi.spyOn(process.stdout, 'write');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await resolveBrowsers(['chrome'], { cacheDir, items: fakeItems });
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr.mock.calls.some(([l]) => String(l).includes('browsers: installing'))).toBe(true);
  stdout.mockRestore(); stderr.mockRestore();
});

it('cacheItems names the pinned versions', () => {
  const c = cacheItems('chrome', {}); const f = cacheItems('firefox', {});
  expect(c.browser.dir).toContain(PINNED.chrome); expect(c.driver.dir).toContain(PINNED.chrome);
  expect(f.browser.dir).toContain(PINNED.firefox); expect(f.browser.policies).toBe(true);
  expect(f.driver.dir).toContain(GECKODRIVER_VERSION); expect(c.browser.policies).toBe(false);
});
```

- [ ] **Step 3: Run to verify they fail.** `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/tooling/browsers.test.ts` — Expected: FAIL, `resolveBrowsers` not exported.

- [ ] **Step 4: Implement** `BrowserBinaries`, `cacheItems`, `ResolveOptions`, `resolveBrowsers` in `scripts/browsers.ts`, and make `deps()` take Chrome's folder from `(await resolveBrowsers(['chrome'])).chrome.browser` instead of its own `install()` call.

- [ ] **Step 5: Run to verify they pass.** Same command — Expected: PASS. Then `node scripts/browsers.ts deps | wc -w` — Expected: a non-zero word count and no `browsers:` line on stdout.

- [ ] **Step 6: Commit.** `build(browsers): resolve every binary through one locked installer`

---

### Task 4: Binary paths in the capabilities, and every caller on them

**Files:**
- Modify: `scripts/browsers.ts` (`browserCapabilities` signature; `installAll` through the resolver)
- Create: `tests/harness/browser-provider.ts`
- Modify: `tests/vitest.config.ts` (`browserProject`'s provider)
- Modify: `scripts/consumer-smoke.ts` (`driveBrowser`)
- Modify: `scripts/bench/check.ts` (`capabilities`, built after resolution in `main`)
- Test: `tests/unit/tooling/browsers.test.ts`, `tests/unit/tooling/browser-provider.test.ts`

**Interfaces:**
- Consumes: `resolveBrowsers`, `BrowserBinaries` (Task 3).
- Produces:
  - `interface BrowserOptions { args?: string[]; prefs?: Record<string, unknown> }`
  - `browserCapabilities(name: BrowserName, binaries: BrowserBinaries, extra?: BrowserOptions, env?: NodeJS.ProcessEnv): WebdriverIO.Capabilities` — Chrome: `goog:chromeOptions: { binary: binaries.browser, args: [<'--js-flags=--expose-gc' under BSQ_EXPOSE_GC=1>, ...extra.args], prefs: extra.prefs }` and `wdio:chromedriverOptions: { binary: binaries.driver }`; Firefox: `moz:firefoxOptions: { binary: binaries.browser, args: extra.args, prefs: extra.prefs }` and `wdio:geckodriverOptions: { geckoDriverVersion: GECKODRIVER_VERSION, binary: binaries.driver }`. `args`/`prefs` keys are omitted when empty/undefined. `browserName` and `browserVersion` as today.
  - `withResolvedCapabilities<P extends { options?: { capabilities?: unknown }; openBrowser(): Promise<unknown> }>(provider: P, browser: BrowserName, resolve?: typeof resolveBrowsers): P` in `tests/harness/browser-provider.ts` — wraps `openBrowser` so that it first awaits `resolve([browser])`, sets `provider.options = { ...provider.options, capabilities: browserCapabilities(browser, r[browser]) }`, then calls the original.
  - `resolvingWebdriverio(browser: BrowserName, options: Omit<Parameters<typeof webdriverio>[0], 'capabilities'>)` in the same file — `webdriverio(options)` with its `providerFactory` wrapped: each provider it creates goes through `withResolvedCapabilities`. `@vitest/browser-webdriverio` 5.0.0 reads `this.options.capabilities` only in `openBrowser()` (`buildCapabilities()`), which is what makes this sufficient.

- [ ] **Step 1: Write the failing tests.** In `browsers.test.ts`, replace the `browserCapabilities` block:

```ts
const bins = { browser: '/c/browser', driver: '/c/driver' };

it('hands WebdriverIO both binaries of each browser', () => {
  // Falsifiable: drop one binary and WebdriverIO downloads it (spec goal 2).
  const c = browserCapabilities('chrome', bins, {}, {});
  expect(c['goog:chromeOptions']?.binary).toBe('/c/browser');
  expect(c['wdio:chromedriverOptions']?.binary).toBe('/c/driver');
  const f = browserCapabilities('firefox', bins, {}, {});
  expect(f['moz:firefoxOptions']?.binary).toBe('/c/browser');
  expect(f['wdio:geckodriverOptions']).toEqual({ geckoDriverVersion: GECKODRIVER_VERSION, binary: '/c/driver' });
});

it("keeps the binary when the caller brings its own options", () => {
  // Falsifiable: spread the caller's options over the key and the binary is lost (bench/check, consumer-smoke).
  const c = browserCapabilities('chrome', bins, { args: ['--headless=new'], prefs: { p: 1 } }, { BSQ_EXPOSE_GC: '1' });
  expect(c['goog:chromeOptions']).toEqual({ binary: '/c/browser', args: ['--js-flags=--expose-gc', '--headless=new'], prefs: { p: 1 } });
});

it('adds --expose-gc to Chrome only under BSQ_EXPOSE_GC=1', () => {
  expect(browserCapabilities('chrome', bins, {}, {})['goog:chromeOptions']).toEqual({ binary: '/c/browser' });
  expect(browserCapabilities('chrome', bins, {}, { BSQ_EXPOSE_GC: '1' })['goog:chromeOptions']?.args).toEqual(['--js-flags=--expose-gc']);
  expect(browserCapabilities('firefox', bins, {}, { BSQ_EXPOSE_GC: '1' })['moz:firefoxOptions']).toEqual({ binary: '/c/browser' });
});
```

In `browser-provider.test.ts`:

```ts
it('resolves the binaries before the browser opens', async () => {
  // Falsifiable: resolve at construction and a unit-only run installs browsers (spec anti-goal 1).
  const calls: string[] = [];
  const fake = { options: { logLevel: 'error' }, async openBrowser() { calls.push('open'); return this.options; } };
  const resolve = async () => { calls.push('resolve'); return { chrome: { browser: '/b', driver: '/d' } } as never; };
  const p = withResolvedCapabilities(fake, 'chrome', resolve);
  expect(calls).toEqual([]);
  const opened = await p.openBrowser() as { capabilities: WebdriverIO.Capabilities; logLevel: string };
  expect(calls).toEqual(['resolve', 'open']);
  expect(opened.capabilities['goog:chromeOptions']?.binary).toBe('/b');
  expect(opened.logLevel).toBe('error');
});
```

- [ ] **Step 2: Run to verify they fail.** `pnpm exec vitest run --config tests/vitest.config.ts --configLoader runner --project unit tests/unit/tooling/browsers.test.ts tests/unit/tooling/browser-provider.test.ts` — Expected: FAIL (signature mismatch, missing module).

- [ ] **Step 3: Implement** the new `browserCapabilities`, `tests/harness/browser-provider.ts`, and the callers:
  - `tests/vitest.config.ts`: `provider: resolvingWebdriverio(browser, { cacheDir: WDIO_CACHE_DIR })`, the `browserCapabilities` import dropped.
  - `consumer-smoke.ts`: `const { chrome } = await resolveBrowsers(['chrome'])` before `remote()`; capabilities `browserCapabilities('chrome', chrome, { args: ['--headless=new'] })`.
  - `bench/check.ts`: the module-level `capabilities` becomes a function of the resolved binaries, called in `main()` after `resolveBrowsers([engine])`, passing the `args` and `prefs` it has today.
  - `installAll`: `const all = await resolveBrowsers(names)` first, then the same session per browser with `browserCapabilities(name, all[name], { args: [<'--headless=new' | '-headless'>] })`; the policy-writing block is removed (Task 2 writes it); the `<name> <version>: ok` line unchanged.

- [ ] **Step 4: Run the unit tests and the typecheck.** The Step 2 command — Expected: PASS. `pnpm exec tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Prove a browser session on the new path.** `node scripts/browsers.ts install` — Expected: on this container's cache (unmarked installs), `browsers: installing …` lines on stderr for the four items, then `chrome 153.0.8010.52: ok` and `firefox 155.0.1: ok`. Run it again — Expected: no `installing` line, the two `ok` lines. Then `pnpm test:chrome` — Expected: green, `Test Files` with no failure.

- [ ] **Step 6: Commit.** `build(browsers): hand WebdriverIO the resolved binaries everywhere`

---

### Task 5: Prove the goals, record, close

**Files:**
- Modify: `.serena/memories/stack-and-build.md` (how browsers are installed), `.serena/memories/follow-ups.md` (close the entry), `.serena/memories/measurements/*` (warm-path cost, the sub-memory that holds tooling timings — find it through `mem:measurements`), `.serena/memories/history/2026-10-19-to-25.md` — through Serena's memory tools only.

- [ ] **Step 1: Anti-goal 1 — a unit run installs nothing.** `mv node_modules/.cache/wdio node_modules/.cache/wdio.aside && pnpm test:unit; ls node_modules/.cache/wdio 2>&1` — Expected: the unit project green, and `ls` reports that `wdio` does not exist. Then `mv node_modules/.cache/wdio.aside node_modules/.cache/wdio`.

- [ ] **Step 2: Cold cache, full run.** Move the cache aside again (never delete it), run `pnpm test` (progress line to the user every 2 minutes, log written to a file, not piped through `tail`). Expected: green, one merged report, each of the four items `installing` exactly once in the log, `firefox/<platform>-stable_155.0.1/**/distribution/policies.json` present, no `geckodriver-*` file at the cache root. Move the original cache back afterwards (the new one replaces it only if the user says so — ask).

- [ ] **Step 3: Warm path cost.** Time `resolveBrowsers(['chrome','firefox'])` on the full cache over 10 runs in one process and over 5 fresh processes (`node -e`); record median and range, date, machine, method in the measurements memory.

- [ ] **Step 4: Delivery gate.** `node scripts/hook-gate.ts delivery --run` — Expected: green; read the report, the `Test Files` line included.

- [ ] **Step 5: Windows and macOS.** Ask the user's go to push the branch; then `gh workflow run tests-windows.yaml --ref build/browsers-installer` and `gh workflow run tests-macos.yaml --ref build/browsers-installer`; Expected: both green (Windows ~30 min). Delete the remote branch after (`git push origin --delete build/browsers-installer`).

- [ ] **Step 6: Memories and commit.** Update the four memories above, read back each edited section, grep them for `$1`, check sizes under 40 000 characters. Commit: `docs(memory): browsers.ts installs every browser and driver`.
