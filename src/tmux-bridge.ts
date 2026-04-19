import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import * as tls from 'tls'

const TMUX_SESSION = process.env.TMUX_SESSION || 'dev'
const DEFAULT_CWD = process.env.HOME || '/'
const POLL_INTERVAL = 500 // ms
const CAPTURE_LINES = 500 // lines
const MAX_BUFFER = 10 * 1024 * 1024

// Strip ANSI escape sequences (colors, cursor moves, etc.) for reliable string matching.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

export interface PaneInfo {
  id: string           // e.g., "@0" (window id)
  target: string       // e.g., "dev:0" (session:window - targets the active pane in window)
  index: number        // window index
  windowIndex: number  // window index (same as index)
  cwd: string          // current working directory of active pane in window
  panePid: number      // pid of the active pane's process tree root
  currentCommand: string // tmux-reported current command in the active pane
  paneTitle: string    // tmux-reported pane title (set by the TUI via OSC escapes)
  width: number
  height: number
}

export interface ServerPort {
  port: number
  protocol: 'http' | 'https'
}

export interface PaneRuntimeState {
  claudeRunning: boolean
  shellReady: boolean
  currentCommand: string
  serverRunning: boolean
  serverCommand: string | null
  serverPorts: ServerPort[]
}

export class TmuxBridge extends EventEmitter {
  private lastOutputByPane = new Map<string, string>()
  private polling = false
  private pollTimer: NodeJS.Timeout | null = null
  private cachedPanes: PaneInfo[] = []
  // Cached protocol per listening port. Populated asynchronously by
  // probePort; evicted when the port disappears from the lsof listing so
  // a new process reusing the same port gets re-probed.
  private protocolCache = new Map<number, 'http' | 'https'>()
  private pendingProbes = new Set<number>()
  // Cooldown between auto-recreate attempts so a repeatedly-failing tmux
  // invocation (e.g. tmux binary missing) doesn't hammer execFileSync every
  // poll tick. Reset on successful recreate.
  private lastSessionRecreateAttempt = 0
  private static readonly SESSION_RECREATE_COOLDOWN_MS = 5000

  constructor() {
    super()
  }

  // If the tmux session has disappeared (user ran tmux kill-session or
  // kill-server, or the tmux server crashed), create a fresh one so the
  // relay has something to talk to. Rate-limited to avoid thrashing when
  // recreation itself fails. Emits 'sessionRecreated' so the server can
  // push a fresh paneList to connected clients — otherwise they'd sit on
  // stale pane IDs until a manual refresh.
  private ensureSession(): boolean {
    if (this.sessionExists()) return true
    const now = Date.now()
    if (now - this.lastSessionRecreateAttempt < TmuxBridge.SESSION_RECREATE_COOLDOWN_MS) {
      return false
    }
    this.lastSessionRecreateAttempt = now
    try {
      this.runTmux(['new-session', '-d', '-s', TMUX_SESSION, '-c', DEFAULT_CWD])
      console.log(`Recreated tmux session '${TMUX_SESSION}' after it went missing`)
      this.lastOutputByPane.clear()
      this.protocolCache.clear()
      this.cachedPanes = []
      this.emit('sessionRecreated')
      return true
    } catch (err) {
      console.error('Failed to recreate tmux session:', err)
      return false
    }
  }

  // No-op for compatibility (typing state no longer affects polling)
  setTypingState(_isTyping: boolean) {}

  // Run tmux with argv form — no shell, no injection possible from arg values.
  private runTmux(args: string[]): string {
    return execFileSync('tmux', args, {
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }

  private listProcesses(): Array<{ pid: number; ppid: number; command: string }> {
    try {
      const output = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], {
        encoding: 'utf-8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      return output.trim().split('\n').filter(Boolean).map(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
        if (!match) {
          return null
        }
        return {
          pid: parseInt(match[1], 10),
          ppid: parseInt(match[2], 10),
          command: match[3]
        }
      }).filter((row): row is { pid: number; ppid: number; command: string } => row !== null)
    } catch (error) {
      console.error('Failed to list processes:', error)
      return []
    }
  }

  private isClaudeCommand(command: string | undefined | null): boolean {
    if (!command) return false
    const normalized = command.trim().toLowerCase()
    return /(^|[\/\s])claude($|\s)/.test(normalized)
  }

  // Claude Code sets process.title to its version string (e.g. "2.1.114"),
  // which is what tmux reports as pane_current_command.
  private looksLikeClaudeVersion(command: string | undefined | null): boolean {
    if (!command) return false
    return /^\d+\.\d+\.\d+/.test(command.trim())
  }

