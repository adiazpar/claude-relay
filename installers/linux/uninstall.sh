#!/usr/bin/env bash
# Claude Relay — Linux uninstaller. Invoked by top-level ./uninstall.sh.

set -euo pipefail

UNIT="$HOME/.config/systemd/user/claude-relay.service"
STATE_DIR="$HOME/.config/claude-relay"
LINGER_MARKER="$STATE_DIR/.enabled-linger"
DRY_RUN="${DRY_RUN:-0}"

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
