# Follow-up (idea) — A timed flush — out of rc.4 (user, 2026-08-27)

**Status: IDEA** — not planned.

Part of `mem:follow-ups`; moved out of it on 2026-10-26. One of the designs owed: **an idea, not planned for the short or medium term (user, 2026-09-03)** — keep it, do not present it as pending scope or as "the next thing".

Raised by the user during the back-pressure brainstorm and kept out of the spec, which
records the full argument in its §7. Short form: a timer's memory case is weak — the input
buffer is already bounded at one batch — while its real cost lands on the workload it
targets, since `bulkWrite` commits per batch and a timer on a trickle multiplies commits,
hence OPFS fsyncs, each flush also taking a write lease. What it would buy is latency and
durability: a slow producer's rows reaching SQLite without waiting for `close()`. **The
commit cost the argument turns on is measured**: ~3.4 ms on Chromium/sync and ~5.3 ms on
Chromium/async (`mem:measurements`). That price is what a timer would pay per flush on a
trickle, and it is no longer a deduction.
