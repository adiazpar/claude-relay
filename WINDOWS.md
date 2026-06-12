# Windows Bring-Up & Debugging Guide

Audience: whoever (human or Claude agent) is doing the first real run of
claude-relay on a Windows machine. The Windows implementation was
written and code-reviewed on macOS — the POSIX/tmux path is fully
regression-tested, but **none of the Windows-only code has executed on
real Windows yet**. This file maps the architecture, gives an ordered
verification checklist, and ranks the places most likely to need a fix,
with diagnosis steps for each.

User-facing setup lives in README.md ("Windows" section). Architecture
rationale lives in `.claude/CLAUDE.md` ("Windows Support" section).
Read both before changing code.

## Architecture in 60 seconds

Two processes, joined by a named pipe:

```
relay (node, restartable)                pane-host (node, long-lived)
  src/server.ts                            src/win/pane-host.ts
  src/bridge-instance.ts  --picks-->         owns ConPTYs via @lydell/node-pty
  src/win/bridge.ts (WinBridge)              renders VT -> text via @xterm/headless
  src/win/detect.ts (PS worker, WSL pass)    NDJSON RPC on \\.\pipe\claude-relay-
  src/win/shells.ts (shell discovery)          panehost-<user>-<session>
  src/detection.ts (shared tree walks)       survives relay restarts = persistence
```

- The relay spawns the pane-host (detached, hidden) if the pipe is
  absent; a changed `bootId` in the `hello` response means the old host
  died and maps to the `sessionRecreated` self-heal path.
- Supervision: Scheduled Task `claude-relay` runs
  `installers\windows\serve.ps1` (a while-loop around node) at logon.
  `relay.cmd` -> `relay.ps1` is the CLI.
- Detection: one persistent `powershell.exe` worker answers `snapshot`
  requests (process table + TCP listeners); WSL panes get a per-distro
  `wsl.exe -e sh -c` pass keyed by `/tmp/.claude-relay-pane-<token>`
  marker files.

Logs: `logs\service.log` (relay + wrapper), `logs\pane-host.log`
(pane-host). `DEBUG=1` adds `logs\debug.log` (set it in serve.ps1's
environment or a `relay.cmd dev` shell).

## First-run checklist (in order — each step depends on the previous)

Run from a PowerShell prompt in the repo root.

1. **Install**: `.\relay.cmd install`
   Expect: npm install passes, "node-pty prebuilt binary" check passes,
   task registered, "Relay is up on port 7337".
2. **Health**: `curl.exe http://127.0.0.1:7337/api/health`
   Expect `{"status":"ok","tmuxSession":true}`. `tmuxSession:true` here
   means "pane-host reachable" (key name kept for client compat).
   If false → see soft spot #1.
3. **Panes**: `curl.exe http://127.0.0.1:7337/api/panes`
   Expect one pane (`id":"w0"`, default shell) — the relay auto-creates
   it when the host is empty. Then open `http://localhost:7337` in a
   browser on the PC: you should see a PowerShell prompt and be able to
   run commands from the input bar.
4. **Shells**: `curl.exe http://127.0.0.1:7337/api/shells`
   Expect pwsh/powershell/cmd, plus git-bash and wsl:<distro> entries if
   installed. The + (new tab) button in the UI should open the picker.
5. **Output pipeline**: in a pane, run something colorful
   (`git log --oneline`, `ls` in Git Bash). Output should stream within
   ~500ms, with colors, no duplicated or interleaved lines.
6. **Agent detection**: run `claude` in a PowerShell tab. Within ~2-4s
   the Start button should flip to agent state (input goes to Claude,
   mode button appears). Shift-tab mode cycling should work via the
   mode button.
7. **Server detection**: run `npx http-server -p 8080` (or any dev
   server). Within ~2-4s: Stop/Restart buttons + a port chip. Tap Stop
   → server gets Ctrl-C'd. Run again, tap Restart → Ctrl-C, then the
   exact command replayed.
