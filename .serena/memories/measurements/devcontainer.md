# Measurements — the devcontainer's memory

Part of `mem:measurements`. The setup these numbers bear on: `mem:stack-and-build/devcontainer`.

## DEVCONTAINER-MEMORY (2026-11-02)

**Method.** OrbStack on the user's Mac (arm64), the container's own cgroup: `/sys/fs/cgroup/memory.current` and `memory.stat` (`anon` = processes, `file` = page cache, reclaimable). `free` shows the whole VM (96 GB), not the container. Per process: `ps -eo rss`, which counts shared pages (the `node` binary) once per process, so the sum exceeds the cgroup's `anon`. Serena's servers driven over raw JSON-RPC (stdio, then streamable HTTP) with the same calls: `get_symbols_overview`, `find_symbol`, `find_referencing_symbols` on `createScheduler` (cross-file), diagnostics; RSS read 20 s after.

**One Serena per session, stdio (before).** Per session: Serena's Python ~450-470 MB after ~50 min (166 MB fresh on 1.7.0, 242 MB on 2.1.0), `typescript-language-server` ~30-70 MB, two tsservers ~60 MB each idle and ~190-250 + ~510 MB once the project is loaded, 1.7.0's `typingsInstaller` ~60-90 MB (gone in 2.1.0), `mempalace-mcp` ~65-90 MB, `claude` ~190-280 MB: ~1 GB per session, more once loaded. Three sessions: `memory.current` 5.8 GB. Fresh, project loaded: 1.7.0 1084 MB, 2.1.0 1008 MB per Serena tree.

**One shared server (after).** Each extra Claude session adds ~270 MB of `anon` (`claude` ~240-260 MB, `mempalace-mcp` ~70-90 MB). With two sessions and the project loaded: `anon` 2381 MB on the `typescript` server (Serena 200 MB, tsservers 160 + 474 MB, wrapper 44 MB), **1818 MB on `typescript_tsgo`** (Serena 114 MB, `tsc --lsp` 219 MB). `memory.current` runs ahead of `anon` by the page cache: +494 MB on opening the second session, ~1.5 GB after the probes and installs.

**`typescript` vs `typescript_tsgo`, same calls.** Language server 579 MB (three processes) vs 218 MB (one); first `find_referencing_symbols` 5.23 s vs 0.12 s; diagnostics ~5 s per file on tsgo, 5 s then 0.5 s on tsserver.

**What else weighs, one session, project unloaded (anon 1560 MB).** VS Code's server and extensions ~1.26 GB RSS: the extension host 468 MB, the server 141 MB, the agent host 128 MB, two file watchers 100 MB, Copilot's runtime 60 MB, the GitHub Actions / Markdown / JSON / ESLint language servers 59 + 55 + 50 + 38 MB, port relays 79 MB. ESLint, the Containers extension and Copilot are not in `devcontainer.json` (the user's own VS Code settings, by appearance). Docker-in-Docker ~50 MB, biome daemons ~36 MB.
