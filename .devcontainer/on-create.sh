#!/usr/bin/env bash
# onCreateCommand: agent tooling. Project setup goes in post-create.sh.
set -euo pipefail

sudo chown -R node:node /ai-tools

uv tool install -p 3.13 "serena-agent==1.7.0" --prerelease=allow
uv tool install mempalace

claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install superpowers@claude-plugins-official --scope user

claude plugin marketplace add MemPalace/mempalace
claude plugin install mempalace@mempalace --scope user

claude mcp remove serena --scope user 2>/dev/null || true
claude mcp add serena --scope user -- serena start-mcp-server --context=claude-code --project-from-cwd

# chromadb hardcodes its ONNX model cache to ~/.cache/chroma (no env var), and
# that path is not on the persisted volume: a rebuild re-downloads 79 MB at the
# container's download speed. Link it into /ai-tools instead.
mkdir -p /ai-tools/.cache/chroma
if [ ! -L "$HOME/.cache/chroma" ]; then
  mkdir -p "$HOME/.cache"
  [ -d "$HOME/.cache/chroma" ] && cp -a "$HOME/.cache/chroma/." /ai-tools/.cache/chroma/ && rm -rf "$HOME/.cache/chroma"
  ln -s /ai-tools/.cache/chroma "$HOME/.cache/chroma"
fi
