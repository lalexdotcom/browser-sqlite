# wa-sqlite #348 — TEXT values lose everything after an embedded NUL

*2026-09-16 — [rhashimoto/wa-sqlite#348][pr348], picking up [#331][pr331] by @sbking*

[pr348]: https://github.com/rhashimoto/wa-sqlite/pull/348
[pr331]: https://github.com/rhashimoto/wa-sqlite/pull/331

**Why this is here.** SQLite stores NUL inside a TEXT value, and browser-sqlite hands those values straight to its users. wa-sqlite truncated them at the first NUL, in both directions. @sbking opened [#331][pr331] for two of the four paths in July; rhashimoto requested changes on 19 July and the author has not been back since. This PR picks it up, answers the review, and covers the two paths #331 left out.

## The defect

| | how the NUL was lost |
| --- | --- |
| `bind_text` | passed `-1` as the byte length, so SQLite reads a C string |
| `result_text` | same |
| `column_text` | declared `':s'`, so `cwrap` decodes a C string back |
| `value_text` | same |

Round-tripping `'a\0b'` through any of them yielded `'a'`. The first two were #331's scope; `result_text` and `value_text` mean an application-defined function can neither receive nor return such a value, and were added here — flagged in the PR as droppable if rhashimoto prefers to keep the original scope.

## The interesting part: why the obvious fix is wrong

rhashimoto's review asked why the whole buffer isn't simply passed to `TextDecoder`, instead of the splitting loop #331 used. The answer is that it can be, but only with `ignoreBOM`. **`new TextDecoder()` consumes a leading U+FEFF**, so a value that begins with a byte order mark loses it, and a value that *is* a BOM decodes to `''`. Measured:

| decoder | `char(65279) \|\| 'Before' \|\| char(0) \|\| 'After'` | `char(65279)` |
| --- | --- | --- |
| master (`cwrap ':s'`) | `'﻿Before'` — truncated at the NUL | `'﻿'` |
| `new TextDecoder()` | `'Before\0After'` — BOM eaten | `''` |
| `new TextDecoder('utf-8', { ignoreBOM: true })` | `'﻿Before\0After'` | `'﻿'` |

Emscripten's `UTF8ToString` keeps the BOM because its short-string path decodes by hand rather than through a `TextDecoder`, which is why master passes that case and a naive rewrite would have regressed it. #331's test starts with `char(65279)`, so its own test would have caught the naive version — most likely why its author wrote the loop.

The second review point — `sqlite3_column_text()` returns a null pointer for SQL NULL, which should read as `null` rather than the `''` `cwrap` produced — is applied to `column_text` and `value_text`, with the declared return types widened to `string|null`. `column()` and `value()` are unaffected: they test `SQLITE_NULL` before they get there.

## Verification

[`repro/text-nul-round-trip.mjs`](repro/text-nul-round-trip.mjs) is the standalone harness: thirteen checks over the four paths, runnable against any wa-sqlite checkout. On master seven fail; with the patch all thirteen pass; with the patch but a default `TextDecoder`, the three BOM checks fail.

The project's own suite, `yarn test` with Chromium 151, keeping the new tests and reverting `src/sqlite-api.js` to master to falsify each one:

| | master | the PR |
| --- | --- | --- |
| `api.test.js` | 2156 passed, 56 failed | 2212 passed, 0 failed |
| `callbacks.test.js` | 107 passed, 2 failed | 109 passed, 0 failed |
| whole suite, 13 files | — | 3055 passed, 0 failed |

The 56 are 14 VFS × build combinations. Upstream CI (Chrome 129, which unlike Chromium 151 runs the JSPI build, plus a full Emscripten rebuild and a second `yarn test`) passed in 6 minutes.

## State

Open, mergeable, awaiting review. Two commits, 4 files, +140/−18. browser-sqlite does not carry this one in [`patches/`](../../patches) — the truncation is a correctness bug, not something our own code works around.
