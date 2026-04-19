#!/bin/bash

# Claude Relay - Start Script
# This script starts the relay server that connects to Claude Code in tmux

set -euo pipefail

trap 'echo "Relay stopped"' EXIT

TMUX_SESSION="${TMUX_SESSION:-dev}"
RELAY_PORT="${PORT:-3001}"

echo "=================================="
echo "     Claude Relay Starter"
echo "=================================="
echo ""

# Refuse to start if the port is already bound — almost always means the
# LaunchAgent is already running the relay as a daemon and the user meant
# to tail its log rather than spawn a second instance that would collide.
# Checking the actual port (rather than the LaunchAgent label) also covers
# the "another start.sh is already running in a different terminal" case.
if lsof -nP -iTCP:"$RELAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $RELAY_PORT is already in use - claude-relay is likely already running."
    echo ""
    case "$(uname -s)" in
        Darwin)
            echo "To check the daemon's state:"
            echo "    launchctl print gui/\$(id -u)/com.claude-relay"
            echo ""
            echo "To stop the daemon so you can run ./start.sh in the foreground:"
            echo "    launchctl unload \$HOME/Library/LaunchAgents/com.claude-relay.plist"
            ;;
        Linux)
            echo "To check the daemon's state:"
            echo "    systemctl --user status claude-relay"
            echo ""
            echo "To stop the daemon so you can run ./start.sh in the foreground:"
            echo "    systemctl --user stop claude-relay"
            ;;
    esac
    echo ""
    echo "To remove the service entirely:"
    echo "    ./uninstall.sh"
    exit 1
fi

# Create the tmux session if it's missing so the relay always has something
# to talk to. The runtime bridge also self-heals if the session dies while
# the relay is running, but we need one on first boot.
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "Tmux session '$TMUX_SESSION' not found - creating fresh session"
    tmux new-session -d -s "$TMUX_SESSION" -c "$HOME"
fi

echo "Using tmux session: $TMUX_SESSION"

# Informational check. Claude Code can be launched from the mobile UI via the
# Start Claude button, so a missing Claude is no longer an error condition.
if tmux capture-pane -t "$TMUX_SESSION" -p | grep -q -E "(Claude|Opus|Sonnet|bypass permissions)"; then
    echo "Claude Code detected in session"
else
    echo "Note: Claude Code not running - use the mobile UI Start Claude button or run 'claude' in a pane"
fi

echo ""
echo "Starting relay server on port $RELAY_PORT..."
echo ""

# Start the relay server
cd "$(dirname "$0")"
exec npm run start
