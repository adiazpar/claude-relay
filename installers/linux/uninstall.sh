#!/usr/bin/env bash
# Claude Relay — Linux uninstaller. Invoked by scripts/uninstall.sh
# (which itself is invoked by './relay uninstall').
#
# Contract with the top-level dispatcher:
# - On a clean system (nothing to remove), exit 0 silently (no stdout).
# - When work is done, print lines starting with "Removed " or "Disabled ".
#   The top-level uses these to distinguish touched-system from
#   clean-system for its summary block.
# - Honor DRY_RUN=1 env: print "Would ..." and exit 0 without touching
#   anything.

set -euo pipefail

UNIT="$HOME/.config/systemd/user/claude-relay.service"
STATE_DIR="$HOME/.config/claude-relay"
LINGER_MARKER="$STATE_DIR/.enabled-linger"
case "${DRY_RUN:-0}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On) DRY_RUN=1 ;;
  *) DRY_RUN=0 ;;
esac

if [ ! -f "$UNIT" ] && [ ! -f "$LINGER_MARKER" ]; then
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  [ -f "$UNIT" ] && echo "Would disable and remove $UNIT"
  [ -f "$LINGER_MARKER" ] && echo "Would disable loginctl linger for $USER"
  exit 0
fi

if [ -f "$UNIT" ]; then
  systemctl --user disable --now claude-relay.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Removed $UNIT"
fi

if [ -f "$LINGER_MARKER" ]; then
  loginctl disable-linger "$USER" 2>/dev/null || true
  rm -f "$LINGER_MARKER"
  echo "Disabled loginctl linger (was enabled by claude-relay install)"
fi

rmdir "$STATE_DIR" 2>/dev/null || true
