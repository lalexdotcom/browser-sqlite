# WebKit 328618 — `Worker.terminate()` does not stop a running WebAssembly function

*2026-10-22 — measured on Safari 26.6.2, 27.0.1 and Technology Preview 254 (GitHub macOS runners, through safaridriver), Safari 27.0.1 and Technology Preview 255 (the user's MacBook Pro M4 Max, macOS 27.0.1), Chrome 153 (container, headless)*

[bug]: https://bugs.webkit.org/show_bug.cgi?id=328618
[bug301520]: https://bugs.webkit.org/show_bug.cgi?id=301520

**Why this is here.** Filed by the user as [WebKit 328618][bug] (component WebAssembly, version Safari Technology Preview). On Safari, a worker the library terminates in the middle of a long statement keeps running that statement, holding its OPFS access handles, so the slot's replacement cannot open the database until the statement ends. Four of the library's tests skip on Safari ≤ 27.0.1 for it (`tests/harness/webkit.ts`, `killedStatementRuns()` in `tests/browser/helpers/index.ts`).

## How it was found

Safari's first runs of the whole suite (`feat/safari-suite`, SAFARI-LIB-SUITE in `mem:measurements/test-browsers/library`) failed seven tests per OS, each killing a worker and reopening its file. Matching WebKit's name for a held file, `InvalidStateError` (`fix/safari-held-file`), fixed the `AccessHandlePoolVFS` ones, whose retry waits 10 s; those on `OPFSWriteAheadVFS`, whose open retry waits 2.5 s, still failed. A throwaway spike (`spike/safari-held`, deleted) then timed, outside the library, how long a terminated worker keeps its handles: about 10 ms idle or writing, but until the end of the loop for a worker spinning in WebAssembly (SAFARI-TERMINATE-WASM, same memory). The killed workers were running `longQuery(20_000_000)`, a WebAssembly loop.

## The reproduction

[`repro/2026-10-22-webkit-328618-terminate-wasm.html`](repro/2026-10-22-webkit-328618-terminate-wasm.html), the report's attachment: one file, two workers from blobs, a hand-assembled WebAssembly counter. Each holder takes a Web Lock and an OPFS sync access handle, then spins ~5 s in a JavaScript loop (3 rounds) or a WebAssembly loop (3 rounds); the page waits 100 ms, calls `terminate()`, and times until the lock is available and the file opens from a second worker. Serve it from `http://localhost` (OPFS needs a secure context) and wait ~40 s.

## Results

ms from `terminate()` until the Web Lock / the file is free, 3 rounds per loop:

| | JavaScript loop | WebAssembly loop (~5 s) |
|---|---|---|
| Safari Technology Preview 255, user's Mac | 11-12 / 1-2 | 4939-5119 / 4945-5121 |
| Safari 27.0.1, user's Mac | 4819-5122 / 4825-5121 | 4893-5240 / 4898-5238 |
| Safari 26.6.2, runner, safaridriver | 12-28 / 6-40 | 4258-6248 / 4262-6244 |
| Safari 27.0.1, runner, safaridriver | 14-28 / 8-35 | 4541-5526 / 4557-5537 |
| Safari Technology Preview 254, runner, safaridriver | 34-111 / 40-107 | 5042-5154 / 5034-5143 |
| Chrome 153, container | ~2000 | ~2000 |

- The WebAssembly loop runs to its end on every Safari, Technology Preview 255 included: that is the report.
- Ordinary Safari 27.0.1 does not stop a JavaScript loop either, while WebDriver sessions and Technology Preview 255 do: the report mentions it as apparently fixed on trunk.
- Chrome stops both after ~2 s.

## What the report said

Title: *Worker.terminate() does not stop a running WebAssembly function; the worker's Web Locks and OPFS access handles stay held until it returns.* It gives the HTML spec's "terminate a worker" (abort the running script), the consequence for a database engine compiled to WebAssembly whose stuck query can only be stopped by terminating its worker without cross-origin isolation, the results above (as lists: Bugzilla renders text in a proportional font), and [301520][bug301520] (a worker's `self.close()` leaving OPFS locked) as a different mechanism. It does not name this library (user).

## What follows for the library

`mem:follow-ups/safari-suite`: the skips stay until a Safari past 27.0.1 is measured; not relying on `terminate()` to stop a busy worker on Safari (interrupting first where the build allows) is a separate, undesigned piece.
