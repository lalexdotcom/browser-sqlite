# Memory index — `browser-sqlite`

Each memory is small enough to read whole. Start with `mem:state`. A name with a `/` is a sub-memory of its topic (`mem:measurements/writeahead`); the topic's own memory indexes it.

| Memory | What it holds | How often it changes |
|---|---|---|
| `mem:state` | Where the work stands, what is owed, what blocks the next release | every session |
| `mem:architecture` | `src/` layout, public surface, load-bearing invariants, scheduling rules; the barrier and cross-tab in `mem:architecture/cross-tab` | rarely |
| `mem:stack-and-build` | Toolchain, test suites, rslib/`dist` facts, CI, the packaging traps | rarely |
| `mem:vfs` | The nine VFS, the capability table, the default, per-VFS behaviour | per measurement campaign |
| `mem:measurements` | Every number this project owns, with its date and method — an index of its sub-memories, by theme | per measurement |
| `mem:follow-ups` | The open backlog, one short entry each; `mem:follow-ups/notes` holds what was closed or kept on purpose, `mem:follow-ups/dormant` the entries waiting on an event, `mem:follow-ups/wa-step` the `step()` workstream | ongoing |
| `mem:lessons` | Lessons paid for once; do not relearn them — an index of its sub-memories, by theme | append only |
| `mem:conventions` | Working rules not already in `AGENTS.md` | rarely |
| `mem:git-hooks` | The three git hooks, what they run, what a green hook does not prove | rarely |
| `mem:history` | What each wave/branch shipped, in one line, by month; `mem:history/waves` holds what each merged wave left that the code will not tell you | append only |
| `mem:upstream` | Every report on work sent to wa-sqlite, with its path in `docs/upstream/` | per upstream PR |

## Rules for keeping these usable

- **One fact, one home.** If two memories would state it, one states it and the other
  links. A fact repeated twice drifts within a week — this project has watched it happen
  to a README table and to the default VFS.
- **A number without a date and a method is not a measurement.** It goes in
  `mem:measurements` or it does not go in.
- **A claim with no citable source does not enter a table.** That rule was bought by
  JSPI-1, where an inherited "Chromium-only" survived three README locations and our own
  contradicting measurement.
- **Struck-through history is not kept here.** `git log` and `CHANGELOG.md` cover what
  happened; these memories cover what is true and what cannot be re-derived from the code.
- Reorganized 2026-08-26 from three memories, two of which had grown past 100 000
  characters and could no longer be read in one piece.
- **A memory stays under 40 000 characters (2026-10-03).** Past roughly that size Claude Code stops returning a `read_memory` result inline: 40 400 read whole, 49 500 was diverted to a file, 75 000 failed. Split a topic before it gets there, into sub-memories of about 30 000 that its own memory indexes, and move text rather than rewrite it.
