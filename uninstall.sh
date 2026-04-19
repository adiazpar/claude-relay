#!/usr/bin/env bash
# Claude Relay — top-level uninstall dispatcher.

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

DRY_RUN=0
PURGE=0
YES=0

usage() {
  cat <<EOF
Claude Relay uninstaller.

Usage: ./uninstall.sh [--dry-run] [--purge] [--yes] [--help]

Flags:
  --dry-run   Show what would be removed, touch nothing.
  --purge     Additionally kill the tmux session ('dev' by default;
              overridable via TMUX_SESSION env var). The tmux session
              contains running processes (Claude Code, dev servers) —
              killing it sends SIGHUP to all of them.
  --yes       Skip the --purge confirmation prompt. Required for
              unattended removal.
  --help      Print this message and exit.

Examples:
  ./uninstall.sh                  Remove service registration only.
  ./uninstall.sh --dry-run        Preview without touching anything.
  ./uninstall.sh --purge          Prompt before killing tmux session.
  ./uninstall.sh --purge --yes    Fully automated clean teardown.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --purge)   PURGE=1 ;;
    --yes)     YES=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "error: unknown flag: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

TMUX_SESSION="${TMUX_SESSION:-dev}"

say() { echo "$@"; }
die() { echo "error: $@" >&2; exit 1; }

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
        die "Linux uninstaller is not yet available in this build."
      fi
      ;;
    *) die "unsupported OS: $OS" ;;
  esac
  # Capture output; keep exit code so bash set -e doesn't kill us on a non-zero.
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

# --- Purge tmux session ---
touched_tmux=0
if [ "$PURGE" = "1" ]; then
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    say ""
    say "tmux session '$TMUX_SESSION' does not exist — nothing to purge."
  elif [ "$DRY_RUN" = "1" ]; then
    say ""
    say "Would kill: tmux session '$TMUX_SESSION' (and all its processes)"
  else
    confirm="n"
    if [ "$YES" = "1" ]; then
      confirm="y"
    else
      say ""
      say "About to kill tmux session '$TMUX_SESSION'."
      say "This sends SIGHUP to every process in it — Claude Code, dev servers,"
      say "your shells, everything. Unsaved work will be lost."
      if ! read -r -p "Kill session '$TMUX_SESSION'? [y/N] " confirm; then
        # EOF on stdin (non-interactive invocation without --yes).
        # Treat as "no" — skip the kill but continue to the summary.
        confirm="n"
        say ""
        say "(no TTY — treating as 'no'; rerun with --yes for unattended purge)"
      fi
    fi
    case "$confirm" in
      y|Y|yes|YES)
        if tmux kill-session -t "$TMUX_SESSION" 2>/dev/null; then
          say "Killed tmux session '$TMUX_SESSION'"
        else
          say "tmux session '$TMUX_SESSION' was already gone."
        fi
        touched_tmux=1
        ;;
      *)
        say "Skipped tmux session kill."
        ;;
    esac
  fi
fi

# --- Summary ---
# The delegate's output already says what it did (or didn't do). We just need
# to decide whether to print the Kept block or a "Nothing to remove" message.
say ""
if [ "$DRY_RUN" = "1" ]; then
  say "Dry run complete — no changes made."
elif [ "$touched_logs" = "0" ] && [ "$touched_tmux" = "0" ] && \
     ! printf '%s\n' "$delegate_output" | grep -q "Removed\|Disabled"; then
  say "No claude-relay installation found. Nothing to remove."
else
  say "Kept (managed outside claude-relay):"
  [ "$touched_tmux" = "0" ] && say "  - tmux session '$TMUX_SESSION' (use --purge to kill)"
  say "  - node_modules/ (inside this repo clone — rm -rf the repo to remove)"
  say "  - Claude Code CLI (not installed by claude-relay)"
  say "  - Tailscale (not installed by claude-relay)"
fi
