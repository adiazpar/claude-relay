import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import { TMUX_SESSION } from './config.js'
import { getAgents } from './agents.js'
import {
  SessionBridge, PaneInfo, PaneRuntimeState, PaneRuntimeRow, ServerPort,
  AgentMode, CreateWindowOptions, emptyRuntimeState
} from './bridge.js'
import {
  ProcessEntry, ProtocolProber, detectAgentInTree, detectServerInTree,
  detectModeFromOutput, matchesAgent, looksLikeVersionTitle, isShellCommand
} from './detection.js'

const DEFAULT_CWD = process.env.HOME || '/'
const POLL_INTERVAL = 500 // ms
const CAPTURE_LINES = 500 // lines
const MAX_BUFFER = 10 * 1024 * 1024

// The POSIX bridge: drives a tmux server. All tmux/ps/lsof calls are
// synchronous under the hood; the SessionBridge interface is async only
// because the Windows implementation is pipe-RPC.
export class TmuxBridge extends EventEmitter implements SessionBridge {
  private lastOutputByPane = new Map<string, string>()
  private polling = false
  private pollTimer: NodeJS.Timeout | null = null
  private prober = new ProtocolProber()
  // Cooldown between auto-recreate attempts so a repeatedly-failing tmux
  // invocation (e.g. tmux binary missing) doesn't hammer execFileSync every
  // poll tick. Reset on successful recreate.
  private lastSessionRecreateAttempt = 0
  private static readonly SESSION_RECREATE_COOLDOWN_MS = 5000

  constructor() {
    super()
    this.prober.on('resolved', (port: number, protocol: 'https') => {
      this.emit('protocolResolved', port, protocol)
    })
  }

  // If the tmux session has disappeared (user ran tmux kill-session or
  // kill-server, or the tmux server crashed), create a fresh one so the
  // relay has something to talk to. Rate-limited to avoid thrashing when
  // recreation itself fails. Emits 'sessionRecreated' so the server can
  // push a fresh paneList to connected clients — otherwise they'd sit on
  // stale pane IDs until a manual refresh.
  private ensureSession(): boolean {
    if (this.sessionExistsSync()) return true
    const now = Date.now()
    if (now - this.lastSessionRecreateAttempt < TmuxBridge.SESSION_RECREATE_COOLDOWN_MS) {
      return false
    }
    this.lastSessionRecreateAttempt = now
    try {
      this.runTmux(['new-session', '-d', '-s', TMUX_SESSION, '-c', DEFAULT_CWD])
      console.log(`Recreated tmux session '${TMUX_SESSION}' after it went missing`)
      this.lastOutputByPane.clear()
      this.prober.clear()
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

  private listProcesses(): ProcessEntry[] {
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
      }).filter((row): row is ProcessEntry => row !== null)
    } catch (error) {
      console.error('Failed to list processes:', error)
      return []
    }
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

  // Which registered agent (if any) is running in this pane. Three signals,
  // any of which is sufficient, checked in order:
  //   1. pane_current_command word-matches an agent's binary name (rare —
  //      only when the launch preserves the binary name as process title).
  //   2. pane_current_command looks like a bare semver and an agent has the
  //      versionTitle quirk (Claude Code's process.title override — the
  //      most common hit for an active session).
  //   3. A walk of the pane's process tree finds a process whose command
  //      matches an agent's binary (fallback for wrappers and the brief
  //      window before the TUI sets its title).
  // Never detect by sending shell commands into the pane — when an agent
  // TUI is attached, send-keys lands in its chat input, not a shell.
  private detectAgentForPane(pane: PaneInfo, processes?: ProcessEntry[]): string | null {
    const agents = getAgents()

    for (const agent of agents) {
      if (matchesAgent(agent, pane.currentCommand)) return agent.id
    }
    if (looksLikeVersionTitle(pane.currentCommand)) {
      const versionAgent = agents.find(a => a.versionTitle)
      if (versionAgent) return versionAgent.id
    }

    return detectAgentInTree(pane.panePid, agents, processes ?? this.listProcesses())
  }

