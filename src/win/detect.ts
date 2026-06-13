// Windows detection inputs: a persistent PowerShell worker supplies the
// process table (ps replacement) and TCP listeners (lsof replacement);
// a per-distro WSL pass does the same inside WSL when WSL panes exist.
//
// One worker process for the relay's lifetime — spawning powershell.exe
// per 2s cycle would cost ~200ms+ a tick. The worker runs a read-line
// loop and answers each "snapshot" request with one JSON line. Requests
// are serialized (one in flight); the 2s cadence never queues more than
// one.

import { spawn, execFile, ChildProcess } from 'child_process'
import path from 'path'
import { ProcessEntry } from '../detection.js'

const RESULT_PREFIX = '@@RESULT@@'
const SNAPSHOT_TIMEOUT_MS = 10_000
const RESPAWN_COOLDOWN_MS = 5_000

// The loop script run by the worker. Get-CimInstance Win32_Process
// carries full command lines (unlike tasklist); Get-NetTCPConnection
// needs no elevation for the Listen table. Output is one line per
// request: @@RESULT@@<compact json>.
const WORKER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'snapshot') {
    $procs = @(Get-CimInstance Win32_Process | ForEach-Object {
      @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId;
         command = $(if ($_.CommandLine) { $_.CommandLine } else { $_.Name }) }
    })
    $ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
      @{ pid = [int]$_.OwningProcess; port = [int]$_.LocalPort }
    })
    $json = (@{ procs = $procs; ports = $ports } | ConvertTo-Json -Compress -Depth 4)
    [Console]::Out.WriteLine('${RESULT_PREFIX}' + $json)
  } else {
    [Console]::Out.WriteLine('${RESULT_PREFIX}{}')
  }
}
`

export interface WinSnapshot {
  processes: ProcessEntry[]
  listeningByPid: Map<number, number[]>
}

export function emptySnapshot(): WinSnapshot {
  return { processes: [], listeningByPid: new Map() }
}

export class PowerShellWorker {
  private child: ChildProcess | null = null
  private buffer = ''
  private pendingResolve: ((line: string | null) => void) | null = null
  private lastSpawnAttempt = 0
  private queue: Promise<unknown> = Promise.resolve()

  private spawnWorker(): boolean {
    const now = Date.now()
    if (now - this.lastSpawnAttempt < RESPAWN_COOLDOWN_MS) return false
    this.lastSpawnAttempt = now
    try {
      // powershell.exe (5.1) is guaranteed present on every Windows box;
      // pwsh may not be. -EncodedCommand sidesteps quoting and execution
      // policy entirely.
      const encoded = Buffer.from(WORKER_SCRIPT, 'utf16le').toString('base64')
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      // Deliberately NO windowsHide / detached here. windowsHide sets
      // CREATE_NO_WINDOW, which forces a NEW console for this child; under
      // Windows Terminal (the Win11 default terminal) that console is
      // handed to WT and a visible window pops despite the flag. detached
      // (DETACHED_PROCESS) avoids a console but severs the inherited stdio
      // pipes this RPC relies on (verified: stdin/stdout stop working).
      // So we inherit the relay's console instead — the supervisor makes
      // that console headless via `conhost --headless` — giving no window
      // while the stdin/stdout pipes stay intact.
      this.child = spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        stdio: ['pipe', 'pipe', 'ignore']
      })
      this.child.stdout!.setEncoding('utf-8')
      this.child.stdout!.on('data', (chunk: string) => {
        this.buffer += chunk
        let idx: number
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, idx).replace(/\r$/, '')
          this.buffer = this.buffer.slice(idx + 1)
          if (line.startsWith(RESULT_PREFIX) && this.pendingResolve) {
            const resolve = this.pendingResolve
            this.pendingResolve = null
            resolve(line.slice(RESULT_PREFIX.length))
          }
        }
      })
      const onGone = () => {
        this.child = null
        this.buffer = ''
        if (this.pendingResolve) {
          const resolve = this.pendingResolve
          this.pendingResolve = null
          resolve(null)
        }
      }
      this.child.on('exit', onGone)
      this.child.on('error', onGone)
      return true
    } catch (err) {
      console.error('Failed to spawn PowerShell worker:', err)
      this.child = null
      return false
    }
  }

  private requestLine(command: string): Promise<string | null> {
    return new Promise(resolve => {
      if (!this.child && (!this.spawnWorker() || !this.child)) return resolve(null)
      let settled = false
      const finish = (line: string | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.pendingResolve === finish) this.pendingResolve = null
        resolve(line)
      }
      // A hung worker is a dead worker — kill it so the next request respawns.
      const timer = setTimeout(() => {
        try { this.child?.kill() } catch {}
        this.child = null
        finish(null)
      }, SNAPSHOT_TIMEOUT_MS)
      this.pendingResolve = finish
      try {
        this.child!.stdin!.write(command + '\n')
      } catch {
        finish(null)
      }
    })
  }

  // Serialized: callers never overlap requests on the single worker.
  snapshot(): Promise<WinSnapshot> {
    const run = this.queue.then(async () => {
      const line = await this.requestLine('snapshot')
      if (!line) return emptySnapshot()
      try {
        const parsed = JSON.parse(line)
        const processes: ProcessEntry[] = []
        for (const p of Array.isArray(parsed?.procs) ? parsed.procs : []) {
          const pid = Number(p?.pid)
          const ppid = Number(p?.ppid)
          if (!Number.isInteger(pid) || pid <= 0) continue
          processes.push({ pid, ppid: Number.isInteger(ppid) ? ppid : 0, command: String(p?.command ?? '') })
        }
        const listeningByPid = new Map<number, Set<number>>()
        for (const e of Array.isArray(parsed?.ports) ? parsed.ports : []) {
          const pid = Number(e?.pid)
          const port = Number(e?.port)
          if (!Number.isInteger(pid) || pid <= 0) continue
          if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
          if (!listeningByPid.has(pid)) listeningByPid.set(pid, new Set())
          listeningByPid.get(pid)!.add(port)
        }
        const byPid = new Map<number, number[]>()
        for (const [pid, ports] of listeningByPid) {
          byPid.set(pid, [...ports].sort((a, b) => a - b))
        }
        return { processes, listeningByPid: byPid }
      } catch (err) {
        console.error('Failed to parse worker snapshot:', err)
        return emptySnapshot()
      }
    })
    // Keep the chain alive even if a snapshot throws.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  dispose(): void {
    try { this.child?.kill() } catch {}
    this.child = null
  }
}

// ---------------------------------------------------------------------------
// WSL pass
// ---------------------------------------------------------------------------
// From the Windows side a WSL pane is just wsl.exe — its Linux processes
// are invisible to Win32_Process and its sockets to Get-NetTCPConnection.
// When ≥1 WSL pane exists, run one command per distro per cycle that
// emits three sections: pane marker files (token → shell pid), the
// process table, and listening sockets (ss -p only annotates the
// caller's own processes, which is exactly the dev-server case).

export interface WslSnapshot {
  // marker token (from the pane's spawn command) → in-distro shell pid
  shellPidByToken: Map<string, number>
  processes: ProcessEntry[]
  listeningByPid: Map<number, number[]>
}

const WSL_SCRIPT = `
for f in /tmp/.claude-relay-pane-*; do
  [ -f "$f" ] && printf 'M %s %s\\n' "\${f##*.claude-relay-pane-}" "$(cat "$f" 2>/dev/null)"
