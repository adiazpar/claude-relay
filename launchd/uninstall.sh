#!/bin/bash
# Remove the claude-relay LaunchAgent. After this the relay no longer
# auto-starts at login or auto-restarts on crash; fall back to ./start.sh
# for manual runs.

set -euo pipefail

PLIST_DEST="$HOME/Library/LaunchAgents/com.claude-relay.plist"

if [ ! -f "$PLIST_DEST" ]; then
    echo "No LaunchAgent found at $PLIST_DEST - nothing to uninstall"
    exit 0
fi

# Unload tolerates being called on an already-unloaded agent, but suppress
# the error message either way.
launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
rm "$PLIST_DEST"

echo "claude-relay LaunchAgent removed"
echo "  (log file preserved at \$HOME/Library/Logs/claude-relay.log)"
