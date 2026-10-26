# Follow-up — wa-sqlite's suite on stock browsers — WebDriver PR accepted, ours to send (Discussion #373, 2026-10-10)

**Status: OPEN** — accepted 2026-10-10; the PR is ours to send.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

**Where it stands.** On the user's go, a top-level comment was posted on rhashimoto/wa-sqlite#373 on 2026-10-08 (discussioncomment-18824045). It revises the plan he had validated, after two days of measurements on the fork (`mem:measurements/test-browsers`). **He accepted it on 2026-10-10 at 18:11 UTC: "Okay, let's see what a WebDriver PR looks like! For CI triggers, I'm fine with just Linux for now." The PR is ours to send.** That reply went unrecorded until 2026-10-14, and this entry said "waiting on him" for four days: **read the thread (`gh api graphql`, discussion comments and their replies) before reporting a Discussion as waiting.** The user's principles behind it are in `mem:conventions` (§ Testing in browsers).

**2026-10-10: he questioned it, and was answered the same day.** He was not convinced that Playwright's browsers fall short for tests of storage, Web Locks and `BroadcastChannel`, asked for cases where Chrome or Safari differ from Playwright's builds, and whether WebDriver is slower than Playwright, and by how much. Answered on the user's go (discussioncomment-18853671), with no new measurement — the user: WebKit and Firefox are justified enough, and uniformity is the reason for Chrome. Chromium: no difference seen, WebDriver for one launcher and one configuration, versions pinnable there too (only Safari follows macOS). WebKit: Playwright's trunk build already has WebKit 324094's fix while Safari 27.0.1 does not; the DataView race shows on Safari 26 only; OPFS depends on Playwright's version and context. Firefox: the Juggler build's `await` cost (FF-PW-AWAIT). Speed: the two launchers not timed against each other; the driver mostly opens pages; the whole suite on stock Chrome through WebDriver takes 2-3 min on Linux runners. **For upstream the runner stays `@web/test-runner`; Vitest is the library's** — the two were mixed up once in drafting (user, 2026-10-10). He answered within the hour (above): WebDriver it is, Linux-only triggers for now.

**What the comment proposes:**
- **Stock browsers through WebDriver** (`@web/test-runner-webdriver`), Playwright dropped, which revisits his answer 1 (Playwright's bundled Chromium). The reason given: test what users run; patched builds are noise.
- **Development:** `yarn test` runs Chrome only by default, and `WTR_BROWSERS` picks others (`chrome,firefox`, plus `safari` on macOS).
- **CI:** one reusable workflow with the steps, and one small workflow per platform: Linux (Chrome, Firefox), Windows (Chrome, Firefox), macOS (Chrome, Firefox, Safari). Triggers are his to choose per platform; the example given is all on a release, Linux on PRs and pushes to master, and any by `workflow_dispatch`. The WASM is built once with `make` and shared by every job.
- **The DataView race** (SAFARI26-DATAVIEW-RACE) goes as its own commit in the test PR, not a PR of its own: only Safari exposes it.
- **`sql_0005` on `IDBMirrorVFS`** is skipped on Safari before 27 with `pending()` and its reason (SAFARI26-IDBMIRROR-KILL).
- **The `readwrite-unsafe` skips** stay as agreed.
- **Windows:** geckodriver comes from the runner, and the docs will tell Windows contributors to install it.
- **Mobile:** iOS Safari can follow the macOS images' simulators (iOS 26 works, iOS 27 refuses). Chrome on Android is not explored, only said possible.

**What his go calls for.** The PR branch, from upstream `master`, in this order:
1. **Test and harness commits:**
   - the capability skips: `vfs_read_freshness` and `sql_0005` on `OPFSWriteAheadVFS` without `FileSystemSyncAccessHandle.prototype.mode`, and `vfs_open_last_error` accepting `InvalidStateError`;
   - `sql_0005` registering each worker's cleanup before its open;
   - `TestContext.create()` rejecting when the worker reports an error;
   - `destroy()` closing the VFS before `terminate()`;
   - the DataView race fix, ported from `68aae811` on the fork;
   - the Safari-before-27 skip, through a `TestContext` helper reading `Version/NN` from the user agent (the same on macOS and iOS).
2. **Config:** `WTR_BROWSERS`, with Chrome as the default.
3. **Workflows:** as proposed above, but only Linux (Chrome, Firefox) is triggered — "just Linux for now" (2026-10-10). Open, for the user: also ship the Windows and macOS workflows on `workflow_dispatch` only, or ship Linux alone with the reusable workflow ready for the others.
4. **Docs:** a "Running the tests" section per OS.

Before opening it, measure reliability: about 10 runs per environment, through `workflow_dispatch` on the fork. Upstream's JSPI flag is not needed on stock Chrome 154.

**Still open:**
- Linux Firefox lost two files at the launcher once in 8 runs, unexplained — on the Linux-only target, so to watch in the reliability runs.
- Windows Firefox has only one complete run.
- iOS 27 simulators refuse WebDriver sessions; the image `20261006` with Safari 27.0.1 is untried.
- The fork's `probe/stock-browsers` (head `437e6de1`, the working WebDriver harness) and `probe/webkit-opfs` (the fork's main clone sits on it, with uncommitted Safari/WebKit probes and results) are throwaway: kept until this PR is sent, then deleted, branches and worktrees (user, 2026-10-23).

**History, compressed.**
- **2026-10-03:** asked, about Firefox.
- **2026-10-04:** he pointed at WebKit and Playwright's private mode.
- **2026-10-05:** we measured WebKit's OPFS in a persistent context and proposed WebKit; he asked for all three browsers by default, with an environment variable to restrict to one.
- **2026-10-06:** design questions (discussioncomment-18773230). He answered: Playwright's Chromium, `WTR_BROWSERS`, drop the pre-build pass, both skips, `create()` rejecting, `destroy()` closing the VFS, one PR.
- **2026-10-07:** confirmed (discussioncomment-18791734).
- **2026-10-08:** revised proposal, stock browsers through WebDriver (discussioncomment-18824045).
- **2026-10-10:** his questions on Playwright's browsers and WebDriver's speed; answered the same day (discussioncomment-18853671); at 18:11 UTC he accepted: "let's see what a WebDriver PR looks like", Linux-only triggers for now.

The Firefox findings that started it (WA-FIREFOX-SQL-HANG): `vfs_read_freshness` and `sql_0005` on `OPFSWriteAheadVFS` assume two connections, which Firefox without `readwrite-unsafe` refuses. Three harness traits then turn that failed open into a hang:
- `sql_0005` registered a worker's cleanup only after its open, so the failed worker was never destroyed;
- `maybeReset` retried `NoModificationAllowedError` for 10 s, then rejected without posting a port;
- `TestContext.create()` waited for ever for that port.

Jasmine's random order decides whether a resetting spec follows the failure. None of this is a VFS defect, and none of it reaches the library.
