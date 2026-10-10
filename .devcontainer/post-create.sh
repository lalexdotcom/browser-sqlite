#!/usr/bin/env bash
# postCreateCommand: project setup. Agent tooling goes in on-create.sh.
set -euo pipefail

pnpm install

# Stock Chrome and Firefox at the versions scripts/browsers.ts pins, driven by
# WebdriverIO. Their system libraries first — Chrome for Testing lists its
# Debian ones in deb.deps, Firefox's are Debian's firefox-esr's — then one
# session in each, which downloads browsers and drivers into
# node_modules/.cache/wdio.
# shellcheck disable=SC2046
sudo apt-get update && sudo apt-get install -y --no-install-recommends $(node scripts/browsers.ts deps)
node scripts/browsers.ts install

# There is no top-level `serena index` and no `--project-root` flag. When it
# creates .serena/project.yml, `project index` asks about each extra language it
# detects, with no non-interactive flag, and fails on a closed stdin with an
# empty error: the n's decline (the default). printf, not yes: yes dies of
# SIGPIPE, which pipefail turns into a failure.
printf 'n\n%.0s' {1..100} | serena project index "$PWD"

# --auto-mine fills the palace (--yes alone still prompts, and a closed stdin
# declines); re-runs skip files already mined. --no-llm: no Ollama here.
mempalace init --yes --auto-mine --no-llm "$PWD"
