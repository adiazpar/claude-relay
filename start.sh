#!/bin/bash

# Claude Relay - Start Script
# This script starts the relay server that connects to Claude Code in tmux

TMUX_SESSION="${TMUX_SESSION:-dev}"
RELAY_PORT="${PORT:-3001}"

echo "=================================="
echo "     Claude Relay Starter"
echo "=================================="
echo ""

# Check if tmux session exists
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "ERROR: Tmux session '$TMUX_SESSION' not found!"
    echo ""
    echo "To set up Claude Code in tmux:"
    echo ""
    echo "  1. Create a new tmux session:"
    echo "     tmux new -s $TMUX_SESSION"
    echo ""
    echo "  2. Navigate to your project:"
    echo "     cd ~/irvin"
    echo ""
    echo "  3. Start Claude Code:"
    echo "     claude"
    echo ""
    echo "  4. Detach from tmux:"
    echo "     Press Ctrl+B, then D"
    echo ""
    echo "  5. Run this script again:"
    echo "     ./start.sh"
    echo ""
    exit 1
fi

echo "Found tmux session: $TMUX_SESSION"

# Check if Claude appears to be running
if tmux capture-pane -t "$TMUX_SESSION" -p | grep -q -E "(Claude|Opus|Sonnet|bypass permissions)"; then
    echo "Claude Code detected in session"
else
    echo "WARNING: Claude Code may not be running in the tmux session"
    echo "         The relay will still start, but you may need to run 'claude' in tmux"
fi

echo ""
echo "Starting relay server on port $RELAY_PORT..."
echo ""

# Start the relay server
cd "$(dirname "$0")"
exec npm run start
