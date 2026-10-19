# `scripts/browsers.ts` as the only installer, under an inter-process lock

Date: 2026-10-19. Branch: `build/browsers-installer`. Background: `mem:follow-ups` § "`browsers.ts` as the only installer, under an inter-process lock".

## Why

Browsers and drivers are downloaded into `node_modules/.cache/wdio` on two paths today:

1. `node scripts/browsers.ts install` (the CI setup action, `.devcontainer/post-create.sh`), which opens one WebdriverIO session per browser and lets WebdriverIO download what it needs, then writes Firefox's `distribution/policies.json` (`DisableAppUpdate`).
2. WebdriverIO itself, at the start of every session, in every process: each Vitest job, `scripts/consumer-smoke.ts`, `scripts/bench/check.ts`. `browserCapabilities` passes only a browser name and a version, so WebdriverIO resolves and downloads the binaries on its own.

On a cold cache, parallel processes download into the same directory at once with no lock between them. The first CI run (2026-10-11) failed on it: one job spawned chromedriver while another was still writing it (`EACCES`). The CI setup action now installs before anything runs in parallel, which hides the race on CI but not locally, and a lock inside `install` alone would not help: the race is on path 2.

Path 2 has a second defect: a Firefox WebdriverIO downloads on demand gets no policy, so a hand launch of it updates itself in place (a `…self-updated-…` folder sits in the container's cache today).

Two facts found while designing, in WebdriverIO 10.0.2 and its dependencies:

- **`@puppeteer/browsers` treats an installation as complete as soon as its folder and executable exist** (`install.js`): an extraction cut short by a crash is reused as if it were whole.
- **`geckodriver` renames its binary into place before `chmod 755`** (`install.js`): another process can see the file and fail to execute it, the same window as the `EACCES` of 2026-10-11.

## Goals — what makes this a success (user, 2026-10-19)

1. **No race.** Parallel processes on a cold cache never step on each other: one installs, the others wait for it. The one exception, accepted: right after a leader's crash, two processes may both install, at the cost of one duplicate download and never of a damaged installation (§ The lock, step 4).
2. **One installer.** Every entry point goes through `browsers.ts`: the Vitest browser projects, `consumer-smoke`, `bench/check`, the CI setup action, `post-create.sh`. WebdriverIO never downloads anything: once the binaries are installed, a session starts with no network.
3. **Firefox always carries its policy.** Every Firefox installed has `DisableAppUpdate` before any process can launch it.
4. **No manual cleanup after a crash.** A process killed at any point (Ctrl-C, OOM, a cancelled CI job) leaves neither a lock that blocks the next run nor a half-written installation that a later run takes as complete.
5. **A failure shows fast and by name.** With no network, or when the installing process fails, the waiting processes stop with a clear message instead of hanging until a job's bound.
6. **The same behaviour on Linux, macOS and Windows**, proven by `tests-windows.yaml` and `tests-macos.yaml`.
7. **The cost on a warm cache is measured and reported** — a measurement, not a design constraint (my call, 2026-10-19).

## Non-goals

- A single install on the launcher side (`scripts/parallel.ts`, `test-plan.ts`) that hands paths to its children. **Rejected by the user (2026-10-14).** Each process resolves its binaries through `browsers.ts` itself.
- A file lock (`mkdir` / `open 'wx'` with a PID check) as a fallback. **Documented here, not implemented (my call, 2026-10-19):** Node's local sockets work on all three platforms; a fallback that never runs rots unseen and doubles what must be tested. If the socket cannot be created, `browsers.ts` fails with a message naming the path.
- Deleting installations `browsers.ts` does not need (other versions, the existing `…self-updated-…` folder). Nothing outside the pinned (or overridden) versions is touched.
- Changing the pins, the `BSQ_CHROME_VERSION` / `BSQ_FIREFOX_VERSION` overrides, `GECKODRIVER_VERSION`, or the CI cache key.
- Safari: `safaridriver` ships with macOS and is never downloaded.

## Anti-goals — a failure even if the race is gone

- `pnpm test:unit`, the pre-commit hook, or any run that opens no browser downloads, installs or waits for anything.
- A lock that outlives its holder and needs a manual delete.
- An installation reused while incomplete, or a Firefox launched without its policy.
- A process that waits forever on a leader that died, or that hides the leader's error behind a timeout.
- A browser test, a matrix cell or a CI job that behaves differently once the binaries are installed (same versions, same arguments, same headless flags).

## The design

### What `browsers.ts` exposes

- **A resolver** (name of the builder's choosing, e.g. `ensureBrowsers(names)`) that returns, for each requested browser, the absolute paths of its browser and its driver in `WDIO_CACHE_DIR`: Chrome for Testing and chromedriver at the Chrome build id; Firefox and geckodriver at `GECKODRIVER_VERSION`. It installs whatever is missing, under the lock below, and returns at once when everything is already installed.
- **`browserCapabilities`** takes those paths and sets them in the capabilities WebdriverIO reads (verified in `@wdio/utils` 10.0.1 `node.js`, `startWebDriver` and `setupPuppeteerBrowser`): `goog:chromeOptions.binary` and `wdio:chromedriverOptions.binary` for Chrome; `moz:firefoxOptions.binary` and `wdio:geckodriverOptions.binary` for Firefox. With all four set, WebdriverIO skips every download. Everything it sets today (`browserVersion`, `geckoDriverVersion`, `--js-flags=--expose-gc` under `BSQ_EXPOSE_GC=1`) stays.
- **`browserCapabilities` takes the caller's own browser options and merges them itself (my call, 2026-10-19).** Today `consumer-smoke.ts`, `bench/check.ts` and `installAll` spread `browserCapabilities()` and then replace `goog:chromeOptions` / `moz:firefoxOptions` whole, which would drop `binary` and let WebdriverIO download again. The caller passes its `args` and `prefs`; `browserCapabilities` merges them with `binary` and its own `args` (arrays concatenated), so no call site can lose a binary. A side effect, accepted: `bench/check` under `BSQ_EXPOSE_GC=1` now keeps `--expose-gc`, which it dropped until now.
- **The CLI** keeps its two commands. `install [list]` goes through the resolver, then opens and closes one headless session per browser as today, and prints the same `<name> <version>: ok` line. `deps` gets Chrome's `deb.deps` through the resolver too.

### Installing

- Chrome, chromedriver and Firefox through `@puppeteer/browsers` `install()` (already a direct dependency), at the build ids `browserVersion()` returns.
- geckodriver through the `geckodriver` package's `download(version, cacheDir)`, the same code WebdriverIO calls today. **`geckodriver` becomes a direct devDependency, pinned to the version WebdriverIO resolves (7.0.0 today)** — my call, 2026-10-19; it is not importable otherwise under pnpm's strict layout. It is already listed in `pnpm.ignoredBuiltDependencies`.
- Firefox's `policies.json` is written as part of Firefox's installation, before it is marked complete (§ Completion).

### Completion — an installation cannot be seen half-made (user, 2026-10-19)

- **Every installation is built in a private staging folder and published by one atomic rename.** The installer works in a fresh staging directory inside `WDIO_CACHE_DIR` (same file system, so the rename is atomic): it downloads and extracts there, makes the binaries executable, writes Firefox's `policies.json`, writes the completion marker, then renames the installation into its final place. Nothing under the final path is ever partly written.
- **Correctness does not depend on the lock.** If two installers ever run at once (§ The lock, step 4), each builds its own staging copy; the first rename wins, the loser finds the final path taken, discards its copy and uses the published one. The worst case is one download too many, never a damaged installation. The lock is there to avoid that duplicate download, not to protect the files.
- **An installation counts only when its completion marker exists**, and the marker is inside what the rename publishes. The marker's name and layout (a file inside each installation folder; geckodriver, a single file in WebdriverIO's layout, may need a folder or a marker beside it) are the builder's choice, provided WebdriverIO's and `@puppeteer/browsers`' own lookups still find the binaries where they look today, and nothing collides with what those packages write.
- Staging folders left by a killed process are removed by the next leader. An installation found at a final path without its marker (made before this change, or by WebdriverIO) is removed and installed again, under the lock; on CI the cache key already changes with `browsers.ts`. A removal that fails (a file held open on Windows) is an error naming the path, not a silent reuse.
- The rename on Windows refuses to replace an existing folder and may fail while another process holds a file in it; "the final path already holds a marked installation" is success for the loser, any other failure is an error naming the path.

### The lock (user, 2026-10-14)

A local socket through `node:net`: a Unix socket file on Linux and macOS, a named pipe (`\\.\pipe\…`) on Windows. The OS releases it when its holder dies, which is the point.

1. **Fast path, no lock.** If every requested installation has its marker, return the paths. This is the warm-cache case and the cost goal 7 measures.
2. **Election.** Otherwise, `listen` on the socket. The process that succeeds is the leader. It checks the markers again (another leader may have finished in between), installs what is missing, then answers every client that connected, and every client that connects later while it is still listening, with either "ready" or an error carrying the leader's message. Then it closes the socket.
3. **Waiting.** A process that gets `EADDRINUSE` connects and waits for the answer. On "ready" it checks the markers itself and returns the paths. On an error it rejects with the leader's message. If the connection closes with no answer (the leader died), it goes back to step 2.
4. **Stale socket file (POSIX).** A leader killed without closing leaves its socket file behind: `listen` then fails with `EADDRINUSE` and `connect` with `ECONNREFUSED`. That combination means nobody holds the lock: unlink the file and go back to step 2. **Known gap, accepted (user, 2026-10-19):** two processes that both saw the stale file can unlink in turn, the second removing the first's fresh socket, and both lead. No guard is added around the unlink; the atomic publication (§ Completion) makes the double leader cost one duplicate download at worst.
5. **Bounds, the leader's first (my call, 2026-10-19).** The leader bounds its own installation: a download that stalls without failing (a hung connection, a proxy) is abandoned at the bound, and the leader answers its clients with that error, so the cause reaches every waiting process (goal 5). A waiting process has a bound too, longer than the leader's by a margin, as a safety net for a leader that hangs without dying; it gives up saying what it was waiting for. Both values are the builder's, both stretched by `BSQ_TIME_SCALE` like every other bound (`scripts/processes.ts`), and the leader's leaves room for a cold install on a slow network.
6. **Progress and diagnostics go to stderr**: `deps` prints its package list on stdout, which `post-create.sh` captures into `apt-get install`.

**Where the socket lives (my call, 2026-10-19):** in `os.tmpdir()`, not in `node_modules`, under a short name derived from a hash of the resolved `WDIO_CACHE_DIR` (e.g. `bsq-browsers-<12 hex>.sock`, and `\\.\pipe\bsq-browsers-<12 hex>` on Windows). A short name stays under macOS's ~104-byte socket path limit, and the temp directory avoids mounted file systems that refuse sockets. The hash keeps two checkouts apart and puts every process of one checkout on the same lock.

### Callers

- **The Vitest browser projects (`tests/vitest.config.ts`).** The paths are not resolved when the config loads: the unit project shares this config, and `pnpm test:unit` and the pre-commit hook must not install anything (anti-goal 1). **Amended 2026-10-19 after the final review (my call):** each browser project resolves its browser in a `globalSetup`, which Vitest runs only for the projects a run selects, and before any browser session starts. Resolving inside `openBrowser()` alone, as first designed, put a cold install inside Vitest's session-connect timeout (60 s × `BSQ_TIME_SCALE`), already counting when `openPage()` calls `openBrowser()`: on a slow network a cold `pnpm test` would time out, kill the install and start it again from nothing. The provider wrapper that resolves before delegating to `openBrowser()` stays, as the place the paths reach the capabilities (`@vitest/browser-webdriverio` 5.0.0 reads its `capabilities` option there, in `buildCapabilities()`); after the `globalSetup` it takes the fast path.
- **`consumer-smoke.ts` and `bench/check.ts`** resolve the paths before their `remote()` call.
- **The CI setup action and `post-create.sh`** keep calling `node scripts/browsers.ts install`, unchanged. On CI the step still installs before anything runs in parallel and warms the cache the action saves.

## Testing

- **Unit tests (`tests/unit/tooling/`)**, with a temporary cache directory and an installer injected in place of the real downloads (no network in the unit project):
  - several processes (real child processes, not promises in one process) resolving at once on an empty cache: the installer runs once, every process gets the same paths;
  - the leader killed mid-install (`SIGKILL`): another process takes over, completes, and nothing is left half-installed;
  - a stale socket file: recovered without manual action (POSIX only; skipped with its reason on Windows);
  - the leader's installer throws: every waiting process rejects with its message;
  - an installation without its marker: removed and installed again;
  - two installers forced to run at once on the same item (the lock bypassed): one publishes, the other discards its staging copy, both return the same complete installation;
  - a staging folder left by a killed installer: removed by the next leader, never published;
  - the warm path opens no socket;
  - `browserCapabilities` with the resolved paths sets all four binaries, and keeps today's keys (the existing tests in `browsers.test.ts` extended).
- **Cold-cache run, locally:** the current cache moved aside (not deleted), then `pnpm test`. The report shows each browser and driver downloaded once, a Firefox with its `policies.json`, and a green run. The cache moved back afterwards.
- **Warm-cache cost:** the time the resolver takes on a full cache, measured and recorded in `mem:measurements` (goal 7).
- **Windows and macOS:** `tests-windows.yaml` and `tests-macos.yaml` dispatched on the branch before the merge (the branch pushed for them, with the user's go, and its remote ref deleted after), both green.
- Delivery: `node scripts/hook-gate.ts delivery --run`, its report read.

## What changes for the consumer

Nothing: tooling only, no `CHANGELOG.md` entry.

## Left to the builder

- The resolver's name and return shape, the marker's name and layout, the wire format of "ready" and of the error, the waiting bound's value.
- How the Vitest projects resolve at browser open (§ Callers), under the constraint stated there.
- How the installer is injected for the unit tests.
- Updating `mem:stack-and-build` (how browsers are installed) and closing the `mem:follow-ups` entry at the end of the work.
