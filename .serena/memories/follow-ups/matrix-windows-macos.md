# Follow-up — The matrix on Windows and macOS — later (user, 2026-10-15)

**Status: OPEN** — later (user, 2026-10-15).

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

`matrix.yaml` (every vfs/build pair, 52 cells) runs on `ubuntu-latest` only; `tests.yaml` gives Windows and macOS `pnpm test` (complement mode) and conformance only (spec 2026-10-14, D6). The planner already produces an all-pairs plan; `matrix.yaml` would need a `runs-on` input and `BSQ_TIME_SCALE`. Cost to weigh: on Windows, Firefox's OPFS makes a full matrix take hours.