8. **Persistence**: `.\relay.cmd restart`, reload the browser.
   Tabs and their running processes must still be there. This is the
   core Windows guarantee — if it fails, the pane-host died with the
   relay (see soft spot #2).
9. **WSL tab** (if WSL installed): new tab → pick the distro. Expect a
   Linux prompt. Run `claude` inside it → agent detection should light
   up (slower path, via the WSL pass). Run a dev server inside WSL →
   chips appear but are only phone-reachable with mirrored networking
   or Tailscale-in-distro (documented limitation, not a bug).
10. **Phone + device switch**: from the phone (Tailscale up), open
    `http://<pc-magicdns>:7337` directly; then from your Mac-served UI,
    add the PC as a device and switch to it. Tabs, agents list, and
    shells picker should all reflect the PC.
11. **Logon survival**: sign out, sign back in, `.\relay.cmd status`
    → task Running, HTTP responding.

## Ranked soft spots (likeliest fixes needed, with diagnosis)

### 1. Ctrl-C semantics through ConPTY (Stop/Restart buttons)

`WinBridge.stopServer` writes `\x03` into the PTY and trusts ConPTY to
deliver CTRL_C_EVENT to the foreground app. This is the single most
uncertain behavior in the port. Test against a real dev server (vite,
http-server) in each shell kind — PowerShell, cmd, Git Bash.

If the server doesn't die: the fallback design (noted in the design
doc) is a tree-kill — find the pane's direct-child server process from
the detection snapshot and `taskkill /T /PID <pid>`. Wire it into
`stopServer` as a follow-up after a grace period. Don't tree-kill
unconditionally — Ctrl-C lets servers clean up.

Restart has a second wrinkle: the line-flush key before replaying the
command is Esc for powershell/cmd (PSReadLine RevertLine) and Ctrl-U
(`\x15`) for gitbash/wsl. If replayed commands come out mangled, check
the flush key per shell kind in `restartServer`.

### 2. Pane-host spawn & lifetime

The relay spawns the pane-host with
`node <tsx-cli> src/win/pane-host.ts --session dev` (detached, hidden).
Things that can break:

- `require.resolve('tsx/cli')` failing → falls back to
  `node_modules\tsx\dist\cli.mjs`. Verify one of the two resolves.
- The pane-host must OUTLIVE the relay. If step 8 of the checklist
  fails, suspect Windows killing the detached child anyway (job object
  semantics), or `Stop-ScheduledTask`/`Stop-Process` catching it. The
  pane-host pid is in `logs\pane-host.log`; check it's the same pid
  before and after a relay restart. If detached isn't enough on
  Windows, the fix is spawning via
  `wmic process call create` / `Start-Process` or a scheduled-task
  one-shot — but try plain detached first; node's
  `detached: true` + `unref()` on win32 creates a separate process
  group and should survive.
- Single-instance: a second pane-host exits on `EADDRINUSE` of the
  pipe. If you see ping-pong respawning in pane-host.log, the pipe name
  collided or the incumbent is half-dead — check
  `[System.IO.Directory]::GetFiles("\\.\pipe\")` filtered to
  `claude-relay` to see what actually exists.

### 3. PowerShell worker JSON (detection returns nothing)

Symptom: terminal works but Start button never lights for agents, no
server chips. Check: are snapshots empty? Run the worker by hand —
extract `WORKER_SCRIPT` from `src/win/detect.ts`, run it in a
PowerShell, type `snapshot`, inspect the `@@RESULT@@` line. Known risks:

- `ConvertTo-Json` shape quirks (single element arrays, depth). The
  script wraps in `@(...)` everywhere, but verify `procs`/`ports` are
  always arrays in the JSON.
- `Get-NetTCPConnection` may not exist on very old builds or inside
  some containers; it's wrapped in SilentlyContinue, which degrades to
  "no server detection" silently — that's by design, but confirm it's
  not the reason chips are missing.
- Worker startup latency: first snapshot can take 1-3s (CIM warmup).
  The 10s timeout should cover it.

### 4. Agent detection regex vs real npm shims

On Windows, npm-installed Claude appears in a pane's tree as
`...\npm\claude.cmd` (cmd.exe shim) plus `node ...\claude-code\cli.js`.
The shared regex (src/detection.ts, `agentRegex`) matches
`\claude.cmd"` boundaries. Verify with the real tree: get the pane pid
from `/api/panes`, then
`Get-CimInstance Win32_Process | ? {$_.ParentProcessId -eq <pid>}`
and walk down. If the shim layer differs (pnpm, volta, scoop shims,
native claude.exe installer), adjust the regex boundaries — never
hardcode an agent list in the bridge; fix it in detection.ts so all
agents benefit.

Note: Claude's `versionTitle` signal (process title = "2.1.114") does
NOT exist on Windows; the tree walk is the only signal. That's expected.

### 5. WSL pass parsing

