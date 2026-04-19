# Claude Relay

Drive N parallel Claude Code sessions from your phone while your Mac
or Linux host does the work. Multi-pane tmux as mobile tabs, live
server detection, port chips, stop/restart — a remote dev workspace,
not just a chat window.

## What it does

- **Mobile web UI** served over HTTP on a port of your choice (3001 by
  default). Open it on your phone's browser.
- **Multi-pane tabs**: every tmux window is a tab. N parallel Claude
  Code sessions, each in its own working directory, switchable with a
  tap.
- **Live server detection**: when a process in a pane binds a TCP port,
  the chat input swaps for tappable port chips. One tap opens the dev
  server's URL in a new tab.
- **Stop/Restart** detected servers from the mobile UI. Preserves your
  exact invocation (`npm run dev`, `./start.sh`, whatever you typed).
- **Self-healing**: the LaunchAgent (macOS) or systemd user service
  (Linux) restarts the relay on crash. If tmux itself dies, the next
  500ms poll creates a fresh session and the phone reconnects.

## Who this is for

Developers with a Claude Max subscription who want to keep coding
from their phone while walking, commuting, or in a meeting — without
giving up their local workspace.

**Relationship to Anthropic's Remote Control**: Anthropic ships a
first-party feature called Remote Control that lets you drive a local
Claude Code session from the Claude mobile app via an encrypted
bridge. It's simpler to set up and probably the right choice if you
just want one session. Claude Relay differs in that it surfaces N
parallel sessions as tabs with server detection — a workspace, not a
single conversation. The two aren't competing; they solve adjacent
problems.

## Dependencies

claude-relay needs three things installed on the host (Mac or Linux):

### 1. Node.js 20+

- **macOS**
  - Homebrew: `brew install node`
  - MacPorts: `sudo port install nodejs20`
  - Official installer: https://nodejs.org
  - nvm: https://github.com/nvm-sh/nvm
- **Linux**
  - nvm: https://github.com/nvm-sh/nvm *(recommended)*
  - NodeSource: https://github.com/nodesource/distributions
  - Official: https://nodejs.org
  - Arch: `sudo pacman -S nodejs`
  - Distro packages (apt/dnf default) are often older than v20. Prefer
    nvm or NodeSource on Debian/Ubuntu/Fedora.

### 2. tmux

- **macOS**
  - `brew install tmux` / `sudo port install tmux` / `nix-env -iA nixpkgs.tmux`
- **Linux**
  - `sudo apt install tmux` (Debian/Ubuntu)
  - `sudo dnf install tmux` (Fedora/RHEL)
  - `sudo pacman -S tmux` (Arch)
  - `sudo apk add tmux` (Alpine)

### 3. Claude Code CLI (optional but expected)

Install via Anthropic's official docs:
https://docs.claude.com/en/docs/claude-code/setup

Run `claude login` once to authenticate your Max subscription.

The relay will install and run without Claude Code, but the "Start
Claude" button in the UI won't do anything until you install it.

## Reaching the relay from your phone

The relay binds on all network interfaces. You have two realistic
options for reaching it from your phone:

1. **Same Wi-Fi only** (simplest). Open the LAN URL the installer
   prints. Works at home, not on the go.

