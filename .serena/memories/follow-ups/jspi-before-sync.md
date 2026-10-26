# Follow-up — `jspi` before `sync` in the build order — to examine (user, 2026-10-05)

**Status: OPEN** — to examine; measurements owed.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

Measured on 2026-10-05 (JSPI-VS-SYNC, `mem:measurements/statement-cache-and-perf`): `jspi` runs row walks as fast as `sync` on Chromium and Firefox, where `async` pays 1.2-1.8×, and it interrupts a running statement with no cross-origin isolation. So declaring `jspi` first on the VFS that list `sync` first (`OPFSWriteAheadVFS`, `OPFSCoopSyncVFS`, `AccessHandlePoolVFS`, `MemoryVFS`) would make the default interruptible where the browser has JSPI, at no measured cost. To weigh before deciding: Safari 27 is not measured; the Firefox figure rests on #375's glue, merged upstream and in the pin since 2026-10-05; `transaction-throughput` on `OPFSWriteAheadVFS`/Chromium read 1.27× with a 1.03-1.94× spread (`MemoryVFS` 0.87×), to re-measure; the open path and memory of `jspi` against `sync` are not measured; and a changed default is a consumer-visible change (CHANGELOG, `VFS.md`'s Builds and Recommendations, the `build` JSDoc — `mem:lessons/claims-and-docs`, "A changed default is described in more places than the spec lists").
