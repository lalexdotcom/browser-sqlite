#!/usr/bin/env bash
# onCreateCommand: agent tooling. Project setup goes in post-create.sh.
set -euo pipefail

sudo chown -R node:node /ai-tools

uv tool install -p 3.13 "serena-agent==2.1.0" --prerelease=allow
uv tool install mempalace

claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install superpowers@claude-plugins-official --scope user

claude plugin marketplace add MemPalace/mempalace
claude plugin install mempalace@mempalace --scope user

# Serena honours project.yml's ls_specific_settings, which point typescript_tsgo
# at the project's own TypeScript, only for a trusted project.
config="$SERENA_HOME/serena_config.yml"
[ -f "$config" ] || serena init >/dev/null
"$(uv tool dir)/serena-agent/bin/python" - "$config" "$PWD" <<'EOF'
import sys
from ruamel.yaml import YAML
path, root = sys.argv[1:]
yaml = YAML()
with open(path) as f:
    config = yaml.load(f)
patterns = config.get("trusted_project_path_patterns") or []
if root not in patterns:
    patterns.append(root)
    config["trusted_project_path_patterns"] = patterns
    with open(path, "w") as f:
        yaml.dump(config, f)
EOF

claude mcp remove serena --scope user 2>/dev/null || true
# The shared server post-start.sh starts at every container start.
claude mcp add --transport http serena http://127.0.0.1:9121/mcp --scope user

# chromadb hardcodes its ONNX model cache to ~/.cache/chroma (no env var), and
# that path is not on the persisted volume: a rebuild re-downloads 79 MB at the
# container's download speed. Link it into /ai-tools instead.
mkdir -p /ai-tools/.cache/chroma
if [ ! -L "$HOME/.cache/chroma" ]; then
  mkdir -p "$HOME/.cache"
  [ -d "$HOME/.cache/chroma" ] && cp -a "$HOME/.cache/chroma/." /ai-tools/.cache/chroma/ && rm -rf "$HOME/.cache/chroma"
  ln -s /ai-tools/.cache/chroma "$HOME/.cache/chroma"
fi