  private isShellCommand(command: string | undefined | null): boolean {
    if (!command) return false
    const normalized = command.trim().toLowerCase()
    return /(^|\/)(bash|zsh|sh|fish|ksh|tcsh|csh|dash|nu)$/.test(normalized)
  }

  // All PIDs currently listening on a TCP socket, mapped to the ports they
  // bind. One lsof call per detection cycle is cheaper than per-pane
  // queries, and the caller intersects this against each pane's own
  // process tree — so a backend server in pane A and a frontend server in
  // pane B never cross streams.
  private listListeningByPid(): Map<number, number[]> {
    try {
      // -FpPn emits one field per line: p<pid>, P<proto>, n<addr:port>.
      // Each process block starts with p<pid>; subsequent n lines belong
      // to that pid until the next p line.
      const output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpPn'], {
        encoding: 'utf-8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const byPid = new Map<number, Set<number>>()
      let currentPid = 0
      for (const line of output.split('\n')) {
        if (!line) continue
        const field = line[0]
        const val = line.slice(1)
        if (field === 'p') {
          const pid = parseInt(val, 10)
          currentPid = Number.isInteger(pid) && pid > 0 ? pid : 0
        } else if (field === 'n' && currentPid) {
          // Address formats: *:3000, 127.0.0.1:3000, [::1]:3000, *:*
          const m = val.match(/:(\d+)$/)
          if (m) {
            const port = parseInt(m[1], 10)
            if (Number.isInteger(port) && port > 0 && port <= 65535) {
              if (!byPid.has(currentPid)) byPid.set(currentPid, new Set())
              byPid.get(currentPid)!.add(port)
            }
          }
        }
      }
      const result = new Map<number, number[]>()
      for (const [pid, ports] of byPid) {
        result.set(pid, [...ports].sort((a, b) => a - b))
      }
      return result
    } catch {
      // lsof missing or blocked — server detection is a best-effort signal,
      // treat it as "no servers visible" and fall through to normal UI.
      return new Map()
    }
  }

  // Speak TLS to 127.0.0.1:<port> just far enough to see whether the server
  // returns a real ServerHello. A clean TLS handshake => https. An error
  // other than ECONNREFUSED/unreachable means the server responded with
  // non-TLS bytes (or closed) => it's speaking plain http. Connection
  // refused or timeouts yield null so we don't cache a guess during boot.
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

  // Return the cached protocol for a port. If we've never probed it, kick
  // off a background probe and return 'http' as a placeholder. When the
  // probe comes back as 'https' we emit protocolResolved so the server can
  // push an early broadcast — without that, clients would show the wrong
  // scheme for up to one full runtime-state cycle (~2s) after a server
  // boots. 'http' results don't need an early broadcast because that's
  // the default clients already saw.
  private getPortProtocol(port: number): 'http' | 'https' {
    const cached = this.protocolCache.get(port)
    if (cached) return cached
    if (!this.pendingProbes.has(port)) {
      this.pendingProbes.add(port)
      this.probePort(port).then(result => {
        this.pendingProbes.delete(port)
        if (!result) return
        const prev = this.protocolCache.get(port)
        this.protocolCache.set(port, result)
        if (prev !== result && result === 'https') {
          this.emit('protocolResolved', port, result)
        }
      }).catch(() => {
        this.pendingProbes.delete(port)
      })
    }
    return 'http'
  }

  private gcProtocolCache(activePorts: Set<number>): void {
    for (const port of this.protocolCache.keys()) {
      if (!activePorts.has(port)) this.protocolCache.delete(port)
    }
  }

