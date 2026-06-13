import { EventEmitter } from 'events'

// Platform-neutral contract between server.ts and a terminal backend.
// TmuxBridge (macOS/Linux) talks to a tmux server; WinBridge (Windows)
// talks to the pane-host daemon over a named pipe. Methods are
// promise-based because the Windows side is pipe-RPC — the tmux
// implementation simply wraps its synchronous tmux calls.

export interface PaneInfo {
  id: string           // e.g. "@0" (tmux window id) or "w0" (pane-host)
  target: string       // e.g. "dev:0" — stable addressing token for the pane
  index: number
  windowIndex: number
  cwd: string
  panePid: number      // pid of the pane's process tree root
  currentCommand: string // foreground command name (tmux) or shell binary (win)
  paneTitle: string
  width: number
  height: number
  shellId?: string     // which registered shell the pane runs (Windows only)
}

export interface ServerPort {
  port: number
  protocol: 'http' | 'https'
}

export interface PaneRuntimeState {
  // id of the registered agent detected in this pane, or null when no
  // agent TUI is running (shell prompt, dev server, arbitrary process).
  agentId: string | null
  shellReady: boolean
  currentCommand: string
  serverRunning: boolean
  serverCommand: string | null
  serverPorts: ServerPort[]
  // Current agent mode (plan/normal/auto-edit/bypass), or null when no agent.
  // Carried on the runtime-state broadcast so the Mode button updates without
  // a dedicated output-frame channel (xterm.js owns rendering now).
  mode: AgentMode | null
}

export type PaneRuntimeRow = { paneId: string; target: string } & PaneRuntimeState

export type AgentMode = 'plan' | 'normal' | 'auto-edit' | 'bypass'

export interface CreateWindowOptions {
  cwd?: string
  cols?: number
  rows?: number
  shellId?: string
}

// Events emitted by every bridge:
//   'protocolResolved' (port: number, protocol: 'https')
//   'sessionRecreated' ()
// Live terminal output is delivered through subscribeOutput (NOT an event),
// so it never collides with the EventEmitter channels above.
export interface SessionBridge extends EventEmitter {
  sessionExists(): Promise<boolean>
  listPanes(): Promise<PaneInfo[]>
  createWindow(opts?: CreateWindowOptions): Promise<PaneInfo | null>
  clearHistory(target: string): Promise<boolean>
  closeWindow(target: string): Promise<boolean>
  sendMessage(message: string, target?: string, imagePaths?: string[]): Promise<boolean>
  sendKey(key: string, target?: string): Promise<boolean>
  getFullOutput(target?: string): Promise<string>
  detectMode(target?: string): Promise<AgentMode>
  resizePane(cols: number, rows?: number, target?: string): Promise<boolean>
  // Subscribe to live VT output for ALL panes (one global subscription; the
  // relay fans out to clients by active pane). Returns an unsubscribe fn.
  subscribeOutput(handler: (paneId: string, data: string) => void): () => void
  // The pane's ring-buffer history, replayed into a freshly-attached xterm.js
  // terminal on connect/switch so the client sees scrollback.
  getReplay(paneId: string): Promise<string>
  // Make the pane visible to a locally-attached terminal client. tmux
  // selects the window; the Windows pane-host has no attach concept, so
  // its implementation is a no-op.
  selectWindow(target: string): Promise<boolean>
  setTypingState(isTyping: boolean): void
  getPaneRuntimeState(target?: string): Promise<PaneRuntimeState>
  getAllPaneRuntimeStates(): Promise<PaneRuntimeRow[]>
  stopServer(target: string): Promise<boolean>
  restartServer(target: string): Promise<boolean>
  startPolling(): void
  stopPolling(): void
}

export function emptyRuntimeState(): PaneRuntimeState {
  return {
    agentId: null,
    shellReady: false,
    currentCommand: '',
    serverRunning: false,
    serverCommand: null,
    serverPorts: [],
    mode: null
  }
}
