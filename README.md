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
  exact invocation (`npm run dev`, `python app.py`, whatever you typed).
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

### Fresh Linux host setup (copy-paste)

Starting from a blank Ubuntu/Debian machine — a new VM, a headless
server, a Raspberry Pi — this installs everything the relay needs:

    sudo apt update
    sudo apt install -y tmux git curl ca-certificates

    # Ubuntu's 'nodejs' apt package is too old. Use NodeSource:
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs

    # Verify
    node --version    # must print v20.x or later
    tmux -V

On Fedora/RHEL, Arch, or Alpine, use the equivalent package manager
(`dnf`, `pacman`, `apk`) — the tool list is the same. The NodeSource
installer works across Debian-family distros.

## Reaching the relay from your phone

The relay binds on all network interfaces. You have two realistic
options:

1. **Same Wi-Fi only** (simplest). Use the "same network" URL the
   installer prints. Works at home, fails on cell / cafe Wi-Fi.

2. **Anywhere** (recommended). Set up Tailscale on the host and the
   phone (walkthrough below) and use the "from anywhere" URL. Free
   for personal use, works across cell carriers and captive portals.

Other transports (ZeroTier, Nebula, Netbird, cloudflared, ngrok)
that add a network interface to the host appear in the URL list
automatically — nothing special to configure.

## Tailscale setup

Tailscale is a free-for-personal-use mesh VPN that stitches your
devices into a private network addressable from anywhere with
internet. This is the usual setup for "drive Claude Code from my
phone while out of the house."

### On the host — macOS

    brew install --cask tailscale
    # OR download the .app from https://tailscale.com/download

Launch Tailscale, log into your account, toggle it on. It lives in
the menu bar.

### On the host — Linux

    curl -fsSL https://tailscale.com/install.sh | sh
    sudo tailscale up          # prints a login URL; auth in any browser
    tailscale ip -4            # should print a 100.x.x.x address

### On your phone

1. Install the Tailscale app (iOS / Android).
2. Log in with the **same account** you used on the host.
3. Toggle the connection on.

### Verify

Run `./relay status` on the host. The URL list should now show a
"Reachable from anywhere" entry with a Tailscale MagicDNS name or
IP. Open that URL on the phone.

**If the phone doesn't pick up the new URL right away**, open the
Tailscale app on the phone and toggle the connection off and back
on. The phone's client refreshes its view of the tailnet.

### Tearing down a Tailscale host

If you're wiping a VM or decommissioning a host that was in your
tailnet, run `sudo tailscale logout` **inside the host** before
destroying it. That unregisters the device cleanly. If you forget,
the device lingers as "offline" in your tailnet — harmless but
cluttering — until you delete it manually at
https://login.tailscale.com/admin/machines.

## Install

    git clone https://github.com/YOUR_USERNAME/claude-relay.git
    # Replace YOUR_USERNAME with the fork/mirror you trust.
    cd claude-relay
    ./relay install

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

    PORT=4000 TMUX_SESSION=work DEBUG=1 ./relay install

- `PORT` — default 3001.
- `TMUX_SESSION` — default "dev". The tmux session name the relay binds to.
- `DEBUG=1` — enable the in-process rotating app log at `./logs/debug.log`
  (1 MB rotation, one previous file kept). Default off. Note: crash
  stderr from the launchd service is always captured to
  `./logs/launchd.err` regardless of DEBUG — stays ~empty when healthy.
- `VERBOSE=1` — show full output from noisy sub-commands like `npm install`.

## Daily commands

The service auto-loads at login and restarts on crash, so most days
you won't touch these. But for when you do:

    ./relay status        # is it running? what URL?
    ./relay restart       # bounce after a git pull
    ./relay stop          # temporarily stop (auto-starts at next login)
    ./relay start         # start it back up
    ./relay dev           # foreground mode with live logs (debugging)
    ./relay help          # full usage

## Uninstall

    ./relay uninstall              # remove service, logs, and tmux session
    ./relay uninstall --dry-run    # show what would be removed, touch nothing
    ./relay uninstall --keep-tmux  # remove service + logs, preserve tmux
    ./relay uninstall --help       # flag documentation

Uninstall leaves alone:
- `node_modules/` inside this repo — `rm -rf` the clone to remove.
- Claude Code CLI — not installed by claude-relay.
- Tailscale — not installed by claude-relay.

All relay-owned state lives in the repo clone (`logs/`, `node_modules/`)
plus the service registration. So after `./relay uninstall`, a plain
`rm -rf claude-relay` of the cloned directory completes the wipe — no
state is left scattered under `~/.cache` or `~/Library`.

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
- **"Same network" URL doesn't work even on the same Wi-Fi**: if
  you're running the relay inside a VM (OrbStack, UTM, VMware) that
  NATs traffic, the VM's "same network" IP is on the hypervisor's
  private subnet, not your physical Wi-Fi. The phone cannot route
  there. Tailscale inside the VM is the fix — install it and use
  the `100.x.x.x` URL.
- **Relay restarts in a loop**: run `./relay dev` to see the error
  live. Most common cause: tmux or node isn't on the service's PATH.
- **Claude session doesn't respond to input**: make sure `claude` is
  installed (`claude --version`). Check `./logs/launchd.err` first for
  the service's own crash trail. If you installed with `DEBUG=1`, also
  tail `./logs/debug.log`. Otherwise run `./relay dev` to see output.
- **Service won't start at all**: on Linux, `journalctl --user -u
  claude-relay` shows lifecycle errors regardless of DEBUG. On macOS,
  open Console.app and filter for "com.claude-relay".

## License

The author will pick a license before the first public release —
MIT, Apache-2.0, and BSD-3-Clause are all conventional choices for
Node tooling. Until then, no license is attached.
