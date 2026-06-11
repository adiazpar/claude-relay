#!/usr/bin/env bash
# Internal entry point for the LaunchAgent (macOS) and systemd user
# service (Linux). Not meant to be invoked directly — use:
#   ./relay dev      (foreground with live logs)
#   ./relay start    (load the service)
#
# Accepts --port <n> and --session <name>, passed by the generated
# service unit. Both are forwarded to the server as argv — never env
# vars — so a PORT value leaking into anyone's environment can't
# interact with the relay (and vice versa).

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

PORT=7337
SESSION="dev"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)    PORT="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    *) echo "serve.sh: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

# Create the tmux session if it's missing so the relay always has
# something to attach to on first boot. tmux-bridge self-heals if
# the session dies later, but we need one present now.
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -c "$HOME"
fi

exec npm run start -- --port "$PORT" --session "$SESSION"
