#!/usr/bin/env bash
# Claude Relay — Darwin uninstaller. Invoked by top-level ./uninstall.sh.

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.claude-relay.plist"
LABEL="com.claude-relay"
DRY_RUN="${DRY_RUN:-0}"

service_registered() {
  launchctl list 2>/dev/null | { grep -c "$LABEL" || true; } | grep -q "^[1-9]"
}

if [ ! -f "$PLIST" ] && ! service_registered; then
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  [ -f "$PLIST" ] && echo "Would unload and remove $PLIST"
  service_registered && echo "Would unload LaunchAgent $LABEL"
  exit 0
fi

launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $PLIST"
