# Follow-up — The matrix on Windows and macOS — later (user, 2026-10-15)

**Status: CLOSED** — 2026-11-03, `ci/matrix-os`: `matrix.yaml` a reusable module (`ci.yaml` calls it on Linux), `matrix-<os>.yaml` dispatched by hand on Ubuntu, Windows, macOS 26 and 27 (Safari included on macOS). Windows and macOS 27 green first time; macOS 26 red on runner-speed test failures (`mem:follow-ups/macos-ci-instability`). Wiring in `mem:stack-and-build/ci`, runs in `mem:measurements/ci-runners` (MATRIX-OS). How the OS matrices fit with `tests-<os>.yaml` and the release (a gate or not; conformance/consumer as modules) is left for later (user). History below as written.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

`matrix.yaml` (every vfs/build pair, 52 cells) runs on `ubuntu-latest` only; `tests.yaml` gives Windows and macOS `pnpm test` (complement mode) and conformance only (spec 2026-10-14, D6). The planner already produces an all-pairs plan; `matrix.yaml` would need a `runs-on` input and `BSQ_TIME_SCALE`. Cost to weigh: on Windows, Firefox's OPFS makes a full matrix take hours.
