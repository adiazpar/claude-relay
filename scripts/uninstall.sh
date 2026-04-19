#!/usr/bin/env bash
# Claude Relay — uninstall. Invoked as './relay uninstall' from the top-level CLI.
#
# Default behavior: removes the service registration AND the in-repo logs
# AND the tmux session (with every process running inside it). This is
# intentional — the usual reason to uninstall is a full teardown. Use
# --keep-tmux to preserve the session.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s)"

DRY_RUN=0
KEEP_TMUX=0

usage() {
  cat <<EOF
Claude Relay — uninstall.

Usage: ./relay uninstall [options]

Options:
  --dry-run       Show what would be removed, touch nothing.
  --keep-tmux     Preserve the tmux session (default: kill it along with
                  every process running inside it).
  -h, --help      Print this message.

What gets removed:
  - The LaunchAgent (macOS) or systemd user service (Linux)
  - In-repo logs at ./logs/
  - Legacy debug logs at ~/.cache/claude-relay/ (if present)
  - The tmux session and every process in it (unless --keep-tmux)

What's left alone:
  - node_modules/ — rm -rf the repo clone to remove.
  - Claude Code CLI — not installed by claude-relay.
  - Tailscale — not installed by claude-relay.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --keep-tmux) KEEP_TMUX=1 ;;
    --help|-h)   usage; exit 0 ;;
    *) echo "error: unknown flag: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

TMUX_SESSION="${TMUX_SESSION:-dev}"

say() { echo "$@"; }
die() { echo "error: $@" >&2; exit 1; }

say ""
say "Claude Relay — uninstalling"
[ "$DRY_RUN" = "1" ] && say "(dry-run mode — nothing will be touched)"
say ""

# --- Delegate to platform uninstaller (DRY_RUN propagates via env) ---
delegate_output=""
run_delegate() {
  local delegate
  case "$OS" in
    Darwin) delegate="$REPO/installers/darwin/uninstall.sh" ;;
    Linux)
      if [ -x "$REPO/installers/linux/uninstall.sh" ]; then
        delegate="$REPO/installers/linux/uninstall.sh"
      else
        die "Linux uninstaller is not available in this build."
      fi
      ;;
    *) die "unsupported OS: $OS" ;;
  esac
  delegate_output="$(DRY_RUN="$DRY_RUN" "$delegate" 2>&1 || true)"
  if [ -n "$delegate_output" ]; then
    say "$delegate_output"
  fi
}

run_delegate

# --- Log cleanup ---
touched_logs=0

# In-repo logs/ dir: launchd.{out,err} captured by the service manager
# plus debug.log[.1] if DEBUG=1 was set at install time.
if [ -d "$REPO/logs" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "Would remove: $REPO/logs/"
  else
    rm -rf "$REPO/logs"
    say "Removed: $REPO/logs/"
    touched_logs=1
  fi
fi

# Legacy location from an earlier build that wrote debug.log under
# ~/.cache/. Silently clean up if present so upgraders don't leave
# orphans behind.
if [ -d "$HOME/.cache/claude-relay" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "Would remove: $HOME/.cache/claude-relay/ (legacy location)"
  else
    rm -f "$HOME/.cache/claude-relay/debug.log"*
    rmdir "$HOME/.cache/claude-relay" 2>/dev/null || true
    say "Removed: $HOME/.cache/claude-relay/ (legacy location)"
    touched_logs=1
  fi
fi

# --- Tmux session (killed by default, preserved only with --keep-tmux) ---
touched_tmux=0
if [ "$KEEP_TMUX" = "1" ]; then
  say ""
  say "Kept tmux session '$TMUX_SESSION' (--keep-tmux)."
  say "    Reattach with: tmux attach -t $TMUX_SESSION"
elif ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  : # nothing to kill, stay silent
elif [ "$DRY_RUN" = "1" ]; then
  say "Would kill: tmux session '$TMUX_SESSION' (and every process in it)"
else
  if tmux kill-session -t "$TMUX_SESSION" 2>/dev/null; then
    say "Killed tmux session '$TMUX_SESSION'"
    touched_tmux=1
  fi
fi

# --- Summary ---
say ""
if [ "$DRY_RUN" = "1" ]; then
  say "Dry run complete — no changes made."
elif [ "$touched_logs" = "0" ] && [ "$touched_tmux" = "0" ] && \
     ! printf '%s\n' "$delegate_output" | grep -q "Removed\|Disabled"; then
  say "No claude-relay installation found. Nothing to remove."
else
  say "Kept (managed outside claude-relay):"
  say "  - node_modules/ (rm -rf the repo clone to remove)"
  say "  - Claude Code CLI (not installed by claude-relay)"
  say "  - Tailscale (not installed by claude-relay)"
fi
say ""
