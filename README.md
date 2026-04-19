# Claude Relay

Drive N parallel Claude Code sessions from your phone while your Mac
or Linux host does the work. Multi-pane tmux as mobile tabs, live
server detection, port chips, stop/restart — a remote dev workspace,
not just a chat window. Built for Claude Max subscribers who want to
keep coding from their phone without giving up their local environment.

## What it does

- **Mobile web UI** served over HTTP on a port of your choice (3001 by
  default). Open it on your phone's browser.
- **Multi-pane tabs**: every tmux window is a tab. N parallel Claude
  Code sessions, each in its own working directory, switchable with a
  tap.
- **Live server detection**: when a process in a pane binds a TCP port,
  the chat input swaps for tappable port chips. One tap opens the dev
  server's URL in a new browser tab.
- **Stop/Restart** detected servers from the mobile UI. Preserves your
  exact invocation (`npm run dev`, `python app.py`, whatever you typed).
- **Self-healing**: the LaunchAgent (macOS) or systemd user service
  (Linux) restarts the relay on crash. If tmux itself dies, the next
  500ms poll creates a fresh session and the phone reconnects.

## Platform support

- **macOS** (Sonoma and later)
- **Linux with systemd** (Ubuntu 22.04+, Debian 12+, Fedora, Arch, Alpine)

Windows is not supported.

## Dependencies

### Node.js 20+

