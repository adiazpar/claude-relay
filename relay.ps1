# claude-relay CLI for Windows — same verbs as the POSIX ./relay:
#   install | uninstall | start | stop | restart | status | dev
# Invoke via relay.cmd (which bypasses execution policy) or directly:
#   powershell -ExecutionPolicy Bypass -File relay.ps1 <command>
#
# Supervision model: a current-user Scheduled Task ('claude-relay') runs
# installers\windows\serve.ps1 hidden at logon; serve.ps1 loops the node
# process with a 2s backoff (KeepAlive parity). The pane-host daemon is
# a separate detached process owned by nobody — it survives relay
# stop/restart so panes (and whatever runs in them) persist, exactly
# like the tmux server on macOS/Linux.

param(
  [Parameter(Position = 0)]
  [string]$Command = '',
  [switch]$KeepPanes
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
$TaskName = 'claude-relay'
$ServeScript = Join-Path $RepoRoot 'installers\windows\serve.ps1'

function Die([string]$msg) {
  Write-Host "error: $msg" -ForegroundColor Red
  exit 1
}

function Get-InstalledTask {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

# The task action's -Port/-Session arguments are the single source of
# truth for the installed configuration (no state file) — the same
# pattern as grepping --port out of the unit file on macOS/Linux.
function Get-InstalledConfig {
  $task = Get-InstalledTask
  if (-not $task) { return $null }
  $args = ($task.Actions | Select-Object -First 1).Arguments
  $port = 7337
  $session = 'dev'
  if ($args -match '-Port\s+(\d+)') { $port = [int]$Matches[1] }
  if ($args -match '-Session\s+(\S+)') { $session = $Matches[1] }
  return @{ Port = $port; Session = $session }
}

function Test-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-RelayHttp([int]$Port) {
  try {
    $res = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 3
    return $res.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-PortOwnerPid([int]$Port) {
  $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  return $null
}

function Get-PaneHostPids {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'pane-host\.ts' } |
    ForEach-Object { $_.ProcessId }
}

function Show-Urls([int]$Port) {
  Write-Host ''
  Write-Host 'Open from your phone:' -ForegroundColor Cyan
  $ts = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($ts) {
    try {
      $status = & tailscale status --json 2>$null | ConvertFrom-Json
      $dns = $status.Self.DNSName
      if ($dns) {
        $name = $dns.TrimEnd('.')
        Write-Host "  http://${name}:$Port   (Tailscale)"
      }
    } catch {}
  } else {
    Write-Host '  (install Tailscale for access from anywhere: https://tailscale.com)'
  }
  # LAN IPv4s. No .local here on purpose: Windows resolves mDNS names but
  # does not advertise its own hostname over mDNS, so a .local URL would
  # silently not work for other devices.
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'Loopback|vEthernet|Tailscale' } |
    ForEach-Object { Write-Host "  http://$($_.IPAddress):$Port   (LAN: $($_.InterfaceAlias))" }
  Write-Host ''
}

function Invoke-Install {
  # ----- requirement checks -----
  $build = [System.Environment]::OSVersion.Version.Build
  if ($build -lt 17763) {
    Die "Windows 10 1809 (build 17763) or newer is required for ConPTY support (you have build $build)."
  }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Die 'Node.js not found. Install Node 20+ from https://nodejs.org' }
  $nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
  if ($nodeMajor -lt 20) { Die "Node 20+ required (you have $(& node --version))." }

  if ($env:PORT) {
    Write-Host "warning: a generic PORT env var is set ($env:PORT). The relay ignores it (port travels as --port argv), but other dev servers will honor it." -ForegroundColor Yellow
  }
  if ($RepoRoot -match 'OneDrive') {
    Write-Host 'warning: this repo is inside a OneDrive-synced folder. OneDrive file locking can race the relay''s upload cleanup. Consider moving it out of OneDrive.' -ForegroundColor Yellow
  }

  $port = if ($env:RELAY_PORT) { [int]$env:RELAY_PORT } else { 7337 }
  $session = if ($env:RELAY_SESSION) { $env:RELAY_SESSION } else { 'dev' }

  # ----- dependencies -----
  Write-Host 'Installing npm dependencies...'
  Push-Location $RepoRoot
  try {
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { Die 'npm install failed.' }
  } finally {
    Pop-Location
  }

  # Verify the node-pty prebuilt binary loads (no Visual Studio Build
  # Tools needed when this passes).
  & node -e "require('@lydell/node-pty')" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Die "the node-pty prebuilt binary failed to load. Check that your Node arch matches your OS (x64/arm64), or install Visual Studio Build Tools and re-run 'npm install'."
  }

  # ----- scheduled task -----
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $action = New-ScheduledTaskAction -Execute $psExe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ServeScript`" -Port $port -Session $session"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  if (Get-InstalledTask) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
  Write-Host "Registered Scheduled Task '$TaskName' (runs at logon, port $port, session $session)."

  # ----- firewall -----
  $ruleName = "Claude Relay (port $port)"
  if (Test-Elevated) {
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Domain, Private | Out-Null
    Write-Host "Added inbound firewall rule for port $port (Domain/Private profiles)."
  } else {
    Write-Host ''
    Write-Host 'Not elevated, so no firewall rule was added. For LAN access, run this once in an elevated PowerShell:' -ForegroundColor Yellow
    Write-Host "  New-NetFirewallRule -DisplayName `"$ruleName`" -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Domain,Private"
    Write-Host 'Tailscale-only access works without it (Tailscale manages its own rules).'
  }

  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  if (Test-RelayHttp $port) {
    Write-Host "Relay is up on port $port." -ForegroundColor Green
  } else {
    Write-Host "Relay starting... check status with: .\relay.cmd status (logs: logs\service.log)" -ForegroundColor Yellow
  }
  Show-Urls $port
}

