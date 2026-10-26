# Follow-up — Params as an object, bound by name — not designed (user, 2026-10-09)

**Status: OPEN** — not designed.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

`db.read('SELECT … WHERE id = :id', { id: 1 })`: an object as params, today refused with `INVALID_VALUE`. The worker would bind by name — for each statement, `sqlite3_bind_parameter_name(stmt, i)` looked up in the object, a key `id` matching `:id`, `@id` and `$id` (and SQLite reads `#id` too) — because SQLite numbers named parameters per statement in order of first appearance, so no client-side translation to indexes can work across a multi-statement string. Gains for the string form: multi-statement strings bind correctly, and a missing key can throw instead of binding `NULL`. Open: what an extra key does (ignored, or refused once every statement ran), and refusing a positional `?` in a named query; the name→index map could live with the cached statement — measure the lookup. Touches the worker and the protocol, so the full matrix. The `sql` tag does not need it: it uses numbered `?N` (spec 2026-10-08, D11, kept for D14). Positional `?` across statements already binds correctly since `fix/multi-statement-params` (2026-10-09).
