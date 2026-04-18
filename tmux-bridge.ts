import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'

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

export interface PaneRuntimeState {
  claudeRunning: boolean
  shellReady: boolean
  currentCommand: string
  serverRunning: boolean
  serverCommand: string | null
}

export class TmuxBridge extends EventEmitter {
  private lastOutputByPane = new Map<string, string>()
  private polling = false
  private pollTimer: NodeJS.Timeout | null = null
  private cachedPanes: PaneInfo[] = []

  constructor() {
    super()
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

  private isClaudeCommand(command: string): boolean {
    const normalized = command.trim().toLowerCase()
    return /(^|[\/\s])claude($|\s)/.test(normalized)
  }

  // Claude Code sets process.title to its version string (e.g. "2.1.114"),
  // which is what tmux reports as pane_current_command.
  private looksLikeClaudeVersion(command: string): boolean {
    return /^\d+\.\d+\.\d+/.test(command.trim())
  }

  private isShellCommand(command: string): boolean {
    const normalized = command.trim().toLowerCase()
    return /(^|\/)(bash|zsh|sh|fish|ksh|tcsh|csh|dash|nu)$/.test(normalized)
  }

  // All PIDs currently listening on a TCP socket, system-wide. One lsof
  // call per detection cycle is cheaper than per-pane queries, and the
  // caller intersects this against each pane's own process tree — so a
  // backend server in pane A and a frontend server in pane B never cross
  // streams.
  private listListeningPids(): Set<number> {
    try {
      const output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fp'], {
        encoding: 'utf-8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const pids = new Set<number>()
      for (const line of output.split('\n')) {
        if (line.startsWith('p')) {
          const pid = parseInt(line.slice(1), 10)
          if (Number.isInteger(pid) && pid > 0) pids.add(pid)
        }
      }
      return pids
    } catch {
      // lsof missing or blocked — server detection is a best-effort signal,
      // treat it as "no servers visible" and fall through to normal UI.
      return new Set()
    }
  }

  // Given a pane's shell pid and the global set of listening pids, find the
  // shell-level command the user typed to start a server. Walks each direct
  // child of the shell; if any descendant of that child is a listener, the
  // child's own argv is the shell-level command. This preserves the user's
  // intent for wrapped invocations (`npm run dev` → node listens, but we
  // return `npm run dev`) while still giving the exact string for direct
  // invocations (`python3 manage.py runserver` IS the listener).
  private findServerShellCommand(panePid: number, listeningPids: Set<number>): string | null {
    if (!Number.isInteger(panePid) || panePid <= 0) return null
    if (listeningPids.size === 0) return null

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
      while (stack.length > 0) {
        const pid = stack.pop()!
        if (seen.has(pid)) continue
        seen.add(pid)
        if (listeningPids.has(pid)) {
          return child.command.trim()
        }
        const kids = byParent.get(pid) || []
        for (const k of kids) stack.push(k.pid)
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
      const fmt = '#{window_id}\t#{session_name}:#{window_index}\t#{window_index}\t#{window_index}\t#{pane_current_path}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}\t#{window_width}\t#{window_height}'
      const output = this.runTmux(['list-windows', '-t', TMUX_SESSION, '-F', fmt])

      const panes: PaneInfo[] = output.trim().split('\n').filter(Boolean).map(line => {
        const [id, target, index, windowIndex, cwd, panePid, currentCommand, paneTitle, width, height] = line.split('\t')
        return {
          id,
          target,
          index: parseInt(index, 10),
          windowIndex: parseInt(windowIndex, 10),
          cwd,
          panePid: parseInt(panePid, 10),
          currentCommand,
          paneTitle: paneTitle || '',
          width: parseInt(width, 10),
          height: parseInt(height, 10)
        }
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

  private computePaneRuntimeState(pane: PaneInfo, listeningPids?: Set<number>): PaneRuntimeState {
    const claudeRunning =
      this.isClaudeCommand(pane.currentCommand) ||
      this.looksLikeClaudeVersion(pane.currentCommand) ||
      this.hasClaudeProcessInTree(pane.panePid)
    const shellReady = !claudeRunning && this.isShellCommand(pane.currentCommand)

    // Claude and a listening dev server don't realistically share a pane
    // (both want the foreground), so skip the lsof pass when Claude is up.
    // Also lets the single-pane path use a fresh lsof lookup only when
    // truly needed.
    let serverRunning = false
    let serverCommand: string | null = null
    if (!claudeRunning) {
      const pids = listeningPids ?? this.listListeningPids()
      serverCommand = this.findServerShellCommand(pane.panePid, pids)
      serverRunning = serverCommand !== null
    }

    return {
      claudeRunning,
      shellReady,
      currentCommand: pane.currentCommand,
      serverRunning,
      serverCommand
    }
  }

  private emptyRuntimeState(): PaneRuntimeState {
    return {
      claudeRunning: false,
      shellReady: false,
      currentCommand: '',
      serverRunning: false,
      serverCommand: null
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
    const listeningPids = this.listListeningPids()
    return this.listPanes().map(pane => ({
      paneId: pane.id,
      target: pane.target,
      ...this.computePaneRuntimeState(pane, listeningPids)
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

    const command = this.findServerShellCommand(pane.panePid, this.listListeningPids())
    if (!command) {
      console.error('No server command found to restart for pane', target)
      return false
    }

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