  // Given a pane's shell pid and the global listening-PID map, find the
  // shell-level command the user typed AND the ports its subtree is bound
  // to. Walks each direct child of the shell; if any descendant of that
  // child is a listener, the child's own argv is the shell-level command.
  // Preserves the user's intent for wrapped invocations (`npm run dev` →
  // node listens, but we return `npm run dev`) while giving the exact
  // string for direct invocations (`python3 manage.py runserver`). All
  // listening ports within the matched subtree are collected so the UI
  // can show quick-launch chips (Vite's HTTP port plus its HMR port, etc.).
  private detectServer(panePid: number, listeningByPid: Map<number, number[]>): { command: string; ports: ServerPort[] } | null {
    if (!Number.isInteger(panePid) || panePid <= 0) return null
    if (listeningByPid.size === 0) return null

    const processes = this.listProcesses()
    if (processes.length === 0) return null

    const byParent = new Map<number, Array<{ pid: number; ppid: number; command: string }>>()
    for (const proc of processes) {
      if (!byParent.has(proc.ppid)) byParent.set(proc.ppid, [])
      byParent.get(proc.ppid)!.push(proc)
    }

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
        const kids = byParent.get(pid) || []
        for (const k of kids) stack.push(k.pid)
      }
      if (ports.size > 0) {
        const sorted = [...ports].sort((a, b) => a - b)
        return {
          command: child.command.trim(),
          ports: sorted.map(port => ({ port, protocol: this.getPortProtocol(port) }))
        }
      }
    }
    return null
  }

  private hasClaudeProcessInTree(rootPid: number): boolean {
    if (!Number.isInteger(rootPid) || rootPid <= 0) return false

    const processes = this.listProcesses()
    if (processes.length === 0) return false

    const childrenByParent = new Map<number, number[]>()
    for (const proc of processes) {
      if (!childrenByParent.has(proc.ppid)) {
        childrenByParent.set(proc.ppid, [])
      }
      childrenByParent.get(proc.ppid)!.push(proc.pid)
    }

    const processByPid = new Map(processes.map(proc => [proc.pid, proc]))
    const stack = [rootPid]
    const seen = new Set<number>()

    while (stack.length > 0) {
      const pid = stack.pop()!
      if (seen.has(pid)) continue
      seen.add(pid)

      const proc = processByPid.get(pid)
      if (proc && this.isClaudeCommand(proc.command)) {
        return true
      }

      const children = childrenByParent.get(pid) || []
      for (const childPid of children) {
        stack.push(childPid)
      }
    }

    return false
  }

  sessionExists(): boolean {
    try {
      execFileSync('tmux', ['has-session', '-t', TMUX_SESSION], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  // List all windows in the session (each window gets full viewport, unlike panes which share space)
  listPanes(): PaneInfo[] {
    if (!this.sessionExists()) {
      return []
    }

    try {
      // pane_title is deliberately NOT included: TUIs (notably Claude Code)
      // sometimes set it via OSC escapes to strings containing newlines or
      // tabs, which would shred our tab-delimited/newline-separated parser
      // and leave fields like currentCommand undefined. It's also unused
      // elsewhere in the codebase, so dropping it costs nothing.
      const FIELD_COUNT = 9
      const fmt = '#{window_id}\t#{session_name}:#{window_index}\t#{window_index}\t#{window_index}\t#{pane_current_path}\t#{pane_pid}\t#{pane_current_command}\t#{window_width}\t#{window_height}'
      const output = this.runTmux(['list-windows', '-t', TMUX_SESSION, '-F', fmt])

      const panes: PaneInfo[] = output.trim().split('\n').filter(Boolean).flatMap(line => {
        const parts = line.split('\t')
        // Defensive: if any remaining user-controlled field ever sneaks in a
        // tab or newline, skip the malformed row rather than crashing the
        // 2s runtime-state broadcast loop.
        if (parts.length < FIELD_COUNT) return []
        const [id, target, index, windowIndex, cwd, panePid, currentCommand, width, height] = parts
        if (!id || !target || !currentCommand) return []
        return [{
          id,
          target,
          index: parseInt(index, 10),
          windowIndex: parseInt(windowIndex, 10),
          cwd: cwd || '',
          panePid: parseInt(panePid, 10),
          currentCommand,
          paneTitle: '',
          width: parseInt(width, 10),
          height: parseInt(height, 10)
        }]
      })
      .sort((a, b) => a.windowIndex - b.windowIndex)

      this.cachedPanes = panes
      return panes
    } catch (error) {
      console.error('Failed to list windows:', error)
      return []
    }
  }

  // Get working directory for a specific pane
  getPaneWorkingDirectory(target: string): string {
    try {
      return this.runTmux(['display-message', '-t', target, '-p', '#{pane_current_path}']).trim()
    } catch (error) {
      console.error('Failed to get pane cwd:', error)
      return ''
    }
  }

  // Create a new window in the session. If cols/rows are supplied, the new
  // window is sized before the shell paints its first prompt, so the initial
  // prompt doesn't end up wrapped at tmux's default (wider) width. Scrollback
  // is cleared afterwards to drop any mis-wrapped scrap that slipped in
  // before the resize landed.
  createWindow(cwd = DEFAULT_CWD, cols?: number, rows?: number): PaneInfo | null {
    if (!this.sessionExists()) {
      console.error(`Tmux session '${TMUX_SESSION}' not found`)
      return null
    }

    try {
      const panes = this.listPanes()
      const nextIndex = panes.length > 0
        ? Math.max(...panes.map(pane => pane.windowIndex)) + 1
        : 0
      const target = `${TMUX_SESSION}:${nextIndex}`
      this.runTmux(['new-window', '-t', target, '-c', cwd])

      if (cols !== undefined) {
        try {
          this.runTmux(['set-window-option', '-t', target, 'window-size', 'manual'])
        } catch {
          // Older tmux may not support window-size manual; continue anyway.
        }
        const safeCols = Math.max(40, Math.min(300, Math.floor(cols)))
        const args = ['resize-window', '-t', target, '-x', String(safeCols)]
        if (rows !== undefined) {
          const safeRows = Math.max(10, Math.min(100, Math.floor(rows)))
          args.push('-y', String(safeRows))
        }
        try { this.runTmux(args) } catch (err) {
          console.error('Failed to resize new window:', err)
        }
        try { this.runTmux(['clear-history', '-t', target]) } catch {}
      }

      // Get the updated pane list and return the new rightmost window
      const updatedPanes = this.listPanes()
      return updatedPanes.find(pane => pane.windowIndex === nextIndex) || updatedPanes[updatedPanes.length - 1] || null
    } catch (error) {
      console.error('Failed to create window:', error)
      return null
    }
  }

  clearHistory(target: string): boolean {
    if (!this.sessionExists()) return false
    try {
      this.runTmux(['clear-history', '-t', target])
      return true
    } catch (error) {
      console.error('Failed to clear history:', error)
      return false
    }
  }

  // Close a window by target
  closeWindow(target: string): boolean {
    if (!this.sessionExists()) {
      console.error(`Tmux session '${TMUX_SESSION}' not found`)
      return false
    }

    try {
      this.runTmux(['kill-window', '-t', target])
      return true
    } catch (error) {
      console.error('Failed to close window:', error)
      return false
    }
  }

  // Send a message to Claude Code in tmux
  sendMessage(message: string, target?: string): boolean {
    if (!this.sessionExists()) {
      console.error(`Tmux session '${TMUX_SESSION}' not found`)
      return false
    }
    if (!target) {
      console.error('Refusing to send message without a pane target')
      return false
    }

    try {
      // Typing `clear` at a shell prompt should yield a visually clean canvas
      // — not an echoed "clear" line above a fresh prompt. Translate it to
      // Ctrl-L (clears the screen without echoing a command) plus
      // clear-history (drops scrollback). Skip the translation when Claude is
      // running so "clear" still reaches Claude's own input.
      if (message.trim() === 'clear') {
        try {
          const cmd = this.runTmux(['display-message', '-t', target, '-p', '#{pane_current_command}']).trim()
          if (this.isShellCommand(cmd)) {
            this.runTmux(['send-keys', '-t', target, 'C-l'])
            // Some zsh themes (p10k transient prompt, precmd hooks) redraw
            // asynchronously after Ctrl-L. Delay clear-history so any stale
            // prompt that lands in scrollback during that redraw is dropped
            // along with the earlier scrollback.
            const cleanupTarget = target
            setTimeout(() => {
              try { this.runTmux(['clear-history', '-t', cleanupTarget]) } catch {}
            }, 250)
            return true
          }
        } catch {
          // Fall through to the normal send path on any tmux error.
        }
      }

      // -l sends literal keys; argv form means no shell quoting needed
      this.runTmux(['send-keys', '-t', target, '-l', message])
      // C-m is the canonical tmux spelling of carriage return
      this.runTmux(['send-keys', '-t', target, 'C-m'])
      return true
    } catch (error) {
      console.error('Failed to send message:', error)
      return false
    }
  }

  // Whitelist of keys the client is allowed to send, mapped to tmux key names.
  private static readonly KEY_MAP: Record<string, string> = {
    'Up': 'Up',
    'Down': 'Down',
    'Left': 'Left',
    'Right': 'Right',
    'Enter': 'C-m',
    'Escape': 'Escape',
    'Tab': 'Tab',
    'S-Tab': 'BTab',      // Shift+Tab (cycle permissions mode)
    'Space': 'Space',
    'Backspace': 'BSpace',
  }

  // Send a special key (arrow keys, Enter, Escape, etc.). Returns false for unknown keys.
  sendKey(key: string, target?: string): boolean {
    if (!this.sessionExists()) {
      console.error(`Tmux session '${TMUX_SESSION}' not found`)
      return false
    }
    if (!target) {
      console.error('Refusing to send key without a pane target')
      return false
    }

    const tmuxKey = TmuxBridge.KEY_MAP[key]
    if (!tmuxKey) {
      console.error('Rejected unknown key:', key)
      return false
    }

    try {
      this.runTmux(['send-keys', '-t', target, tmuxKey])
      return true
    } catch (error) {
      console.error('Failed to send key:', error)
      return false
    }
  }

  // Capture current pane content with ANSI colors preserved
  capturePane(lines = CAPTURE_LINES, target?: string): string {
    try {
      const paneTarget = target || TMUX_SESSION
      // -e flag preserves escape sequences (ANSI colors)
      return this.runTmux(['capture-pane', '-t', paneTarget, '-p', '-e', '-S', `-${lines}`])
    } catch (error) {
      console.error('Failed to capture pane:', error)
      return ''
    }
  }

  // Start polling for output changes on all panes
  startPolling() {
    if (this.polling) return
    this.polling = true

    // Initialize with current panes
    const panes = this.listPanes()
    for (const pane of panes) {
      this.lastOutputByPane.set(pane.id, this.capturePane(CAPTURE_LINES, pane.target))
    }

    this.pollTimer = setInterval(() => {
      // Self-heal: recreate the tmux session if something killed it.
      this.ensureSession()
      // Refresh pane list periodically
      const currentPanes = this.listPanes()

      for (const pane of currentPanes) {
        const currentOutput = this.capturePane(CAPTURE_LINES, pane.target)
        const lastOutput = this.lastOutputByPane.get(pane.id) || ''

        if (currentOutput !== lastOutput) {
          this.emit('output', currentOutput, pane.id, pane.target)
          this.lastOutputByPane.set(pane.id, currentOutput)
        }
      }

      // Clean up removed panes from cache
      const currentPaneIds = new Set(currentPanes.map(p => p.id))
      for (const paneId of this.lastOutputByPane.keys()) {
        if (!currentPaneIds.has(paneId)) {
          this.lastOutputByPane.delete(paneId)
        }
      }
    }, POLL_INTERVAL)
  }

  // Stop polling
  stopPolling() {
    this.polling = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.lastOutputByPane.clear()
  }

  // Get full pane content (for initial load)
  getFullOutput(target?: string): string {
    return this.capturePane(CAPTURE_LINES, target)
  }

  private computePaneRuntimeState(pane: PaneInfo, listeningByPid?: Map<number, number[]>): PaneRuntimeState {
    const claudeRunning =
      this.isClaudeCommand(pane.currentCommand) ||
      this.looksLikeClaudeVersion(pane.currentCommand) ||
      this.hasClaudeProcessInTree(pane.panePid)
    const shellReady = !claudeRunning && this.isShellCommand(pane.currentCommand)

    // Claude and a listening dev server don't realistically share a pane
    // (both want the foreground), so skip the lsof pass when Claude is up.
    let serverRunning = false
    let serverCommand: string | null = null
    let serverPorts: ServerPort[] = []
    if (!claudeRunning) {
      const map = listeningByPid ?? this.listListeningByPid()
      const detected = this.detectServer(pane.panePid, map)
      if (detected) {
        serverRunning = true
        serverCommand = detected.command
        serverPorts = detected.ports
      }
    }

    return {
      claudeRunning,
      shellReady,
      currentCommand: pane.currentCommand,
      serverRunning,
      serverCommand,
      serverPorts
    }
  }

  private emptyRuntimeState(): PaneRuntimeState {
    return {
      claudeRunning: false,
      shellReady: false,
      currentCommand: '',
      serverRunning: false,
      serverCommand: null,
      serverPorts: []
    }
  }

  getPaneRuntimeState(target?: string): PaneRuntimeState {
    if (!target) return this.emptyRuntimeState()
    const pane = this.listPanes().find(p => p.target === target)
    if (!pane) return this.emptyRuntimeState()
    return this.computePaneRuntimeState(pane)
  }

  // Batch version used by periodic broadcast — one listPanes + one lsof + one ps pass.
  getAllPaneRuntimeStates(): Array<{ paneId: string; target: string } & PaneRuntimeState> {
    const listeningByPid = this.listListeningByPid()
    // Evict protocol cache entries whose ports are no longer listening, so
    // a new process reusing the same port gets re-probed rather than
    // inheriting the old process's classification.
    const activePorts = new Set<number>()
    for (const ports of listeningByPid.values()) {
      for (const p of ports) activePorts.add(p)
    }
    this.gcProtocolCache(activePorts)
    return this.listPanes().map(pane => ({
      paneId: pane.id,
      target: pane.target,
      ...this.computePaneRuntimeState(pane, listeningByPid)
    }))
  }

  // Ctrl-C the pane's foreground process. Detection catches up on the next
  // runtime-state cycle and the UI flips back to the normal state.
  stopServer(target: string): boolean {
    if (!this.sessionExists() || !target) return false
    try {
      this.runTmux(['send-keys', '-t', target, 'C-c'])
      return true
    } catch (error) {
      console.error('Failed to stop server:', error)
      return false
    }
  }

  // Capture the shell-level command BEFORE Ctrl-C — once the process is gone
  // we can't look it up — then after a short beat re-type it at the prompt.
  // C-u first flushes any half-typed input so the replayed command runs
  // cleanly even if the user was mid-keystroke when they pressed Restart.
  restartServer(target: string): boolean {
    if (!this.sessionExists() || !target) return false
    const pane = this.listPanes().find(p => p.target === target)
    if (!pane) return false

    const detected = this.detectServer(pane.panePid, this.listListeningByPid())
    if (!detected) {
      console.error('No server command found to restart for pane', target)
      return false
    }
    const command = detected.command

    try {
      this.runTmux(['send-keys', '-t', target, 'C-c'])
    } catch (error) {
      console.error('Failed to send C-c for restart:', error)
      return false
    }

    setTimeout(() => {
      try {
        this.runTmux(['send-keys', '-t', target, 'C-u'])
        this.runTmux(['send-keys', '-t', target, '-l', command])
        this.runTmux(['send-keys', '-t', target, 'C-m'])
      } catch (err) {
        console.error('Failed to replay server command:', err)
      }
    }, 250)
    return true
  }

  // Check if Claude Code is running in the pane's process tree.
  isClaudeRunning(target?: string): boolean {
    return this.getPaneRuntimeState(target).claudeRunning
  }

  // Detect current Claude Code permission mode from output
  detectMode(target?: string): 'plan' | 'normal' | 'auto-edit' | 'bypass' {
    const output = this.capturePane(30, target).replace(ANSI_RE, '')

    // The actual indicator looks like: ">> bypass permissions on (shift+tab to cycle)"
    const modeLineMatch = output.match(/.*(shift\s*\+\s*tab).*/i)
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

  // Get cached pane list (from last poll)
  getCachedPanes(): PaneInfo[] {
    return this.cachedPanes
  }

  // Resize the tmux window to match browser width
  // Uses resize-window with window-size=manual to allow sizes larger than attached client
  resizePane(cols: number, rows?: number, target?: string): boolean {
    if (!this.sessionExists()) {
      return false
    }
    if (!target) {
      console.error('Refusing to resize without a pane target')
      return false
    }

    try {
      // Set window-size to manual to allow arbitrary sizing (allow failure)
      try {
        this.runTmux(['set-window-option', '-t', target, 'window-size', 'manual'])
      } catch {
        // Older tmux versions may not support window-size manual; continue anyway
      }

      // Clamp columns to reasonable range
      const safeCols = Math.max(40, Math.min(300, cols))

      // Use resize-window instead of resize-pane - this works regardless of attached client size
      const args = ['resize-window', '-t', target, '-x', String(safeCols)]
      if (rows !== undefined) {
        const safeRows = Math.max(10, Math.min(100, rows))
        args.push('-y', String(safeRows))
      }
      this.runTmux(args)
      return true
    } catch (error) {
      console.error('Failed to resize window:', error)
      return false
    }
  }

  // Select/activate a window in tmux (makes it visible in terminal)
  selectWindow(target: string): boolean {
    if (!this.sessionExists()) {
      return false
    }

    try {
      this.runTmux(['select-window', '-t', target])
      return true
    } catch (error) {
      console.error('Failed to select window:', error)
      return false
    }
  }

  // Get current pane dimensions
  getPaneDimensions(target?: string): { cols: number; rows: number } | null {
    try {
      const paneTarget = target || TMUX_SESSION
      const output = this.runTmux(['display-message', '-t', paneTarget, '-p', '#{pane_width} #{pane_height}']).trim()
      const [cols, rows] = output.split(' ').map(Number)
      return { cols, rows }
    } catch {
      return null
    }
  }
}

export const tmuxBridge = new TmuxBridge()
