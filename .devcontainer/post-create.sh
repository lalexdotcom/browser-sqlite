#!/usr/bin/env bash
set -euo pipefail

sudo chown -R node:node /ai-tools

pnpm install

# Install Playwright browsers + OS deps for rstest browser mode.
#
# Chromium and Firefox, deliberately not WebKit.
#
# Firefox earns its place: it ignores the readwrite-unsafe access-handle
# mode, so it is the only engine here that exercises OPFSAdaptiveVFS's
# degraded path. Measured 2026-08-24 — a second handle on the same file
# throws NoModificationAllowedError, and the suite still passes 102/104.
#
# WebKit was installed on 2026-08-24 and removed the same day. Playwright's
# WebKit on Linux exposes no `navigator.storage` at all — no OPFS, no
# FileSystemHandle, no showDirectoryPicker, only indexedDB — so it cannot
# exercise a single VFS this library ships. It reported 9/104 for one cause,
# not 95 defects. This is a limitation of the Linux port, not of the engine:
# OPFS has been Baseline since March 2023 and shipping Safari has it. A real
# WebKit signal would need Playwright on macOS. Do not re-add it here without
# re-running that check.
#
# Caveat that stands for Firefox: Playwright's build is patched and is not
# the branded browser. See https://playwright.dev/docs/browsers
#
# `playwright` is declared in the root devDependencies (per the root-only
# test-tooling convention in mem:conventions), so `pnpm exec` from the
# root resolves to the catalog-pinned version. `pnpm dlx` would pull
# Playwright's latest, downloading browsers that the pinned runtime
# cannot launch. https://rstest.rs/guide/browser-mode
pnpm exec playwright install --with-deps chromium firefox

uv tool install -p 3.13 "serena-agent==1.7.0" --prerelease=allow
uv tool install mempalace

claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install superpowers@claude-plugins-official --scope user

claude plugin marketplace add MemPalace/mempalace
claude plugin install mempalace@mempalace --scope user

claude mcp remove serena --scope user 2>/dev/null || true
claude mcp add serena --scope user -- serena start-mcp-server --context=claude-code --project-from-cwd

serena index --project-root "$PWD" 2>/dev/null || true

# Serena has `serena index` above; MemPalace had no equivalent, so a rebuilt
# volume left it installed but empty. init is idempotent and writes
# mempalace.yaml, which the workspace bind mount already keeps.
mempalace init --yes "$PWD" 2>/dev/null || true

# chromadb hardcodes its ONNX model cache to ~/.cache/chroma (no env var), and
# that path is not on the persisted volume: a rebuild re-downloads 79 MB at the
# container's download speed. Link it into /ai-tools instead.
mkdir -p /ai-tools/.cache/chroma
if [ ! -L "$HOME/.cache/chroma" ]; then
  mkdir -p "$HOME/.cache"
  [ -d "$HOME/.cache/chroma" ] && cp -a "$HOME/.cache/chroma/." /ai-tools/.cache/chroma/ && rm -rf "$HOME/.cache/chroma"
  ln -s /ai-tools/.cache/chroma "$HOME/.cache/chroma"
fi
