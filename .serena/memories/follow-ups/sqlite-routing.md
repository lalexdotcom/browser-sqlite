# Follow-up — SQLite decides read or write: `run()`, routing by verdict, and read workers that refuse writes

**Status: CLOSED — 2026-10-28, `feat/sqlite-routing` merged into `main` (`mem:history/2026-10-26-to-11-01`).** The parked ideas below stay parked.

Part of `mem:follow-ups`, opened 2026-10-26 (user). Large and breaking, done before `1.0.0` stable on purpose (user: "quitte à faire un gros breaking, autant le faire avant la release de la v1 stable").

**The design is the spec, not this memory:** `docs/superpowers/specs/2026-10-26-sqlite-routing-design.md` (amended during implementation; every decision with its author). The plan: `docs/superpowers/plans/2026-10-27-sqlite-routing.md`. The user asked whether to keep `main` with manual routing; Claude's verdict, not contested: keep the branch once the two deltas are checked (the routing costs 0.05-0.19 ms on a statement's first call per client and nothing in steady state).

## Ideas the user parked (2026-10-27), not in this branch

- **An opt-in that runs a write `stream()`/`chunk()` as a transaction committed only once fully consumed** (pg-cursor-like; holds the write lock during consumption) — "on verra ça en même temps".
- **Detecting a `tx.*` statement awaited inside a `tx.stream()` loop** (it waits for ever): options were refuse at call (false positive: fire-and-collect, then await after the loop), drain to free the connection, or document only. The library already warns on the console after a few seconds and keeps waiting (`API.md`, "A generator you have stopped pulling…") — that earlier decision is where to start. "On verra plus tard."

## Facts established for this workstream, with their sources

- `RETURNING` changes all happen at the first `step`; the commit comes after the last row (SQLite 3.53.0, `trigger.c:1096`, `build.c:178-191`).
- A name that does not resolve at prepare re-reads the schema cookie and recompiles once (`prepare.c:802`, `:857-866`); fooled only by a VFS whose page view lags (`OPFSWriteAheadVFS`), which the barrier covers.
- `stmt_readonly`'s rule (`vdbeaux.c:878-907`); measured 2026-10-27 on all 65 pragmas: `PRAGMA optimize` answers 1 although it writes, the bare `PRAGMA journal_mode` 0 — hence the pragma rule in `src/classify.ts`.
- wa-sqlite's authorizer relay turns a null argument into `""` (`sqlite-api.js`, `UTF8ToString` unconditionally).
- PostgreSQL behaves alike for a `RETURNING` through a portal (all changes at the first `Execute`, rows in a tuplestore); pg-cursor commits at `Sync` — read from memory, not verified in its source.
