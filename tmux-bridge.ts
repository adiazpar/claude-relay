import { execSync, exec } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'

const TMUX_SESSION = process.env.TMUX_SESSION || 'dev'
const POLL_INTERVAL = 500 // ms
const CAPTURE_LINES = 500 // lines

export class TmuxBridge extends EventEmitter {
  private lastOutput = ''
  private polling = false
  private pollTimer: NodeJS.Timeout | null = null

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

  // Send a message to Claude Code in tmux
  sendMessage(message: string): boolean {
    if (!this.sessionExists()) {
      console.error(`Tmux session '${TMUX_SESSION}' not found`)
      return false
    }

    try {
      // Escape special characters for tmux
      const escaped = this.escapeForTmux(message)

      // Send the message to the tmux pane
      execSync(`tmux send-keys -t ${TMUX_SESSION} -l ${escaped}`)
      // Press Enter to submit
      execSync(`tmux send-keys -t ${TMUX_SESSION} Enter`)

      return true
    } catch (error) {
      console.error('Failed to send message:', error)
      return false
    }
  }

  // Send a special key (arrow keys, Enter, Escape, etc.)
  sendKey(key: string): boolean {
    if (!this.sessionExists()) {
      console.error(`Tmux session '${TMUX_SESSION}' not found`)
      return false
    }

    try {
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
      execSync(`tmux send-keys -t ${TMUX_SESSION} ${tmuxKey}`)
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
  capturePane(lines = 500): string {
    try {
      const output = execSync(
        `tmux capture-pane -t ${TMUX_SESSION} -p -e -S -${lines}`,
        // -e flag preserves escape sequences (ANSI colors)
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      )
      return output
    } catch (error) {
      console.error('Failed to capture pane:', error)
      return ''
    }
  }

  // Start polling for output changes
  startPolling() {
    if (this.polling) return
    this.polling = true
    this.lastOutput = this.capturePane(CAPTURE_LINES)

    this.pollTimer = setInterval(() => {
      const currentOutput = this.capturePane(CAPTURE_LINES)

      if (currentOutput !== this.lastOutput) {
        this.emit('output', currentOutput)
        this.lastOutput = currentOutput
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
  getFullOutput(): string {
    return this.capturePane()
  }

  // Check if Claude Code is running (look for characteristic output)
  isClaudeRunning(): boolean {
    const output = this.capturePane(50)
    // Look for Claude Code indicators
    return output.includes('Claude') ||
           output.includes('bypass permissions') ||
           output.includes('Opus') ||
           output.includes('Sonnet')
  }

  // Detect current Claude Code permission mode from output
  detectMode(): 'plan' | 'normal' | 'auto-edit' | 'bypass' {
    const output = this.capturePane(30)

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

  // Resize the tmux window to match browser width
  // Uses resize-window with window-size=manual to allow sizes larger than attached client
  resizePane(cols: number, rows?: number): boolean {
    if (!this.sessionExists()) {
      return false
    }

    try {
      // Set window-size to manual to allow arbitrary sizing
      execSync(`tmux set-window-option -t ${TMUX_SESSION} window-size manual 2>/dev/null || true`)

      // Clamp columns to reasonable range
      const safeCols = Math.max(40, Math.min(300, cols))

      // Use resize-window instead of resize-pane - this works regardless of attached client size
      if (rows) {
        const safeRows = Math.max(10, Math.min(100, rows))
        execSync(`tmux resize-window -t ${TMUX_SESSION} -x ${safeCols} -y ${safeRows}`)
      } else {
        execSync(`tmux resize-window -t ${TMUX_SESSION} -x ${safeCols}`)
      }

      return true
    } catch (error) {
      console.error('Failed to resize window:', error)
      return false
    }
  }

  // Get current pane dimensions
  getPaneDimensions(): { cols: number; rows: number } | null {
    try {
      const output = execSync(
        `tmux display-message -t ${TMUX_SESSION} -p '#{pane_width} #{pane_height}'`,
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
