# Service wrapper run by the 'claude-relay' Scheduled Task at logon.
# Keeps the relay alive (KeepAlive/Restart=always parity with launchd
# and systemd): respawn on exit with a 2s backoff. Output goes to
# logs\service.log inside the repo — same "everything lives in the
# repo" invariant as the POSIX paths.
#
# The port and session travel exclusively as argv (never the PORT env
# var — see CLAUDE.md "Port architecture"). The task action's arguments
# are the single source of truth that `relay.ps1 status` reads back.

param(
  [int]$Port = 7337,
  [string]$Session = 'dev'
)

$ErrorActionPreference = 'Continue'

# The Scheduled Task launches us with -WindowStyle Hidden, but that is
# unreliable from Task Scheduler: the powershell console window (which
# also hosts the relay node child) still appears. Hide our own console
# window explicitly so the relay runs truly headless. Children that
# share this console (the relay node) are hidden with it. There may be a
# brief flash at logon before this line runs. Set RELAY_SHOW_CONSOLE=1
# to keep the window for debugging.
if (-not $env:RELAY_SHOW_CONSOLE) {
  try {
    Add-Type -Name Win -Namespace RelayConsole -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@ -ErrorAction Stop
    $h = [RelayConsole.Win]::GetConsoleWindow()
    if ($h -ne [System.IntPtr]::Zero) { [void][RelayConsole.Win]::ShowWindow($h, 0) }  # 0 = SW_HIDE
  } catch {}
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $RepoRoot

$LogDir = Join-Path $RepoRoot 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'service.log'

function Write-Log([string]$msg) {
  Add-Content -Path $LogFile -Value "$((Get-Date).ToString('s')) [serve] $msg"
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Log 'node not found on PATH; giving up'
  exit 1
}
$tsxCli = Join-Path $RepoRoot 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path $tsxCli)) {
  Write-Log "tsx not installed (expected $tsxCli) - run relay.cmd install"
  exit 1
}

# Rotate a runaway log at 5 MB.
if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 5MB) {
  Move-Item -Force $LogFile "$LogFile.1"
}

Write-Log "starting relay loop (port $Port, session $Session)"
while ($true) {
  & $node $tsxCli 'src\server.ts' --port $Port --session $Session *>> $LogFile
  Write-Log "relay exited (code $LASTEXITCODE); restarting in 2s"
  Start-Sleep -Seconds 2
}
