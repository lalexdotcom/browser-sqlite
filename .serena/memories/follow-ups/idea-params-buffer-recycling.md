# Follow-up (idea) — Recycling the params buffer through `done` — an idea, kept out of the binary protocol (user, 2026-10-07)

**Status: IDEA** — not planned.

Part of `mem:follow-ups`; moved out of it on 2026-10-26. One of the designs owed: **an idea, not planned for the short or medium term** — keep it, do not present it as pending scope or as "the next thing".

The worker hands the transferred params buffer back in `done`, the page reuses it for the next send. Measured (BINARY-PROTOCOL, `mem:measurements/binary-protocol`): on 200 writes of a 1 MiB text it halves the peak again over the plain binary path (Chromium 29-40 → 16 MB, Firefox 50-77 → 25 MB), and gains nothing on small queries. Cost: each worker keeps its largest buffer for life (~3 MiB for a 1 MiB text, worst-case sizing), and `done` grows an optional field — so it can be added later without breaking the protocol. If taken up: cap the size kept per worker; the cap is unmeasured.