done
echo '==PS=='
ps -eo pid=,ppid=,args=
echo '==SS=='
ss -tlnpH 2>/dev/null
`

export function wslSnapshot(distro: string): Promise<WslSnapshot> {
  return new Promise(resolve => {
    const empty: WslSnapshot = { shellPidByToken: new Map(), processes: [], listeningByPid: new Map() }
    execFile('wsl.exe', ['-d', distro, '-e', 'sh', '-c', WSL_SCRIPT], {
      timeout: 8000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    }, (err, stdout) => {
      if (err || !stdout) return resolve(empty)
      try {
        const result: WslSnapshot = { shellPidByToken: new Map(), processes: [], listeningByPid: new Map() }
        let section: 'markers' | 'ps' | 'ss' = 'markers'
        for (const rawLine of stdout.split('\n')) {
          const line = rawLine.replace(/\r$/, '')
          if (line === '==PS==') { section = 'ps'; continue }
          if (line === '==SS==') { section = 'ss'; continue }
          if (!line.trim()) continue
          if (section === 'markers') {
            const m = line.match(/^M (\S+) (\d+)$/)
            if (m) result.shellPidByToken.set(m[1], parseInt(m[2], 10))
          } else if (section === 'ps') {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
            if (m) {
              result.processes.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), command: m[3] })
            }
          } else {
            // ss -tlnpH: ... LISTEN 0 511 *:3000 *:* users:(("node",pid=123,fd=18))
            const portMatch = line.match(/[\s\]:](\d+)\s+[^\s]+\s+users:\(\("[^"]*",pid=(\d+)/)
            if (portMatch) {
              const port = parseInt(portMatch[1], 10)
              const pid = parseInt(portMatch[2], 10)
              if (port > 0 && port <= 65535 && pid > 0) {
                if (!result.listeningByPid.has(pid)) result.listeningByPid.set(pid, [])
                const arr = result.listeningByPid.get(pid)!
                if (!arr.includes(port)) arr.push(port)
              }
            }
          }
        }
        for (const arr of result.listeningByPid.values()) arr.sort((a, b) => a - b)
        resolve(result)
      } catch {
        resolve(empty)
      }
    })
  })
}
