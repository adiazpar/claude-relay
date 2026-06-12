#!/usr/bin/env bash
# Claude Relay — install. Invoked as './relay install' from the top-level CLI.
# Detects OS, verifies deps, runs npm install, delegates to per-OS installer,
# health-checks the daemon, prints the URL to open on the phone.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

# RELAY_PORT, not PORT: the generic PORT namespace is consumed by most
# Node dev servers (Next.js, Vite, ...), so the relay never reads it.
# Snapshot any PORT inherited from the shell first — the doctor check
# below warns about it, and our internal PORT variable would mask it.
STRAY_PORT="${PORT:-}"
PORT="${RELAY_PORT:-7337}"
TMUX_SESSION="${TMUX_SESSION:-dev}"
DEBUG="${DEBUG:-0}"
VERBOSE="${VERBOSE:-0}"

OS="$(uname -s)"

say() { echo "$@"; }
warn() { echo "warning: $@" >&2; }
die() { echo "error: $@" >&2; exit 1; }

install_hint() {
  local tool="$1"
  say ""
  say "  $tool is required but not installed. Install options:"
  case "$OS" in
    Darwin)
      if [ "$tool" = "tmux" ]; then
        say "    brew install tmux         (Homebrew)"
        say "    sudo port install tmux    (MacPorts)"
        say "    nix-env -iA nixpkgs.tmux  (Nix)"
      elif [ "$tool" = "node" ]; then
        say "    brew install node         (Homebrew)"
        say "    Official installer: https://nodejs.org"
        say "    nvm: https://github.com/nvm-sh/nvm"
      fi
      ;;
    Linux)
      if [ "$tool" = "tmux" ]; then
        say "    sudo apt install tmux     (Debian/Ubuntu)"
        say "    sudo dnf install tmux     (Fedora/RHEL)"
        say "    sudo pacman -S tmux       (Arch)"
        say "    sudo apk add tmux         (Alpine)"
      elif [ "$tool" = "node" ]; then
        say "    nvm:        https://github.com/nvm-sh/nvm"
        say "    NodeSource: https://github.com/nodesource/distributions"
        say "    Official:   https://nodejs.org"
        say "    Distro packages are often too old — prefer nvm or NodeSource."
      fi
      ;;
  esac
  say ""
  say "  After installing, re-run: ./relay install"
}

say ""
say "Claude Relay — installing on $OS"
say ""

# -------- OS support --------
case "$OS" in
  Darwin|Linux) ;;
  MINGW*|MSYS*|CYGWIN*) die "on Windows, install with the native CLI: relay.cmd install (from cmd or PowerShell)." ;;
  *) die "this installer supports macOS and Linux (detected: $OS). On Windows use relay.cmd install." ;;
esac

# -------- Required tools --------
command -v tmux >/dev/null 2>&1 || { install_hint tmux; exit 1; }
command -v node >/dev/null 2>&1 || { install_hint node; exit 1; }

node_version="$(node --version | sed 's/^v//')"
node_major="${node_version%%.*}"
if [ "$node_major" -lt 20 ]; then
  warn "Node $node_version detected; claude-relay is tested with 20+. Proceeding anyway."
fi

# -------- Optional tools --------
if ! command -v claude >/dev/null 2>&1; then
  say ""
  say "Note: Claude Code CLI not detected."
  say "The relay will install and run, but the 'Start Claude' button"
  say "won't do anything until you install it:"
  say "  https://docs.claude.com/en/docs/claude-code/setup"
  say ""
fi

if ! command -v tailscale >/dev/null 2>&1; then
  say "Note: Tailscale not detected. See README for transport options."
  say ""
fi

if ! command -v jq >/dev/null 2>&1; then
  say "Note: jq not detected. URL detection will use IPs instead of"
  say "Tailscale MagicDNS names. Install jq for prettier URLs."
  say ""
fi

# -------- Doctor: stray generic PORT in the shell --------
# The relay itself ignores PORT, but other dev servers (Next.js, Vite,
# Express apps) honor it and will all bind to the same port.
if [ -n "$STRAY_PORT" ]; then
  warn "PORT=$STRAY_PORT is present in your shell environment. claude-relay
ignores it (use RELAY_PORT to pick a port), but dev servers in your
projects (Next.js, Vite, etc.) will honor it and can collide with
claude-relay or each other. 'unset PORT' or start a fresh terminal
session if that's not intentional."
  say ""
fi

# -------- Pre-flight: port in use? --------
existing_service() {
  case "$OS" in
    Darwin) launchctl list 2>/dev/null | { grep -c "com.claude-relay" || true; } | grep -q "^[1-9]" ;;
    Linux)  systemctl --user is-enabled claude-relay.service >/dev/null 2>&1 ;;
  esac
}

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if existing_service; then
    say "Port $PORT is bound by an existing claude-relay install. Treating as reinstall."
  else
    die "Port $PORT is in use by another process.

Either stop the other service, or rerun with a different port:
  RELAY_PORT=4000 ./relay install"
  fi
fi

# -------- npm install --------
say "Installing node dependencies..."
cd "$REPO"
if [ "$VERBOSE" = "1" ]; then
  npm install
else
  npm install --silent
fi

# -------- Delegate to platform installer --------
case "$OS" in
  Darwin)
    RELAY_PORT="$PORT" TMUX_SESSION="$TMUX_SESSION" DEBUG="$DEBUG" \
      "$REPO/installers/darwin/install.sh"
    ;;
  Linux)
    RELAY_PORT="$PORT" TMUX_SESSION="$TMUX_SESSION" DEBUG="$DEBUG" \
      "$REPO/installers/linux/install.sh"
    ;;
esac

# -------- Health check --------
say ""
say "Waiting for daemon to bind to port $PORT..."
for i in $(seq 1 30); do
  if curl -sI "http://127.0.0.1:$PORT/api/health" 2>/dev/null | head -n 1 | grep -q "200"; then
    break
  fi
  if [ "$i" = "30" ]; then
    say ""
    say "error: Daemon loaded but didn't bind to port $PORT within 15s."
    case "$OS" in
      Darwin)
        if [ -s "$REPO/logs/launchd.err" ]; then
          say ""
          say "Last 20 lines from $REPO/logs/launchd.err:"
          say "------------------------------------------------------------"
          tail -n 20 "$REPO/logs/launchd.err"
          say "------------------------------------------------------------"
        else
          say "No launchd stderr captured — run './relay dev' to see the error live."
        fi
        ;;
      Linux)
        say ""
        say "Check the systemd journal: journalctl --user -u claude-relay -n 20"
        ;;
    esac
    exit 1
  fi
  sleep 0.5
done

# -------- Print URL --------
say ""
if [ -x "$REPO/scripts/print-url.sh" ]; then
  "$REPO/scripts/print-url.sh" "$PORT"
else
  say "Claude Relay running on port $PORT."
fi

say ""
say "To uninstall: ./relay uninstall"
say ""
