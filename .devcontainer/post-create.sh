#!/usr/bin/env bash
set -euo pipefail

sudo chown -R node:node /ai-tools

pnpm install

# Install Playwright browsers + OS deps for rstest browser mode.
#
# All three engines, on purpose. Chromium alone was the rule until
# 2026-08-24, and it left two backlog items (RWU-1, COOP-1) unanswerable:
# the default VFS's non-Chromium degradation path and OPFSCoopSyncVFS's
# role as a fallback can only be settled by running a non-Chromium engine,
# not by reasoning about WebIDL. ~370 MB and a minute or two more per
# container rebuild buys that evidence.
#
# Caveat to carry: Playwright's Firefox and WebKit are patched builds, not
# the branded browsers, and WebKit on Linux is not Safari. They give real
# engine-level evidence about OPFS and Web Locks; they are not proof about
# shipping Safari. See https://playwright.dev/docs/browsers
#
# `playwright` is declared in the root devDependencies (per the root-only
# test-tooling convention in mem:conventions), so `pnpm exec` from the
# root resolves to the catalog-pinned version. `pnpm dlx` would pull
# Playwright's latest, downloading browsers that the pinned runtime
# cannot launch. https://rstest.rs/guide/browser-mode
pnpm exec playwright install --with-deps chromium firefox webkit

uv tool install -p 3.13 "serena-agent==1.7.0" --prerelease=allow
uv tool install mempalace

claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install superpowers@claude-plugins-official --scope user

claude plugin marketplace add MemPalace/mempalace
claude plugin install mempalace@mempalace --scope user

claude mcp remove serena --scope user 2>/dev/null || true
claude mcp add serena --scope user -- serena start-mcp-server --context=claude-code --project-from-cwd

serena index --project-root "$PWD" 2>/dev/null || true
