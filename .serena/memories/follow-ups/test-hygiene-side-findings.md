# Follow-up — side findings of the relative-duration audit (2026-11-17)

**Status: OPEN** — kept aside by the user ("garde ce que tu as repéré de côté"); none is a relative-duration bet. Found by the four reviewers of the audit (`mem:follow-ups/time-based-tests`, third pass) and not yet checked by hand one by one.

Part of `mem:follow-ups`.

- **`scaled()` on a library input**, against the `TIME_SCALE` rule in `tests/browser/helpers/index.ts` (never a value the test hands the library as its subject): `query-timeout.test.ts:31` (`timeout: scaled(1_000)`), `interrupt.test.ts:176` (`drainTimeout: scaled(2_000)`), `tx-handle.test.ts:309` and `tx-savepoint.test.ts:300` (a transaction `timeout`; both assert the same scaled value back, consistent but against the rule).
- **No `killedStatementRuns` skip with a 20 M statement killed**: `lifecycle.test.ts:283` and `:337`, `delete.test.ts:570` (`AccessHandlePoolVFS`). On Safari ≤ 27.2 a killed `sync` worker runs a WASM loop out holding its OPFS files (WebKit #328618); the 2 M reductions at `lifecycle` 27/138/197/308 exist for that reason.
- **A dead guard**: `concurrency.test.ts:266`, `expect(true).toBe(false)` inside a `try` whose `catch` swallows the assertion error — a call that resolved would still pass.
- **`tx-concurrent.test.ts:253-262`**: the comment says "abandoned mid-flight", but `controller.abort` runs in the same tick as the call, so the write is usually refused before it runs and the "runs on, behind it" path is not exercised (false green only).
- **Stale or orphan comments**: `tx-savepoint.test.ts:123` (a "3 000 000-row insert" doc comment above `ENDLESS_INSERT`), `lifecycle.test.ts:192-197` ("still in flight after the sleep below", no sleep), `stream-write.test.ts:189-191` (the 1 ms deadline "mostly lands during the verdict" — nothing pins it), the `BIG_INSERT` comments' "hundreds of ms" margins never measured off Chromium.
- **Cleanup hygiene**: `debug.test.ts:239` `db.close()` not awaited, `debug.test.ts:67` never closes; most of `transaction.test.ts` closes without `await` (covered by `createTestClient`'s cleanup).
- **Assertions that rely on message ordering** (safe today, break if the library ever answered a stop synchronously): `interrupt.test.ts:103`, `query-timeout.test.ts:42`, `long-query.test.ts:67-69` (a status still not `READY`/`ABORTING` right after a rejection).
