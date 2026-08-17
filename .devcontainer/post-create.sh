#!/usr/bin/env bash
set -euo pipefail

sudo chown -R node:node /ai-tools

pnpm install

# Install Playwright browsers + OS deps for rstest browser mode.
# Scoped to chromium (the project's target browser; rstest.config.ts
# only enables the Chromium provider). Saves ~200 MB and tens of seconds
# per container rebuild vs the default which installs all browsers.
# `playwright` is declared in the root devDependencies (per the root-only
# test-tooling convention in mem:conventions), so `pnpm exec` from the
# root resolves to the catalog-pinned version. `pnpm dlx` would pull
# Playwright's latest, downloading browsers that the pinned runtime
# cannot launch. https://rstest.rs/guide/browser-mode
pnpm exec playwright install --with-deps chromium

uv tool install -p 3.13 "serena-agent==1.7.0" --prerelease=allow
uv tool install mempalace

claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install superpowers@claude-plugins-official --scope user

claude plugin marketplace add MemPalace/mempalace
claude plugin install mempalace@mempalace --scope user

claude mcp remove serena --scope user 2>/dev/null || true
claude mcp add serena --scope user -- serena start-mcp-server --context=claude-code --project-from-cwd

serena index --project-root "$PWD" 2>/dev/null || true
