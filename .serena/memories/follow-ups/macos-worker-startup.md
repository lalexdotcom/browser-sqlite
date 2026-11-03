# Follow-up — Worker startups of 10-15 s on GitHub's macOS 26 runner: the runner's, or the users'? (user, 2026-11-03)

**Status: OPEN** — backlog (user, 2026-11-03); not measured.

Part of `mem:follow-ups`, opened 2026-11-03 after the second macOS 26 matrix run (MATRIX-OS, `mem:measurements/ci-runners`); the tests it failed no longer bound startup by `waitUntil` (`test/macos26-startup`, `mem:follow-ups/macos-ci-instability`).

**Seen.** Run 41654580706, `macos-26`: in `safari · OPFSAdaptiveVFS/async` a worker logged `created`, then `ready` only after its client began closing, more than 10 s later — the test before it in the same page had started and finished in 222 ms; in `chrome · IDBBatchAtomicVFS/async` the startup tests of `lifecycle.test.ts` took 4.1-14.9 s and one waited over 10 s for a worker's open. The same pairs start fast on Linux, Windows and macOS 27. Not seen in the first macOS 26 run, where other tests failed: it varies from run to run.

**The question that decides the next step** (as for TIMER-PROBE-MAC): does a real Mac show such startups? If yes, a Safari or Chrome user on macOS can wait 10 s or more for the first statement — a library subject (what the worker does before `ready`: fetch and compile the WASM, open the VFS, the probes). If no, it is the runner (3 vCPU, two cells at once, slow timers) and `BSQ_TIME_SCALE` or nothing.

**Method to settle it (proposed, not run):** a page served from the container (`scripts/static-server.ts`, port forwarded by VS Code; the user's Mac has no Node — never ask to run Node there) that creates clients one after another on each VFS/build and records, per worker, the time from creation to each `boot` stage and to `ready` (`debug` mode exposes the stages), opened by hand in Chrome, Firefox and Safari on the user's Mac; then the same page on the `macos-26` runner through a throwaway spike, to compare stage by stage.