- **macOS**: `brew install node`, `sudo port install nodejs20`, nvm,
  or the [official installer](https://nodejs.org).
- **Linux**: [nvm](https://github.com/nvm-sh/nvm) *(recommended)*,
  [NodeSource](https://github.com/nodesource/distributions), the
  [official installer](https://nodejs.org), or `sudo pacman -S nodejs`
  on Arch. Distro defaults on Debian/Ubuntu/Fedora are usually too
  old — prefer nvm or NodeSource.

### tmux

- **macOS**: `brew install tmux` (or MacPorts / Nix).
- **Linux**:
  - `sudo apt install tmux` (Debian/Ubuntu)
  - `sudo dnf install tmux` (Fedora/RHEL)
  - `sudo pacman -S tmux` (Arch)
  - `sudo apk add tmux` (Alpine)

### Claude Code CLI (optional but expected)

Install via [Anthropic's official docs](https://docs.claude.com/en/docs/claude-code/setup),
then run `claude login` once to authenticate.

The relay installs and runs without it, but the "Start Claude" button
in the UI won't do anything until `claude` is on your PATH.

### Fresh Linux host setup (copy-paste)

Starting from a blank Ubuntu/Debian machine — a new VM, a headless
server, a Raspberry Pi — this installs everything the relay needs:

```bash
sudo apt update
sudo apt install -y tmux git curl ca-certificates

# Ubuntu's 'nodejs' apt package is too old. Use NodeSource:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version    # must print v20.x or later
tmux -V
```

On Fedora/RHEL, Arch, or Alpine, swap `apt` for your distro's package
manager (`dnf`, `pacman`, `apk`). The NodeSource installer works
across all Debian-family distros.

## Reaching the relay from your phone

The relay binds on all network interfaces. You have two realistic
options:

1. **Same Wi-Fi only** — use the "same network" URL the installer
   prints. Works at home, fails on cell or cafe Wi-Fi.
2. **Anywhere** *(recommended)* — set up Tailscale on the host and
   the phone (walkthrough below) and use the "from anywhere" URL.
   Free for personal use, works across cell carriers and captive
   portals.

Other transports (ZeroTier, Nebula, Netbird, cloudflared, ngrok)
that add a network interface to the host appear in the URL list
automatically — nothing special to configure.

## Tailscale setup

Tailscale is a free-for-personal-use mesh VPN that stitches your
devices into a private network addressable from anywhere with
internet. This is the standard setup for driving Claude Code from
your phone while out of the house.

### Host — macOS

```bash
brew install --cask tailscale
# OR download the .app from https://tailscale.com/download
```

Launch Tailscale, log into your account, toggle it on. It lives in
the menu bar.

### Host — Linux

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up      # prints a login URL; auth in any browser
tailscale ip -4        # verify — should print a 100.x.x.x address
```

### Phone

1. Install the Tailscale app (iOS or Android).
2. Log in with the **same account** you used on the host.
3. Toggle the connection on.

### Verify

Run `./relay status` on the host. The URL list should now show a
"Reachable from anywhere" entry with a Tailscale MagicDNS name or
IP. Open that URL on the phone.

If the phone doesn't pick up the new URL right away, open the
Tailscale app and toggle the connection off and back on — the
client refreshes its view of the tailnet.

### Tearing down a Tailscale host

Before wiping a VM or decommissioning a host, run
`sudo tailscale logout` **inside the host**. That unregisters the
device cleanly. If you forget, the device lingers as "offline" in
your tailnet until you delete it manually at
[login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines).

## Install

```bash
git clone https://github.com/YOUR_USERNAME/claude-relay.git
cd claude-relay
./relay install
```

*(Replace `YOUR_USERNAME` with the fork or mirror you trust.)*

The installer detects your OS, checks dependencies, runs
`npm install`, registers a LaunchAgent (macOS) or systemd user
service (Linux) that starts at login and restarts on crash,
health-checks the daemon, and prints the URL for your phone.

### Configuration

All environment variables are optional:

```bash
PORT=4000 TMUX_SESSION=work DEBUG=1 ./relay install
```

| Variable       | Default | Description                                                                     |
| -------------- | ------- | ------------------------------------------------------------------------------- |
| `PORT`         | `3001`  | Port the daemon binds to.                                                       |
| `TMUX_SESSION` | `dev`   | Tmux session name the relay attaches to.                                        |
| `DEBUG`        | `0`     | If `1`, write a rotating app log to `./logs/debug.log` (1 MB rotation, one backup). |
| `VERBOSE`      | `0`     | If `1`, show full output from noisy sub-commands like `npm install`.           |

Crash output from the service manager is always captured to
`./logs/launchd.err` (macOS) or the systemd journal (Linux),
regardless of `DEBUG`.

## Daily commands

The service auto-loads at login and restarts on crash, so most days
you won't touch these. But for when you do:

```bash
./relay status        # is it running? what URL?
./relay restart       # bounce after a git pull
./relay stop          # temporarily stop (auto-starts at next login)
./relay start         # start it back up
./relay dev           # foreground mode with live logs (debugging)
./relay help          # full usage
```

## Uninstall

```bash
./relay uninstall              # remove service, logs, and tmux session
./relay uninstall --dry-run    # preview without touching anything
./relay uninstall --keep-tmux  # remove service + logs, preserve tmux
./relay uninstall --help       # flag documentation
```

Uninstall leaves alone:

- `node_modules/` in the repo — `rm -rf` the clone to remove.
- Claude Code CLI — not installed by claude-relay.
- Tailscale — not installed by claude-relay.

All relay-owned state lives in the repo clone (`logs/`,
`node_modules/`) plus the service registration. So after
`./relay uninstall`, a plain `rm -rf claude-relay` completes the
wipe — no state is left under `~/.cache` or `~/Library`.

## Usage

Open the printed URL on your phone. The tabs across the top are your
tmux windows — tap one to switch. Typing in the input area sends to
the active tab; the text above is the live pane content.

Run `claude` inside any pane to start a Claude Code session. Start a
dev server in another pane and the input area swaps for tappable
port chips — one tap opens the server URL in a new browser tab.
**Stop** and **Restart** buttons bounce a detected server without
you typing Ctrl-C.

The relay keeps running via launchd (macOS) or systemd (Linux), so
your tmux session and everything in it survives phone disconnects,
relay crashes, and reboots. Close the phone browser, come back
hours later — everything is where you left it.

## How it works

- **tmux** is a separate daemon that holds your sessions and panes.
  Claude Code runs inside a tmux pane. If the relay process dies,
  launchd/systemd restarts it and the fresh process reattaches to
  the existing tmux session — your work keeps going.
- **The relay** is a small Node.js HTTP server that exposes the tmux
  session over a WebSocket. It doesn't render terminal output in
  Node; the browser does (for performance).
- **Self-healing**: if the `dev` tmux session is killed externally,
  the relay's 500ms poller detects it and recreates a fresh empty
  session within a second. The phone UI re-attaches automatically.

## Troubleshooting

**Can't reach the URL on your phone** — ensure Tailscale is on (or
you're on the same Wi-Fi as the host) and the host's firewall allows
inbound connections on port 3001.

**"Same network" URL doesn't work even on the same Wi-Fi** — if
you're running the relay inside a VM (OrbStack, UTM, VMware) that
NATs traffic, the VM's "same network" IP is on the hypervisor's
private subnet, not your Wi-Fi. The phone cannot route there. Fix:
install Tailscale inside the VM and use the `100.x.x.x` URL.

**Relay restarts in a loop** — run `./relay dev` to see the error
live. Most common cause: tmux or node isn't on the service's PATH.

**Claude session doesn't respond to input** — check that `claude` is
installed (`claude --version`). Read `./logs/launchd.err` first for
the service's crash trail. If you installed with `DEBUG=1`, also
tail `./logs/debug.log`. Otherwise run `./relay dev`.

**Service won't start at all** — on Linux,
`journalctl --user -u claude-relay` shows lifecycle errors
regardless of `DEBUG`. On macOS, open Console.app and filter for
`com.claude-relay`.

## Contributing & feedback

Claude Relay is open source and built in the open. Contributions,
bug reports, and feature ideas are all welcome:

- **Found a bug?** [Open an issue](https://github.com/adiazpar/claude-relay/issues/new)
  with reproduction steps and what platform you're on.
- **Have an idea or a question?**
  [Start a discussion](https://github.com/adiazpar/claude-relay/discussions)
  — design decisions and "would this make sense?" conversations
  happen there.
- **Want to contribute code?** Fork, branch, submit a PR. Small
  focused changes are easier to review than sweeping refactors.
  Please include a quick note on how you tested.

If Claude Relay is useful to your workflow, starring the repo helps
other people find it. Thanks for checking out the project.
