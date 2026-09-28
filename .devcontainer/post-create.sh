#!/usr/bin/env bash
# postCreateCommand: project setup. Agent tooling goes in on-create.sh.
set -euo pipefail

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

# There is no top-level `serena index` and no `--project-root` flag. When it
# creates .serena/project.yml, `project index` asks about each extra language it
# detects, with no non-interactive flag, and fails on a closed stdin with an
# empty error: the n's decline (the default). printf, not yes: yes dies of
# SIGPIPE, which pipefail turns into a failure.
printf 'n\n%.0s' {1..100} | serena project index "$PWD"

# --auto-mine fills the palace (--yes alone still prompts, and a closed stdin
# declines); re-runs skip files already mined. --no-llm: no Ollama here.
mempalace init --yes --auto-mine --no-llm "$PWD"
