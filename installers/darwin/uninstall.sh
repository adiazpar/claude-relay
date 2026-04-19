#!/usr/bin/env bash
# Claude Relay — Darwin uninstaller. Invoked by top-level ./uninstall.sh.
#
# Contract with the top-level dispatcher:
# - On a clean system (nothing to remove), exit 0 silently (no stdout).
# - When work is done, print lines starting with "Removed " or "Disabled ".
#   The top-level uses these to distinguish touched-system from
#   clean-system for its summary block.
# - Honor DRY_RUN=1 env: print "Would ..." and exit 0 without touching
#   anything.

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.claude-relay.plist"
LABEL="com.claude-relay"
case "${DRY_RUN:-0}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On) DRY_RUN=1 ;;
  *) DRY_RUN=0 ;;
esac

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
