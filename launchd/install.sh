#!/bin/bash
# Install the claude-relay LaunchAgent so the relay restarts automatically
# whenever the node process exits (crash, kill, reboot).

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$(dirname "$0")/com.claude-relay.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/com.claude-relay.plist"
LABEL="com.claude-relay"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"

sed -e "s|{{HOME}}|$HOME|g" -e "s|{{REPO}}|$REPO|g" "$TEMPLATE" > "$PLIST_DEST"

# launchctl unload is idempotent-ish; suppress noise if it's not currently loaded.
launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
launchctl load "$PLIST_DEST"

echo "claude-relay LaunchAgent installed"
echo "  plist: $PLIST_DEST"
echo "  log:   $HOME/Library/Logs/claude-relay.log"
echo ""
echo "Uninstall: launchctl unload $PLIST_DEST && rm $PLIST_DEST"
echo "Restart:   launchctl kickstart -k gui/$(id -u)/$LABEL"
