#!/usr/bin/env bash
# Claude Relay — Linux installer. Invoked by scripts/install.sh
# (which itself is invoked by './relay install').
# Renders a systemd user service, enables it, and arranges for it to
# survive SSH logout via `loginctl enable-linger` (recorded with a
# marker file so uninstall can revert without disturbing pre-existing
# linger state).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/claude-relay.service.template"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/claude-relay.service"
STATE_DIR="$HOME/.config/claude-relay"

PORT="${PORT:-3001}"
SESSION="${TMUX_SESSION:-dev}"
DEBUG="${DEBUG:-0}"

# --- 1. Verify systemd ---
if ! pidof systemd >/dev/null 2>&1; then
  echo "error: v1 requires systemd; another init system was detected." >&2
  exit 1
fi

# --- 2. Ensure parent dirs exist ---
mkdir -p "$UNIT_DIR"
mkdir -p "$STATE_DIR"

# --- 3. Compose PATH for the service env ---
SERVICE_PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
if [ -d /home/linuxbrew/.linuxbrew/bin ]; then
  SERVICE_PATH="/home/linuxbrew/.linuxbrew/bin:$SERVICE_PATH"
fi

# --- 4. Render the unit file ---
sed -e "s|{{HOME}}|$HOME|g" \
    -e "s|{{REPO}}|$REPO|g" \
    -e "s|{{PORT}}|$PORT|g" \
    -e "s|{{SESSION}}|$SESSION|g" \
    -e "s|{{DEBUG}}|$DEBUG|g" \
    -e "s|{{PATH}}|$SERVICE_PATH|g" \
    "$TEMPLATE" > "$UNIT"

# --- 5. Reload systemd and start ---
if ! systemctl --user daemon-reload 2>/dev/null; then
  echo "error: systemctl --user daemon-reload failed." >&2
  echo "If this is a fresh SSH login on a minimal server, the user bus may not be running." >&2
  echo "Try: loginctl enable-linger $USER  (then log out and log back in and re-run './relay install')" >&2
  exit 1
fi
systemctl --user enable --now claude-relay.service

# --- 6. Linger (survive SSH logout / reboot) ---
# On systemd < v230, `--value` is unsupported and `show-user` emits
# "Linger=no" instead of just "no". Strip the prefix defensively so
# the comparison below works on both old and new systemd.
linger_raw="$(loginctl show-user "$USER" --property=Linger 2>/dev/null | sed 's/^Linger=//' || echo no)"
if [ "$linger_raw" != "yes" ]; then
  loginctl enable-linger "$USER"
  touch "$STATE_DIR/.enabled-linger"
  echo "Enabled loginctl linger so the relay survives SSH disconnect."
else
  # Pre-existing linger: claude-relay does not own this state.
  # Clear any stale marker from a prior install (when Linger was
  # still 'no'). Without this, uninstall would mistakenly disable
  # the user's manually-set linger.
  rm -f "$STATE_DIR/.enabled-linger"
  echo "loginctl linger already enabled; leaving as-is."
fi

echo "systemd user service installed: $UNIT"
