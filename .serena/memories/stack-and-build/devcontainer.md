# Devcontainer

Part of `mem:stack-and-build`, moved out of it on 2026-11-02 when that memory neared 40 000 characters. The numbers are in `mem:measurements/devcontainer`.

Ported from `lalexdotcom/claude-scaffold` on 2026-09-28 (identity, `gh`, lifecycle split), not
aligned with it wholesale: the image, the stock browsers (`post-create.sh` installs their system libraries, then the pinned browsers) and the Serena prerelease flag are ours.

- **Agent tooling in `on-create.sh`, project setup in `post-create.sh`.** The Claude Code
  extension starts its MCPs and hooks when VS Code attaches, which is after `onCreateCommand`;
  `waitFor: "postCreateCommand"` holds the window until the project is set up.
- **Commit identity comes from `initializeCommand`, on the host.** VS Code copies the host
  `~/.gitconfig` into the container **once, at creation** — later starts only rewrite its
  `credential.helper` (seen 2026-09-28: a container built 2026-08-17 still held the host file of
  that date). The host file now carries no identity, sets `useConfigOnly`, and delegates through
  `includeIf "gitdir:~/Perso/Workspaces/"`, whose host path never matches in here. So
  `initializeCommand` resolves `user.name`, `user.email` and `credential.https://github.com.username`
  on the host and writes them to this clone's `.git/config`. Commits are `Alexandre LEGOUT`
  since then; the older `my-lalex` ones stay as they are.
- **`gh` gets no credential relay from VS Code; git does.** `post-attach.sh` asks
  `git credential fill` for that account's token and pipes it to `gh auth login --with-token`, at
  every attach, non-fatal. Logged in as `lalexdotcom` since 2026-09-28 (scopes `repo`, `read:org`,
  `workflow`, `gist`, `user`). Anything outward-facing through `gh` — a fork, a comment, a PR —
  waits for the user's go. **`gh` cannot re-request a review upstream** (2026-09-30):
  `requested_reviewers` answers 404 and `gh pr edit --add-reviewer` is refused for lack of
  permission, so that click is the user's.
- **`mempalace init` needs `--auto-mine`: `--yes` answers the entity questions only**, and init
  still asks "Mine this directory now?". During a rebuild stdin is a terminal, so the build waited
  on a prompt that `2>/dev/null` hid. `--no-llm`: there is no Ollama here.
- **There is no `serena index`, only `serena project index`.** The old line ran a missing command
  behind `2>/dev/null || true` and indexed nothing.

## Serena: one shared server, on TypeScript 7 (2026-11-02)

- **One Serena MCP server for every Claude session**, over streamable HTTP on `127.0.0.1:9121`. `post-start.sh` (the `postStartCommand`, every container start) launches it with `setsid nohup`, unless the port already answers; `on-create.sh` registers `claude mcp add --transport http serena http://127.0.0.1:9121/mcp`. Before, each session started its own stdio Serena and tsserver stack, ~1 GB apiece. It needs Serena ≥ 2.0, which tracks sessions itself (`initial_instructions` hands each client its id).
- **One project per server**, `--project` = this checkout: a session working in `.work/wa-sqlite` would get wsqlite's symbols.
- **Calls are serialised across sessions**: a slow call in one session (a 5 s `get_diagnostics_for_file`) holds every other session's calls behind it.
- **If the server is down, every session loses Serena** with `ECONNREFUSED`. Start it with `.devcontainer/post-start.sh`, then "Reconnect" in each session's MCP panel ("Authenticate" is irrelevant: the server has no auth). The MCP config is read at session start only.
- **The first rebuild left no server and no trace.** The lifecycle log showed `postStartCommand` launched, nothing it printed, and no file the script would have created. Not reproduced since (a restart and a rebuild) — the one change in between is that the script now sends its output to `/tmp/serena-post-start.log` (start time, "already listening", whether the server is up 3 s later): read it first if it happens again.
- **Restarting the server by hand: `kill` is not enough.** On SIGTERM uvicorn frees the port, then waits forever for the sessions' open connections; SIGINT did not force it either. `kill -9` the old Python and its language-server children (seen 2026-11-02). A container restart has no such issue.
- **`typescript_tsgo`, not `typescript`** (`.serena/project.yml`): TypeScript 7's `tsc --lsp`, one native process. The `typescript` server is `typescript-language-server` over Serena's own tsserver 5.9.3 — this project's TypeScript 7 ships no `tsserver.js` — and it misreads the project's config: it reported a `--downlevelIteration` error in `src/client.ts` that `tsc` does not. tsgo counts one reference fewer per file than tsserver (the `import` line, by appearance); `rename_symbol` still rewrites the imports. `get_diagnostics_for_file` takes ~5 s per file with tsgo, a fixed wait by appearance.
- **`ls_path: node_modules/.bin/tsc`**, relative: Serena launches the server with `shell=True` from the project root, and `lib/tsc.js` `execve`s into the native binary, so the process is the project's own `@typescript/typescript-<platform>` with no Node in between. **Serena reads a project's `ls_specific_settings` only if the project is trusted**; otherwise it logs a warning and falls back to its own copy (`typescript@7.0.2` under `language_servers/`). `on-create.sh` adds the checkout's root to `trusted_project_path_patterns` in `$SERENA_HOME/serena_config.yml` (ruamel, from Serena's venv; idempotent). The bare root: a `<root>/**` pattern matches only paths below it.
- **Serena 2.x rewrites `.serena/project.yml` on start** (its template's comments and new keys): expect a diff after an upgrade, and commit it with the bump.
- **Upgrading Serena in place under running sessions is unsafe**: `uv tool install --force` replaces the venv the running processes import from lazily. Upgrade through a rebuild.
