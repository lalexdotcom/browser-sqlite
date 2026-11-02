#!/usr/bin/env bash
# postStartCommand, at every container start: one Serena MCP server shared by
# every Claude session (on-create.sh registers its URL), instead of one stdio
# server per session (~1 GB each with its tsserver pair). One project per
# server: sessions working elsewhere than this checkout get its symbols.
# setsid, nohup and closed fds detach it from the lifecycle command, which
# would otherwise wait for it or take it down on exit.
set -euo pipefail
# The lifecycle log shows none of this script's output, and a first rebuild
# once left no server and no trace; this file is where to look.
exec >>/tmp/serena-post-start.log 2>&1
date -Is

port=9121
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/mcp"; then
	echo "already listening on $port"
	exit 0
fi
setsid nohup serena start-mcp-server --context=claude-code --project "$PWD" \
	--transport streamable-http --host 127.0.0.1 --port "$port" --open-web-dashboard false \
	>/tmp/serena-mcp.log 2>&1 </dev/null &
sleep 3
pgrep -af 'serena start-mcp-server' || echo "server gone after 3 s"
