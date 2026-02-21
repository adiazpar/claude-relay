import { execSync, exec } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'

const TMUX_SESSION = process.env.TMUX_SESSION || 'dev'
const POLL_INTERVAL = 500 // ms
const CAPTURE_LINES = 500 // lines

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

  // Check if tmux session exists
  sessionExists(): boolean {
    try {
      execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`)
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
      // Use list-windows instead of list-panes so each "pane" is a full-size window
      // #{pane_current_path} gets the cwd of the active pane in each window
      const output = execSync(
        `tmux list-windows -t ${TMUX_SESSION} -F "#{window_id}\t#{session_name}:#{window_index}\t#{window_index}\t#{window_index}\t#{pane_current_path}\t#{window_width}\t#{window_height}"`,
        { encoding: 'utf-8' }
      )

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
      const output = execSync(
        `tmux display-message -t ${target} -p "#{pane_current_path}"`,
        { encoding: 'utf-8' }
      ).trim()
      return output
    } catch (error) {
      console.error('Failed to get pane cwd:', error)
      return ''
    }
  }

  // Create a new window in the session
  createWindow(cwd?: string): PaneInfo | null {
    if (!this.sessionExists()) {
      console.error(`Tmux session '${TMUX_SESSION}' not found`)
      return null
    }

    try {
      // Create new window, optionally in a specific directory
      if (cwd) {
        execSync(`tmux new-window -t ${TMUX_SESSION} -c '${cwd.replace(/'/g, "'\\''")}'`)
      } else {
        execSync(`tmux new-window -t ${TMUX_SESSION}`)
      }

      // Get the updated pane list and return the new window (last one)
      const panes = this.listPanes()
      return panes[panes.length - 1] || null
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
      execSync(`tmux kill-window -t ${target}`)
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
      // Escape special characters for tmux
      const escaped = this.escapeForTmux(message)

      // Send the message to the tmux pane
      execSync(`tmux send-keys -t ${paneTarget} -l ${escaped}`)
      // Press Enter to submit
      execSync(`tmux send-keys -t ${paneTarget} Enter`)

      return true
    } catch (error) {
      console.error('Failed to send message:', error)
      return false
    }
  }

  // Send a special key (arrow keys, Enter, Escape, etc.)
  sendKey(key: string, target?: string): boolean {
    if (!this.sessionExists()) {
      console.error(`Tmux session '${TMUX_SESSION}' not found`)
      return false
    }

    try {
      const paneTarget = target || TMUX_SESSION
      // Map key names to tmux key names
      const keyMap: Record<string, string> = {
        'Up': 'Up',
        'Down': 'Down',
        'Left': 'Left',
        'Right': 'Right',
        'Enter': 'Enter',
        'Escape': 'Escape',
        'Tab': 'Tab',
        'S-Tab': 'BTab',      // Shift+Tab (cycle permissions mode)
        'Space': 'Space',
        'Backspace': 'BSpace',
      }

      const tmuxKey = keyMap[key] || key
      execSync(`tmux send-keys -t ${paneTarget} ${tmuxKey}`)
      return true
    } catch (error) {
      console.error('Failed to send key:', error)
      return false
    }
  }

  // Escape message for tmux send-keys -l (literal mode)
  private escapeForTmux(message: string): string {
    // For -l (literal) mode, we just need to quote the string
    // Replace single quotes with escaped version
    const escaped = message.replace(/'/g, "'\\''")
    return `'${escaped}'`
  }

  // Capture current pane content with ANSI colors preserved
  capturePane(lines = 500, target?: string): string {
    try {
      const paneTarget = target || TMUX_SESSION
      const output = execSync(
        `tmux capture-pane -t ${paneTarget} -p -e -S -${lines}`,
        // -e flag preserves escape sequences (ANSI colors)
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      )
      return output
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
  }

  // Extract new content from output diff
  private getNewContent(oldOutput: string, newOutput: string): string {
    const oldLines = oldOutput.split('\n')
    const newLines = newOutput.split('\n')

    // Find where they diverge
    let i = 0
    while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) {
      i++
    }

    // Return new lines
    return newLines.slice(i).join('\n').trim()
  }

  // Get full pane content (for initial load)
  getFullOutput(target?: string): string {
    return this.capturePane(CAPTURE_LINES, target)
  }

  // Check if Claude Code is running (look for the mode indicator unique to Claude Code UI)
  isClaudeRunning(target?: string): boolean {
    const output = this.capturePane(50, target)
    // Look for Claude Code's mode selector "(shift+tab to cycle)" which is unique to its UI
    return /shift\+tab/i.test(output)
  }

  // Detect current Claude Code permission mode from output
  detectMode(target?: string): 'plan' | 'normal' | 'auto-edit' | 'bypass' {
    const output = this.capturePane(30, target)

    // Look for the mode indicator line which contains "(shift+tab" to avoid false matches
    // The actual indicator looks like: ">> bypass permissions on (shift+tab to cycle)"
    const modeLineMatch = output.match(/.*(shift\+tab|shift\s*\+\s*tab).*/i)
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
      // Set window-size to manual to allow arbitrary sizing
      execSync(`tmux set-window-option -t ${paneTarget} window-size manual 2>/dev/null || true`)

      // Clamp columns to reasonable range
      const safeCols = Math.max(40, Math.min(300, cols))

      // Use resize-window instead of resize-pane - this works regardless of attached client size
      if (rows) {
        const safeRows = Math.max(10, Math.min(100, rows))
        execSync(`tmux resize-window -t ${paneTarget} -x ${safeCols} -y ${safeRows}`)
      } else {
        execSync(`tmux resize-window -t ${paneTarget} -x ${safeCols}`)
      }

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
      execSync(`tmux select-window -t ${target}`)
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
      const output = execSync(
        `tmux display-message -t ${paneTarget} -p '#{pane_width} #{pane_height}'`,
        { encoding: 'utf-8' }
      ).trim()
      const [cols, rows] = output.split(' ').map(Number)
      return { cols, rows }
    } catch {
      return null
    }
  }
}

export const tmuxBridge = new TmuxBridge()
