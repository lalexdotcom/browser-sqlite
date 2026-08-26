# Memory index — `browser-sqlite`

Nine memories, each small enough to read whole. Start with `mem:state`.

| Memory | What it holds | How often it changes |
|---|---|---|
| `mem:state` | Where the work stands, what is owed, what blocks the next release | every session |
| `mem:architecture` | `src/` layout, public surface, load-bearing invariants, scheduling rules | rarely |
| `mem:stack-and-build` | Toolchain, test suites, rslib/`dist` facts, CI, the packaging traps | rarely |
| `mem:vfs` | The nine VFS, the capability table, the default, per-VFS behaviour | per measurement campaign |
| `mem:measurements` | Every number this project owns, with its date and method | per measurement |
| `mem:follow-ups` | The open backlog, one short entry each | ongoing |
| `mem:lessons` | Lessons paid for once; do not relearn them | append only |
| `mem:conventions` | Working rules not already in `AGENTS.md` | rarely |
| `mem:history` | What each wave/branch shipped, in one line | append only |

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
