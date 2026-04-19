#!/usr/bin/env bash
# Internal entry point for the LaunchAgent (macOS) and systemd user
# service (Linux). Not meant to be invoked directly — use:
#   ./relay dev      (foreground with live logs)
#   ./relay start    (load the service)

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

TMUX_SESSION="${TMUX_SESSION:-dev}"

# Create the tmux session if it's missing so the relay always has
# something to attach to on first boot. tmux-bridge self-heals if
# the session dies later, but we need one present now.
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  tmux new-session -d -s "$TMUX_SESSION" -c "$HOME"
fi

exec npm run start
