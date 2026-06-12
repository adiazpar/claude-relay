import * as tls from 'tls'
import { EventEmitter } from 'events'
import { AgentDefinition } from './agents.js'
import { ServerPort, AgentMode } from './bridge.js'

// Platform-neutral detection logic shared by both bridges. Each bridge
// supplies the raw inputs (process table, listening-PID map, captured
// output text); everything here is pure tree-walking and matching.

export type ProcessEntry = { pid: number; ppid: number; command: string }

// Strip ANSI escape sequences (colors, cursor moves, etc.) for reliable string matching.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

// Word-boundary regex for an agent's binary name, compiled once per
// binary. Matches "claude", "/usr/local/bin/claude", "claude --flag",
// "C:\Users\x\claude.exe" but not "claude-notes.md". On Windows the
// command line ends in ".exe", so an optional extension is folded in.
const agentRegexCache = new Map<string, RegExp>()
function agentRegex(agent: AgentDefinition): RegExp {
  let re = agentRegexCache.get(agent.binary)
  if (!re) {
    const escaped = agent.binary.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`(^|[\\\\/\\s"])${escaped}(\\.exe|\\.cmd|\\.ps1)?($|[\\s"])`)
    agentRegexCache.set(agent.binary, re)
  }
  return re
}

export function matchesAgent(agent: AgentDefinition, command: string | undefined | null): boolean {
  if (!command) return false
  return agentRegex(agent).test(command.trim().toLowerCase())
}

// Some agents (Claude Code) set process.title to their version string
// (e.g. "2.1.114"), which is what tmux reports as pane_current_command
// and what ps shows once the TUI boots. (POSIX-only signal: on Windows
// process.title sets the console window title, not the process name.)
export function looksLikeVersionTitle(command: string | undefined | null): boolean {
  if (!command) return false
  return /^\d+\.\d+\.\d+/.test(command.trim())
}

export function isShellCommand(command: string | undefined | null): boolean {
  if (!command) return false
  const normalized = command.trim().toLowerCase()
  return /(^|\/)(bash|zsh|sh|fish|ksh|tcsh|csh|dash|nu)$/.test(normalized)
}

export function buildChildrenIndex(processes: ProcessEntry[]): Map<number, ProcessEntry[]> {
  const byParent = new Map<number, ProcessEntry[]>()
  for (const proc of processes) {
    if (!byParent.has(proc.ppid)) byParent.set(proc.ppid, [])
    byParent.get(proc.ppid)!.push(proc)
  }
  return byParent
}

// Which registered agent (if any) runs anywhere in the process tree
// rooted at rootPid. Fallback signal for wrappers and the window before
// a TUI sets its title; on Windows it's the primary signal.
export function detectAgentInTree(
  rootPid: number,
  agents: AgentDefinition[],
  processes: ProcessEntry[]
): string | null {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null
  if (processes.length === 0) return null

  const childrenByParent = buildChildrenIndex(processes)
  const processByPid = new Map(processes.map(proc => [proc.pid, proc]))
  const stack = [rootPid]
  const seen = new Set<number>()

  while (stack.length > 0) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)

    const proc = processByPid.get(pid)
    if (proc) {
      for (const agent of agents) {
        if (matchesAgent(agent, proc.command)) return agent.id
      }
    }

    for (const child of childrenByParent.get(pid) || []) {
      stack.push(child.pid)
    }
  }

  return null
}