If WSL tabs work as terminals but never detect agents/servers:

- Marker files: `wsl -d <distro> -e sh -c 'ls /tmp/.claude-relay-pane-*'`
  — one per WSL pane. Missing → the spawn args with the
  `echo $$ > /tmp/...` preamble didn't survive; check how
  `src/win/shells.ts` builds args and whether wsl.exe passed them
  through unmangled (argv arrays, no shell quoting, should be safe).
- `ss -tlnpH` output format varies; the regex in `wslSnapshot` expects
  `users:(("name",pid=N`. Run it inside the distro and compare. ss
  only annotates pids for the calling user's sockets — fine for dev
  servers, by design.
- `wsl.exe -l -q` is UTF-16LE (decoded as such in shells.ts) but
  `wsl.exe -e sh -c ...` output is UTF-8 (decoded as such in
  detect.ts). If distro names come out garbled in /api/shells, it's
  the former; if the WSL pass parses nothing, check the latter.

### 6. Rendering/capture quirks

The pane-host renders ConPTY's VT stream through @xterm/headless and
serializes with ANSI. Possible artifacts:

- PowerShell/PSReadLine redraws (syntax highlighting rewrites the
  line) may cause frequent seq bumps → captures every 500ms. Not
  wrong, but if output flickers or scroll position jumps on the phone,
  look at how often `output` events fire (DEBUG=1 logs) and consider
  debouncing in `pollTick`.
- cmd.exe codepage: panes are spawned with the default env. If
  box-drawing or non-ASCII output looks wrong in cmd tabs only, add
  `chcp 65001` handling or set the ConPTY env `LANG`-equivalents at
  spawn in pane-host.ts.
- `term.clear()` (clearScrollback) behavior on a TUI-covered screen is
  untested; if "clear" misbehaves it's cosmetic — fix later.

### 7. Scheduled Task & service behavior

- `Register-ScheduledTask` without elevation works for the current
  user in standard setups but can be blocked by org policy. Fallback:
  a Startup-folder shortcut to
  `powershell -WindowStyle Hidden -File installers\windows\serve.ps1`
  (document it; don't auto-fallback silently).
- `-ExecutionTimeLimit ([TimeSpan]::Zero)` is what stops Windows from
  killing the relay after 72h. If the relay dies daily/3-daily, check
  the task's settings actually saved (`Get-ScheduledTask claude-relay
  | Select -Expand Settings`).
- `relay.cmd stop` kills the port-owning pid. If `npm` ever sits
  between the wrapper and node (it shouldn't — serve.ps1 calls node
  directly), stop would orphan the real server. Verify with
  `Get-NetTCPConnection -LocalPort 7337` after stop: should be empty.

### 8. Firewall / reachability

LAN access needs the inbound rule (install prints it if not elevated).
Tailscale needs nothing. If the phone can't connect but localhost
works, it's this — `Test-NetConnection <pc-ip> -Port 7337` from
another machine distinguishes firewall (refused/timeout) from
routing.

## Debugging tools

- `.\relay.cmd dev` — foreground relay with live console logs (stop
  the daemon first; it has a port pre-flight).
- Run the pane-host in the foreground:
  `node node_modules\tsx\dist\cli.mjs src\win\pane-host.ts --session dev`
  then poke it from another PowerShell with a quick node REPL using
  `net.connect('\\\\.\\pipe\\claude-relay-panehost-<user>-dev')` and a
  `{"rid":1,"method":"hello","params":{}}\n` line.
- `DEBUG=1` env (see server.ts) tees relay logs to `logs\debug.log`.
- The 2s `paneRuntimeList` WS broadcast is the heartbeat of detection —
  watch it in the browser devtools WS tab to see exactly what the
  client is told.

## Don't break these while fixing things

- The tmux path (macOS/Linux) is regression-tested and shared code in
  `src/detection.ts` feeds BOTH platforms — run `npx tsc --noEmit` and
  re-test a POSIX relay if you touch shared files.
- Port/session travel as argv only; never introduce `process.env.PORT`.
- The pane-host stays dumb. If a fix tempts you to put detection or
  shell knowledge into pane-host.ts, put it in WinBridge instead —
  long-lived pane-hosts can't be updated without killing panes. If the
  pipe protocol must change, bump `PROTOCOL_VERSION` in
  `src/win/protocol.ts` and keep changes additive.
- CORS/WS origin allowlist (`isPrivateOrigin`) must never loosen to `*`.
