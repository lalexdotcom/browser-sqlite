# Follow-up — `multi-client` bulkWrite interleave on chromium `IDBMirrorVFS/async` — seen, not reproducible (2026-10-07)

**Status: OPEN** — seen once, not reproducible; act at the next sighting.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

`tests/browser/pairs/multi-client.test.ts` :: "two clients writing at once > interleaves a bulkWrite with another client, refusing neither" failed once in the `feat/binary-protocol` matrix: client A read 0 of B's first 2 047-row batch over its 5 s of polling (`expected +0 to be 2047`, test 10.9 s). Replays the same afternoon: the test alone 10/10 on the branch and on `main`; the file under 16 busy loops 15/15 each; the full cell on the branch 1 failure in 5 then 0 in 15 (and 0 in 12 with `debug: true` and a diagnostic of B's `close()` and A's late count), on `main` 0 in 20. Another session's Firefox was loading the machine during the failing runs. Left by the user's decision ("on ignore et on enchaîne, et on consigne"). At the next sighting: rerun the cell with the diagnostic (B's `writer.close()` outcome — a failed batch against a slow one — and A's count after it), and compare with `main` at the same load.
