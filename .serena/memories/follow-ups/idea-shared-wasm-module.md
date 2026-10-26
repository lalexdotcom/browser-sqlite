# Follow-up (idea) — One compiled `WebAssembly.Module` for the pool — the premise it waited on is dead

**Status: IDEA** — not planned.

Part of `mem:follow-ups`; moved out of it on 2026-10-26. One of the designs owed: **an idea, not planned for the short or medium term (user, 2026-09-03)** — keep it, do not present it as pending scope or as "the next thing".

Every worker compiles its own copy of the 1.23 MB binary. Sharing one is verified and
priced in `mem:measurements`: the clone is free and arrives usable, but it buys ~2 ms on
Chromium, which overlaps those compiles anyway, and ~8 ms at the default `poolSize` on
Firefox, which does not.

It was carried on the premise that whatever solved multi-tab would improve those numbers —
a coordinator compiles once per **origin** rather than once per client. **That premise is
gone:** rc.5's cross-tab design has no coordinator and cannot have one, because a
SharedWorker cannot open a connection on the four VFS that matter (`mem:architecture/cross-tab`). So the
measured numbers are the whole case, and they do not justify adding a handshake to the open
path — the path GATE-1 and three abort defects were paid for. Reviving it needs no new
measurement, only that table.

**A new argument, Safari (2026-10-23, the user's "voie 2", kept as an idea):** on Safari 26/27 a
worker's wasm instantiation stalls 1-11 s after another worker ran hot wasm (SAFARI-WASM-INSTANTIATE,
`mem:measurements/test-browsers/library`): every restart, and a client opened after heavy queries,
can pay it. If the stall is compilation (unverified), a module compiled once by the page and handed to
the workers would remove it. To measure first: the same variants with a precompiled module (the worker
would need Emscripten's `instantiateWasm` hook; the `wasm` option only locates the file today).
