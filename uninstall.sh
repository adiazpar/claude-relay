#!/usr/bin/env bash
# Claude Relay — top-level uninstall dispatcher.
# Delegates to the per-OS uninstaller and prints a summary.
# Flag support (--dry-run, --purge, --yes, --help) is added in Task 9.

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

say() { echo "$@"; }
die() { echo "error: $@" >&2; exit 1; }

say "Claude Relay — uninstalling"
say ""

case "$OS" in
  Darwin) "$REPO/installers/darwin/uninstall.sh" ;;
  Linux)
    if [ -x "$REPO/installers/linux/uninstall.sh" ]; then
      "$REPO/installers/linux/uninstall.sh"
    else
      die "Linux uninstaller is not yet available in this build."
    fi
    ;;
  *) die "unsupported OS: $OS" ;;
esac

# Remove node-level debug log directory if it exists.
if [ -d "$HOME/.cache/claude-relay" ]; then
  rm -f "$HOME/.cache/claude-relay/debug.log"*
  rmdir "$HOME/.cache/claude-relay" 2>/dev/null || true
  say "Removed $HOME/.cache/claude-relay/ (debug logs)"
fi

say ""
say "Kept (managed outside claude-relay):"
say "  - tmux session 'dev' (use --purge flag in a later release to kill)"
say "  - node_modules/ (inside this repo clone — rm -rf the repo to remove)"
say "  - Claude Code CLI (not installed by claude-relay)"
say "  - Tailscale (not installed by claude-relay)"
