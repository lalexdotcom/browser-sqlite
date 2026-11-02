# Follow-up — More `types` values for `bulkWrite()` — not designed (user, 2026-10-06)

**Status: DEFERRED** — 2026-11-02 (user): a new feature, moved after the current release, which is bugfix only. Not designed.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

`types` accepts only `'JSONB'` (spec 2026-10-06, D7). The user sees it later carrying conversions such as `string → number`.