function Invoke-Uninstall {
  $config = Get-InstalledConfig
  if ($config) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed Scheduled Task '$TaskName'."
    $ownerPid = Get-PortOwnerPid $config.Port
    if ($ownerPid) {
      Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
      Write-Host 'Stopped the relay process.'
    }
    if (Test-Elevated) {
      Get-NetFirewallRule -DisplayName "Claude Relay (port $($config.Port))" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    }
  } else {
    Write-Host 'No Scheduled Task found.'
  }

  if (-not $KeepPanes) {
    # Parity with POSIX uninstall killing the tmux session (panes and the
    # processes inside them). -KeepPanes preserves them, like --keep-tmux.
    $paneHostPids = @(Get-PaneHostPids)
    foreach ($hostPid in $paneHostPids) {
      # Tree-kill so pane shells and their children go too.
      & taskkill /T /F /PID $hostPid 2>$null | Out-Null
    }
    if ($paneHostPids.Count -gt 0) { Write-Host 'Stopped the pane-host (all panes closed).' }
  } else {
    Write-Host 'Kept the pane-host running (-KeepPanes).'
  }

  $logs = Join-Path $RepoRoot 'logs'
  if (Test-Path $logs) {
    Remove-Item -Recurse -Force $logs -ErrorAction SilentlyContinue
    Write-Host 'Removed logs.'
  }
  Write-Host 'Uninstalled. Deleting this folder removes every remaining trace.'
}

function Invoke-Start {
  $config = Get-InstalledConfig
  if (-not $config) { Die "not installed. Run: .\relay.cmd install" }
  if (Test-RelayHttp $config.Port) {
    Write-Host "Already running on port $($config.Port)."
    return
  }
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Started (port $($config.Port))."
}

function Invoke-Stop {
  $config = Get-InstalledConfig
  if (-not $config) { Die 'not installed.' }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  # Stop-ScheduledTask kills the wrapper; the node child can outlive it.
  # The pane-host is deliberately NOT touched — panes survive stop/start.
  $ownerPid = Get-PortOwnerPid $config.Port
  if ($ownerPid) { Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue }
  Write-Host 'Stopped. (Starts again at next logon; panes are preserved by the pane-host.)'
}

function Invoke-Status {
  $config = Get-InstalledConfig
  if (-not $config) {
    Write-Host "Not installed. Run: .\relay.cmd install"
    return
  }
  $task = Get-InstalledTask
  Write-Host "Task:      $TaskName ($($task.State))"
  Write-Host "Port:      $($config.Port)"
  Write-Host "Session:   $($config.Session)"
  $up = Test-RelayHttp $config.Port
  Write-Host "HTTP:      $(if ($up) { 'responding' } else { 'NOT responding' })"
  $paneHost = @(Get-PaneHostPids)
  Write-Host "Pane-host: $(if ($paneHost.Count -gt 0) { "running (pid $($paneHost -join ', '))" } else { 'not running (starts with the relay)' })"
  if ($up) { Show-Urls $config.Port }
}

function Invoke-Dev {
  $config = Get-InstalledConfig
  $port = if ($env:RELAY_PORT) { [int]$env:RELAY_PORT } elseif ($config) { $config.Port } else { 7337 }
  $session = if ($env:RELAY_SESSION) { $env:RELAY_SESSION } elseif ($config) { $config.Session } else { 'dev' }
  if ($env:PORT) {
    Write-Host "warning: generic PORT env var is set ($env:PORT); the relay ignores it but other dev servers won't." -ForegroundColor Yellow
  }
  # Pre-flight: refuse to fight the daemon for the port.
  $ownerPid = Get-PortOwnerPid $port
  if ($ownerPid) {
    Die "port $port is already in use (pid $ownerPid). Stop the daemon first: .\relay.cmd stop"
  }
  Push-Location $RepoRoot
  try {
    & npm run start -- --port $port --session $session
  } finally {
    Pop-Location
  }
}

switch ($Command) {
  'install'   { Invoke-Install }
  'uninstall' { Invoke-Uninstall }
  'start'     { Invoke-Start }
  'stop'      { Invoke-Stop }
  'restart'   { Invoke-Stop; Start-Sleep -Seconds 1; Invoke-Start }
  'status'    { Invoke-Status }
  'dev'       { Invoke-Dev }
  default {
    Write-Host 'usage: relay.cmd {install|uninstall|start|stop|restart|status|dev}'
    Write-Host ''
    Write-Host '  install    First-time setup: deps, Scheduled Task, firewall, start'
    Write-Host '  uninstall  Remove task, logs, pane-host (-KeepPanes to preserve panes)'
    Write-Host '  start      Start the daemon'
    Write-Host '  stop       Stop the daemon (panes survive in the pane-host)'
    Write-Host '  restart    Bounce the daemon (e.g. after a git pull)'
    Write-Host '  status     Task state, HTTP health, URLs'
    Write-Host '  dev        Foreground mode with live logs'
    if ($Command) { exit 1 }
  }
}
