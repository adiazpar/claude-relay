#!/usr/bin/env bash
# Install the claude-relay LaunchAgent so the relay restarts automatically
# whenever the node process exits (crash, kill, reboot).

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="$(dirname "$0")/com.claude-relay.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/com.claude-relay.plist"
LABEL="com.claude-relay"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$REPO/logs"

# RELAY_PORT, not PORT: the generic PORT namespace is consumed by most
# Node dev servers, so the relay never reads it.
PORT="${RELAY_PORT:-7337}"
SESSION="${TMUX_SESSION:-dev}"
DEBUG="${DEBUG:-0}"

sed -e "s|{{HOME}}|$HOME|g" \
    -e "s|{{REPO}}|$REPO|g" \
    -e "s|{{PORT}}|$PORT|g" \
    -e "s|{{SESSION}}|$SESSION|g" \
    -e "s|{{DEBUG}}|$DEBUG|g" \
    "$TEMPLATE" > "$PLIST_DEST"

# launchctl unload is idempotent-ish; suppress noise if it's not currently loaded.
launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
launchctl load "$PLIST_DEST"

echo "claude-relay LaunchAgent installed"
echo "  plist: $PLIST_DEST"