// Given a pane's root pid and the global listening-PID map, find the
// shell-level command the user typed AND the ports its subtree is bound
// to. Walks each direct child of the root; if any descendant of that
// child is a listener, the child's own argv is the shell-level command.
// Preserves the user's intent for wrapped invocations (`npm run dev` →
// node listens, but we return `npm run dev`) while giving the exact
// string for direct invocations. All listening ports within the matched
// subtree are collected so the UI can show quick-launch chips.
export function detectServerInTree(
  panePid: number,
  listeningByPid: Map<number, number[]>,
  processes: ProcessEntry[],
  getPortProtocol: (port: number) => 'http' | 'https'
): { command: string; ports: ServerPort[] } | null {
  if (!Number.isInteger(panePid) || panePid <= 0) return null
  if (listeningByPid.size === 0) return null
  if (processes.length === 0) return null

  const byParent = buildChildrenIndex(processes)

  const directChildren = byParent.get(panePid) || []
  for (const child of directChildren) {
    const stack = [child.pid]
    const seen = new Set<number>()
    const ports = new Set<number>()
    while (stack.length > 0) {
      const pid = stack.pop()!
      if (seen.has(pid)) continue
      seen.add(pid)
      const pidPorts = listeningByPid.get(pid)
      if (pidPorts) for (const port of pidPorts) ports.add(port)
      for (const k of byParent.get(pid) || []) stack.push(k.pid)
    }
    if (ports.size > 0) {
      const sorted = [...ports].sort((a, b) => a - b)
      return {
        command: child.command.trim(),
        ports: sorted.map(port => ({ port, protocol: getPortProtocol(port) }))
      }
    }
  }
  return null
}

// Detect current Claude Code permission mode from captured output.
// Claude-specific: other agents have no shift+tab indicator line, so
// this returns 'normal' for them, which the client ignores.
export function detectModeFromOutput(output: string): AgentMode {
  const clean = output.replace(ANSI_RE, '')

  // The actual indicator looks like: ">> bypass permissions on (shift+tab to cycle)"
  const modeLineMatch = clean.match(/.*(shift\s*\+\s*tab).*/i)
  if (!modeLineMatch) {
    return 'normal' // No mode indicator found
  }

  const modeLine = modeLineMatch[0].toLowerCase()

  if (modeLine.includes('plan')) {
    return 'plan'
  } else if (modeLine.includes('bypass')) {
    return 'bypass'
  } else if (modeLine.includes('auto') || modeLine.includes('accept edit')) {
    return 'auto-edit'
  } else {
    return 'normal'
  }
}

// Tracks the http/https classification of detected server ports.
// Each port is probed once with a real TLS handshake to 127.0.0.1:
//   secureConnect            → https
//   non-connection TLS error → http (server answered with non-TLS bytes)
//   refused/timeout          → no cache entry, re-probed next cycle
// Until a probe lands, getPortProtocol returns 'http' as the default;
// when a probe upgrades a port to https the prober emits 'resolved' so
// the server can debounce an early runtime-state broadcast.
export class ProtocolProber extends EventEmitter {
  private cache = new Map<number, 'http' | 'https'>()
  private pending = new Set<number>()

  private probePort(port: number): Promise<'http' | 'https' | null> {
    return new Promise(resolve => {
      let settled = false
      const done = (r: 'http' | 'https' | null) => {
        if (settled) return
        settled = true
        resolve(r)
      }
      let socket: tls.TLSSocket
      try {
        socket = tls.connect({
          host: '127.0.0.1',
          port,
          rejectUnauthorized: false,
          servername: 'localhost',
          timeout: 1000
        })
      } catch {
        return done(null)
      }
      socket.once('secureConnect', () => {
        done('https')
        try { socket.destroy() } catch {}
      })
      socket.once('error', (err: NodeJS.ErrnoException) => {
        const code = err?.code
        if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
          done(null)
        } else {
          // TLS handshake failed mid-way — the server is speaking plaintext.
          done('http')
        }
        try { socket.destroy() } catch {}
      })
      socket.once('timeout', () => {
        done(null)
        try { socket.destroy() } catch {}
      })
    })
  }

  getPortProtocol = (port: number): 'http' | 'https' => {
    const cached = this.cache.get(port)
    if (cached) return cached
    if (!this.pending.has(port)) {
      this.pending.add(port)
      this.probePort(port).then(result => {
        this.pending.delete(port)
        if (!result) return
        const prev = this.cache.get(port)
        this.cache.set(port, result)
        if (prev !== result && result === 'https') {
          this.emit('resolved', port, result)
        }
      }).catch(() => {
        this.pending.delete(port)
      })
    }
    return 'http'
  }

  // Evict entries whose ports are no longer listening, so a new process
  // reusing the same port gets re-probed rather than inheriting the old
  // process's classification.
  gc(activePorts: Set<number>): void {
    for (const port of this.cache.keys()) {
      if (!activePorts.has(port)) this.cache.delete(port)
    }
  }

  clear(): void {
    this.cache.clear()
  }
}
