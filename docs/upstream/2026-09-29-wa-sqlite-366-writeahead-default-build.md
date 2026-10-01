# wa-sqlite #366 — the build `OPFSWriteAheadVFS` works best with, never tested

*2026-09-29 — measured on Chromium 151, in the container*

[pr366]: https://github.com/rhashimoto/wa-sqlite/pull/366
[pr365]: https://github.com/rhashimoto/wa-sqlite/pull/365

**Why this is here.** browser-sqlite runs `OPFSWriteAheadVFS` on the default, synchronous build first. Upstream's suite never ran it there. Nothing is carried in [`patches/`](../../patches) for this: it changes tests only, and our own suite already runs the VFS on that build.

## How it was found

The maintainer asked, on [#365][pr365], why its timings covered the asyncify and jspi builds but not the default one, since `OPFSWriteAheadVFS` exposes only synchronous VFS methods and works best there. The answer was in his suite: three lists decide which builds a VFS is tested on, and all three left this one out.

- `BUILDS` in `test/OPFSWriteAheadVFS.test.js`, the VFS's own tests: `['asyncify', 'jspi']`.
- `api.test.js` and `sql.test.js` list every VFS under `ALL_BUILDS` or `ASYNC_BUILDS`; `OPFSWriteAheadVFS` sat under `ASYNC_BUILDS`, with the VFS that do need an asynchronous build.

He took it as his own oversight and asked for the default build in #365's test. The work was split there: #365 added it to the VFS's own test file, which also covers its read-freshness test; this PR moves the VFS to `ALL_BUILDS` in the other two.

## Measured

First time on that build, all green. On the branch, cut from `master` at `e6e01ae1`:

| file | tests, whole file |
| --- | ---: |
| `test/api.test.js` | 3950 |
| `test/sql.test.js` | 389 |
| whole suite | 5965, 0 failed |

And `test/OPFSWriteAheadVFS.test.js` with `'default'`, on #365's branch: 108 tests, 3 runs of 3, the whole suite 5830.

## Posted upstream

PR [#366][pr366], opened 2026-09-29 from `lalexdotcom:test/writeahead-default-build`, on `master` at `e6e01ae1`. **One commit, two files, +2 / −2.** `master` has moved one commit since, #365's merge, which touches none of those files. Upstream CI on the head commit is green — [run 36525037491](https://github.com/rhashimoto/wa-sqlite/actions/runs/36525037491), `build (20.x)`, the only check.

It does not mention this library, per the standing rule.

## What stays ours

Nothing to carry and nothing to drop at a repin. The leaks found answering the same question went up the same day as their own PRs — [#367](2026-09-29-wa-sqlite-367-writeahead-open-leak.md) for `OPFSWriteAheadVFS`'s write-ahead files, [#368](2026-09-29-wa-sqlite-368-ahp-acquire-leak.md) for `AccessHandlePoolVFS`'s pool, [#369](2026-09-29-wa-sqlite-369-adaptive-open-lock.md) for `OPFSAdaptiveVFS`'s open lock.

## Merged

**Merged on 2026-09-29** by rhashimoto, as `f5b40a22` on `master`.
