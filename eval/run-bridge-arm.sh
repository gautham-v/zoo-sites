#!/bin/sh
# Runs the Firefox Agent Bridge through the zoo-sites eval as the firefox-devtools-mcp condition's
# server (--mcp-command), so prompt, backend, model, effort and grading are the harness defaults.
# Rows are labelled firefox-devtools-mcp by the harness; they are the bridge's. Usage:
#   eval/run-bridge-arm.sh [extra run.mjs flags, e.g. --task title,form-fill --out ...]
# The bridge needs Firefox with the extension running; it drives that browser, so tasks run one
# at a time (no --parallel-tasks).
# BRIDGE_REPO is a checkout of firefox-agent-bridge. BACKEND and MODEL pick the agent, e.g.
#   BACKEND=anthropic MODEL=claude-haiku-5-5 eval/run-bridge-arm.sh --task title
BRIDGE=${BRIDGE_REPO:-$HOME/Code/personal/firefox-agent-bridge}
NODE=${NODE_BIN:-$(command -v node)}
# BRIDGE_EXPERIMENTS is passed to the bridge as FIREFOX_BRIDGE_EXPERIMENTS (its A/B flags).
BACKEND=${BACKEND:-codex}
MODEL=${MODEL:-gpt-5.6-luna}
[ -f "$BRIDGE/mcp/server.mjs" ] || { echo "set BRIDGE_REPO to a firefox-agent-bridge checkout" >&2; exit 1; }
cd "$(dirname "$0")/.." || exit 1
exec node eval/run.mjs --suite all --backend "$BACKEND" --model "$MODEL" --effort medium \
  --conditions "${CONDITIONS:-firefox-devtools-mcp}" --seed ab-1 \
  --mcp-command "env FIREFOX_BRIDGE_DEVTOOLS=1 ${BRIDGE_EXPERIMENTS:+FIREFOX_BRIDGE_EXPERIMENTS=$BRIDGE_EXPERIMENTS }BRIDGE_PROXY_LOG=${BRIDGE_PROXY_LOG:-/tmp/bridge-proxy.log} $NODE $PWD/eval/bridge-session-server.mjs $BRIDGE/mcp/server.mjs" "$@"