  private sessionExistsSync(): boolean {
    try {
      execFileSync('tmux', ['has-session', '-t', TMUX_SESSION], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  async sessionExists(): Promise<boolean> {
    return this.sessionExistsSync()
  }

  // List all windows in the session (each window gets full viewport, unlike panes which share space)
  private listPanesSync(): PaneInfo[] {
    if (!this.sessionExistsSync()) {
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

      return panes
    } catch (error) {
      console.error('Failed to list windows:', error)
      return []
    }
  }

  async listPanes(): Promise<PaneInfo[]> {
    return this.listPanesSync()
  }

  // Create a new window in the session. If cols/rows are supplied, the new
  // window is sized before the shell paints its first prompt, so the initial
  // prompt doesn't end up wrapped at tmux's default (wider) width. Scrollback
  // is cleared afterwards to drop any mis-wrapped scrap that slipped in
  // before the resize landed. shellId is a Windows concept and ignored here —
  // tmux windows always run the user's default shell.
  async createWindow(opts: CreateWindowOptions = {}): Promise<PaneInfo | null> {
    const { cwd = DEFAULT_CWD, cols, rows } = opts
    if (!this.sessionExistsSync()) {
      console.error(`Tmux session '${TMUX_SESSION}' not found`)
      return null
    }

    try {
      const panes = this.listPanesSync()
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
      const updatedPanes = this.listPanesSync()
      return updatedPanes.find(pane => pane.windowIndex === nextIndex) || updatedPanes[updatedPanes.length - 1] || null
    } catch (error) {
      console.error('Failed to create window:', error)
      return null
    }
  }

  async clearHistory(target: string): Promise<boolean> {
    if (!this.sessionExistsSync()) return false
    try {
      this.runTmux(['clear-history', '-t', target])
      return true
    } catch (error) {
      console.error('Failed to clear history:', error)
      return false
    }
  }

  // Close a window by target
  async closeWindow(target: string): Promise<boolean> {
    if (!this.sessionExistsSync()) {
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

  // Send a message into a tmux pane (an agent TUI or a plain shell). When
  // imagePaths has entries, their absolute paths are prepended
  // space-separated to the payload so Claude Code's TUI detects them as
  // image attachments (same buffer content as one or more drag-and-drops).
  async sendMessage(message: string, target?: string, imagePaths?: string[]): Promise<boolean> {
    if (!this.sessionExistsSync()) {
      console.error(`Tmux session '${TMUX_SESSION}' not found`)
      return false
    }
    if (!target) {
      console.error('Refusing to send message without a pane target')
      return false
    }

    const hasImages = !!imagePaths && imagePaths.length > 0

    try {
      // Typing `clear` at a shell prompt should yield a visually clean canvas
      // — not an echoed "clear" line above a fresh prompt. Translate it to
      // Ctrl-L (clears the screen without echoing a command) plus
      // clear-history (drops scrollback). Skip the translation when Claude is
      // running so "clear" still reaches Claude's own input. Also skip when
      // any image is attached — `clear` is only meaningful as a bare command.
      if (!hasImages && message.trim() === 'clear') {
        try {
          const cmd = this.runTmux(['display-message', '-t', target, '-p', '#{pane_current_command}']).trim()
          if (isShellCommand(cmd)) {
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

      const prefix = hasImages ? imagePaths!.join(' ') : ''
      const payload = hasImages
        ? (message.length > 0 ? `${prefix} ${message}` : prefix)
        : message

      // -l sends literal keys; argv form means no shell quoting needed
      this.runTmux(['send-keys', '-t', target, '-l', payload])
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
  async sendKey(key: string, target?: string): Promise<boolean> {
    if (!this.sessionExistsSync()) {
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
  private capturePane(lines = CAPTURE_LINES, target?: string): string {
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
    const panes = this.listPanesSync()
    for (const pane of panes) {
      this.lastOutputByPane.set(pane.id, this.capturePane(CAPTURE_LINES, pane.target))
    }

    this.pollTimer = setInterval(() => {
      // Self-heal: recreate the tmux session if something killed it.
      this.ensureSession()
      // Refresh pane list periodically
      const currentPanes = this.listPanesSync()

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
  async getFullOutput(target?: string): Promise<string> {
    return this.capturePane(CAPTURE_LINES, target)
  }

  private computePaneRuntimeState(pane: PaneInfo, listeningByPid?: Map<number, number[]>, processes?: ProcessEntry[]): PaneRuntimeState {
    const agentId = this.detectAgentForPane(pane, processes)
    const shellReady = !agentId && isShellCommand(pane.currentCommand)

    // An agent TUI and a listening dev server don't realistically share a
    // pane (both want the foreground), so skip the lsof pass when one is up.
    let serverRunning = false
    let serverCommand: string | null = null
    let serverPorts: ServerPort[] = []
    if (!agentId) {
      const map = listeningByPid ?? this.listListeningByPid()
      const detected = detectServerInTree(pane.panePid, map, processes ?? this.listProcesses(), this.prober.getPortProtocol)
      if (detected) {
        serverRunning = true
        serverCommand = detected.command
        serverPorts = detected.ports
      }
    }

    return {
      agentId,
      shellReady,
      currentCommand: pane.currentCommand,
      serverRunning,
      serverCommand,
      serverPorts
    }
  }

  async getPaneRuntimeState(target?: string): Promise<PaneRuntimeState> {
    if (!target) return emptyRuntimeState()
    const pane = this.listPanesSync().find(p => p.target === target)
    if (!pane) return emptyRuntimeState()
    return this.computePaneRuntimeState(pane)
  }

  // Batch version used by periodic broadcast — one listPanes + one lsof + one ps pass.
  async getAllPaneRuntimeStates(): Promise<PaneRuntimeRow[]> {
    const listeningByPid = this.listListeningByPid()
    // Evict protocol cache entries whose ports are no longer listening, so
    // a new process reusing the same port gets re-probed rather than
    // inheriting the old process's classification.
    const activePorts = new Set<number>()
    for (const ports of listeningByPid.values()) {
      for (const p of ports) activePorts.add(p)
    }
    this.prober.gc(activePorts)
    const processes = this.listProcesses()
    return this.listPanesSync().map(pane => ({
      paneId: pane.id,
      target: pane.target,
      ...this.computePaneRuntimeState(pane, listeningByPid, processes)
    }))
  }

  // Ctrl-C the pane's foreground process. Detection catches up on the next
  // runtime-state cycle and the UI flips back to the normal state.
  async stopServer(target: string): Promise<boolean> {
    if (!this.sessionExistsSync() || !target) return false
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
  async restartServer(target: string): Promise<boolean> {
    if (!this.sessionExistsSync() || !target) return false
    const pane = this.listPanesSync().find(p => p.target === target)
    if (!pane) return false

    const detected = detectServerInTree(pane.panePid, this.listListeningByPid(), this.listProcesses(), this.prober.getPortProtocol)
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

  // Detect current Claude Code permission mode from output.
  async detectMode(target?: string): Promise<AgentMode> {
    return detectModeFromOutput(this.capturePane(30, target))
  }

  // Resize the tmux window to match browser width
  // Uses resize-window with window-size=manual to allow sizes larger than attached client
  async resizePane(cols: number, rows?: number, target?: string): Promise<boolean> {
    if (!this.sessionExistsSync()) {
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
  async selectWindow(target: string): Promise<boolean> {
    if (!this.sessionExistsSync()) {
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
}
