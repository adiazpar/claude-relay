import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'

const TMUX_SESSION = process.env.TMUX_SESSION || 'dev'
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
  width: number
  height: number
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
      const fmt = '#{window_id}\t#{session_name}:#{window_index}\t#{window_index}\t#{window_index}\t#{pane_current_path}\t#{window_width}\t#{window_height}'
      const output = this.runTmux(['list-windows', '-t', TMUX_SESSION, '-F', fmt])

      const panes: PaneInfo[] = output.trim().split('\n').filter(Boolean).map(line => {
        const [id, target, index, windowIndex, cwd, width, height] = line.split('\t')
        return {
          id,
          target,
          index: parseInt(index, 10),
          windowIndex: parseInt(windowIndex, 10),
          cwd,
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

  // Create a new window in the session
  createWindow(cwd = '/'): PaneInfo | null {
    if (!this.sessionExists()) {
      console.error(`Tmux session '${TMUX_SESSION}' not found`)
      return null
    }

    try {
      const panes = this.listPanes()
      const nextIndex = panes.length > 0
        ? Math.max(...panes.map(pane => pane.windowIndex)) + 1
        : 0
      const args = ['new-window', '-t', `${TMUX_SESSION}:${nextIndex}`, '-c', cwd]
      this.runTmux(args)

      // Get the updated pane list and return the new rightmost window
      const updatedPanes = this.listPanes()
      return updatedPanes.find(pane => pane.windowIndex === nextIndex) || updatedPanes[updatedPanes.length - 1] || null
    } catch (error) {
      console.error('Failed to create window:', error)
      return null
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

    try {
      const paneTarget = target || TMUX_SESSION
      // -l sends literal keys; argv form means no shell quoting needed
      this.runTmux(['send-keys', '-t', paneTarget, '-l', message])
      // C-m is the canonical tmux spelling of carriage return
      this.runTmux(['send-keys', '-t', paneTarget, 'C-m'])
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

    const tmuxKey = TmuxBridge.KEY_MAP[key]
    if (!tmuxKey) {
      console.error('Rejected unknown key:', key)
      return false
    }

    try {
      const paneTarget = target || TMUX_SESSION
      this.runTmux(['send-keys', '-t', paneTarget, tmuxKey])
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

  // Check if Claude Code is running (look for the mode indicator unique to Claude Code UI)
  isClaudeRunning(target?: string): boolean {
    const output = this.capturePane(50, target).replace(ANSI_RE, '')
    // Look for Claude Code's mode selector "(shift+tab to cycle)" which is unique to its UI
    return /shift\s*\+\s*tab/i.test(output)
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

    try {
      const paneTarget = target || TMUX_SESSION

      // Set window-size to manual to allow arbitrary sizing (allow failure)
      try {
        this.runTmux(['set-window-option', '-t', paneTarget, 'window-size', 'manual'])
      } catch {
        // Older tmux versions may not support window-size manual; continue anyway
      }

      // Clamp columns to reasonable range
      const safeCols = Math.max(40, Math.min(300, cols))

      // Use resize-window instead of resize-pane - this works regardless of attached client size
      const args = ['resize-window', '-t', paneTarget, '-x', String(safeCols)]
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