2. **Anywhere** (recommended). Install [Tailscale](https://tailscale.com/download)
   on both the host and your phone, log into the same account, turn
   both on, and use the Tailscale URL the installer prints. Free for
   personal use.

The installer prints every URL the host responds on — if you use a
different mesh VPN (ZeroTier, Nebula, Netbird) or tunneling tool
(cloudflared, ngrok), its address will appear in the list automatically.

## Install

    git clone https://github.com/YOUR_USERNAME/claude-relay.git
    # Replace YOUR_USERNAME with the fork/mirror you trust.
    cd claude-relay
    ./install.sh

The installer:
1. Detects your OS (macOS or Linux only for v1).
2. Checks for required deps and prints per-platform install commands
   if anything is missing.
3. Runs `npm install`.
4. Installs a LaunchAgent (macOS) or systemd user service (Linux) so
   the relay starts at login and restarts on crash.
5. Health-checks the daemon.
6. Prints the URL to open on your phone.

Configuration via env vars (all optional):

    PORT=4000 TMUX_SESSION=work DEBUG=1 ./install.sh

- `PORT` — default 3001.
- `TMUX_SESSION` — default "dev". The tmux session name the relay binds to.
- `DEBUG=1` — enable debug logging to `~/.cache/claude-relay/debug.log`
  (1 MB rotation, one previous file kept). Default off — zero disk writes.
- `VERBOSE=1` — show full output from noisy sub-commands like `npm install`.

## Uninstall

    ./uninstall.sh               # remove service registration + debug logs
    ./uninstall.sh --dry-run     # show what would be removed, touch nothing
    ./uninstall.sh --purge       # also kill the tmux session (prompts first)
    ./uninstall.sh --purge --yes # unattended: purge without prompt
    ./uninstall.sh --help        # flag documentation

Uninstall leaves alone:
- Your tmux session's running processes (unless `--purge`).
- `node_modules/` inside this repo — delete the repo clone to remove.
- Claude Code CLI — not installed by claude-relay.
- Tailscale — not installed by claude-relay.

## Usage

After install, open the printed URL on your phone. The tabs across the
top are your tmux windows — tap one to switch to it. Typing in the
input area sends to whichever tab is active; the text you see above
is the live pane content.

Run `claude` inside any pane to start a Claude Code session. Start a
dev server in another pane and the input area swaps for tappable port
chips — one tap opens the server's URL in a new browser tab. Stop and
Restart buttons let you bounce a detected server without typing
Ctrl-C.

The relay keeps running via launchd (macOS) or systemd (Linux) — your
tmux session (and everything in it) survives phone disconnects, relay
crashes, and reboots. If you close the phone browser and come back
hours later, everything is where you left it.

## How it works

- **tmux** is a separate daemon that holds your sessions and panes.
  Claude Code runs inside a tmux pane. If the relay process dies,
  launchd/systemd restarts it, and the fresh process reattaches to
  the existing tmux session — your work keeps going.
- **The relay** is a small Node.js HTTP server that exposes the tmux
  session over a WebSocket to a phone browser. It doesn't render
  terminal output in Node; the browser does (for performance).
- **Self-healing**: if the `dev` tmux session is killed externally,
  the relay's 500ms poller detects it and recreates a fresh empty
  session within a second. Phone UI re-attaches automatically.

## Platform support

- macOS (tested on macOS Sonoma and later)
- Linux with systemd (Ubuntu 22.04+, Debian 12+, Fedora, Arch, etc.)

Windows is not supported in v1. (tmux on WSL plus Task Scheduler is a
meaningful second project; tracked but unscheduled.)

## Troubleshooting

- **Can't reach the URL on your phone**: ensure Tailscale is on (or
  you're on the same Wi-Fi as the host). Check the host's firewall
  allows inbound connections on port 3001.
- **Relay restarts in a loop**: run `./start.sh` in the foreground to
  see the error live. Most common cause: tmux or node isn't on the
  service's PATH.
- **Claude session doesn't respond to input**: make sure `claude` is
  installed (`claude --version`). If you installed with `DEBUG=1`, tail
  `~/.cache/claude-relay/debug.log`. Otherwise run `./start.sh` in
  foreground to see output.
- **Service won't start at all**: on Linux, `journalctl --user -u
  claude-relay` shows lifecycle errors regardless of DEBUG. On macOS,
  open Console.app and filter for "com.claude-relay".

## License

The author will pick a license before the first public release —
MIT, Apache-2.0, and BSD-3-Clause are all conventional choices for
Node tooling. Until then, no license is attached.
