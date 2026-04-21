import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import crypto from 'crypto'
import { tmuxBridge } from './tmux-bridge.js'
import { getAllCommands } from './commands.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Debug logging (gated on DEBUG=1 env var). When enabled, tees
// console.log/error/warn into a rotating file at logs/debug.log
// inside the repo. Rotation: on each write, if the current file
// exceeds 1 MB, rename it to debug.log.1 (overwriting any previous
// .1) and open a fresh file. Errors never crash the relay — we
// fall back to unwrapped console output.
if (process.env.DEBUG === '1') {
  try {
    const logDir = path.join(__dirname, '..', 'logs')
    const logPath = path.join(logDir, 'debug.log')
    const rotatedPath = path.join(logDir, 'debug.log.1')
    const MAX_LOG_BYTES = 1 * 1024 * 1024

    fs.mkdirSync(logDir, { recursive: true })

    let fd: number | null = null

    const openFd = () => {
      try {
        fd = fs.openSync(logPath, 'a')
      } catch {
        fd = null
      }
    }

    const maybeRotate = () => {
      if (fd === null) return
      try {
        const stat = fs.fstatSync(fd)
        if (stat.size < MAX_LOG_BYTES) return
        fs.closeSync(fd)
        fs.renameSync(logPath, rotatedPath)
        openFd()
      } catch {
        // Rotation failed — best effort. Keep the current fd.
      }
    }

    openFd()

    const writeLine = (prefix: string, args: unknown[]) => {
      if (fd === null) return
      try {
        const stamp = new Date().toISOString()
        const line = `${stamp} ${prefix} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`
        fs.writeSync(fd, line)
        maybeRotate()
      } catch {
        // Write failed — no-op.
      }
    }

    const origLog = console.log.bind(console)
    const origErr = console.error.bind(console)
    const origWarn = console.warn.bind(console)

    console.log = (...args: unknown[]) => { origLog(...args); writeLine('LOG', args) }
    console.error = (...args: unknown[]) => { origErr(...args); writeLine('ERR', args) }
    console.warn = (...args: unknown[]) => { origWarn(...args); writeLine('WRN', args) }

    origLog(`Debug logging enabled → ${logPath}`)
  } catch (err) {
    // Never crash the relay due to logging setup failure.
    console.error('Debug logging setup failed (continuing without file logs):', err)
  }
}

// Max inbound WebSocket message size (bytes)
const MAX_WS_MESSAGE_BYTES = 64 * 1024
// Max inbound message content length (characters)
const MAX_MESSAGE_CONTENT_CHARS = 16 * 1024

// Image upload constants. Files written here live for ~30 seconds — long
// enough for Claude Code's TUI to read them and base64-encode into the API
// request, short enough that steady state is ~empty. The startup sweep
// further below catches anything the timer missed (daemon crash, etc).
const UPLOAD_DIR = path.join(__dirname, '..', 'logs', 'uploads')
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const UPLOAD_CLEANUP_DELAY_MS = 30_000
const ALLOWED_MIME = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])

// Split terminal output into raw ANSI lines
// Client handles ANSI-to-HTML conversion for better performance
function toLines(text: string): string[] {
  if (!text) return []
  return text.split('\n')
}

// Accept only values that match a currently-known pane target. Returns null if invalid.
function validatePaneTarget(target: unknown): string | null {
  if (typeof target !== 'string' || target.length === 0 || target.length > 128) return null
  const panes = tmuxBridge.listPanes()
  return panes.some(p => p.target === target) ? target : null
}

function validateDimension(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < min || n > max) return undefined
  return n
}

// Only allow absolute, reasonably-short paths (no nulls). tmux will reject nonexistent dirs itself.
function validateCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string') return null
  if (cwd.length === 0 || cwd.length > 4096) return null
  if (cwd.includes('\0')) return null
  if (!path.isAbsolute(cwd)) return null
  return cwd
}

type SaveResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

// Validate an uploaded image payload and write it to UPLOAD_DIR with a
// server-generated UUID filename. Client's `filename` is intentionally
// discarded — nothing client-supplied touches the filesystem, so there's
// no path-traversal surface.
function saveUploadedImage(payload: unknown): SaveResult {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: 'bad payload' }
  }
  const { mime, base64 } = payload as Record<string, unknown>
  if (typeof mime !== 'string' || !ALLOWED_MIME.has(mime)) {
    return { ok: false, error: 'unsupported type' }
  }
  if (typeof base64 !== 'string') {
    return { ok: false, error: 'bad payload' }
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0) {
    return { ok: false, error: 'empty image' }
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'image too large' }
  }
  const ext = ALLOWED_MIME.get(mime)!
  const id = crypto.randomUUID()
  const dest = path.join(UPLOAD_DIR, `${id}.${ext}`)
  try {
    fs.writeFileSync(dest, bytes)
  } catch (err) {
    console.error('Failed to write upload:', err)
    return { ok: false, error: 'write failed' }
  }
  return { ok: true, path: dest }
}

// Schedule a fire-and-forget delete of an uploaded file. ENOENT is fine —
// the startup sweep may have beaten us to it after a daemon restart.
function scheduleUnlink(filePath: string, delayMs: number): void {
  setTimeout(() => {
    fs.unlink(filePath, err => {
      if (err && err.code !== 'ENOENT') {
        console.error('Cleanup failed:', filePath, err)
      }
    })
  }, delayMs)
}

const app = express()

const httpServer = createServer(app)

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: MAX_WS_MESSAGE_BYTES
})

const HOST = process.env.HOST || '0.0.0.0' // Listen on all interfaces for Tailscale

function serializePanes() {
  return tmuxBridge.listPanes().map(pane => ({
    ...pane,
    ...tmuxBridge.getPaneRuntimeState(pane.target)
  }))
}

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')))

// Ensure uploads dir exists and is empty at startup. Catches any files
// left over from a previous run (daemon crashed mid-upload, unlink timer
// didn't fire). Synchronous on purpose — guarantees an empty dir before
// we accept any requests.
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, f)) } catch {}
  }
} catch (err) {
  console.error('Failed to prepare uploads dir:', err)
}

app.use(express.json({ limit: '128kb' }))

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    tmuxSession: tmuxBridge.sessionExists(),
    claudeRunning: tmuxBridge.isClaudeRunning()
  })
})

// Get current pane content
app.get('/api/output', (req, res) => {
  const rawTarget = req.query.target as string | undefined
  const target = rawTarget ? validatePaneTarget(rawTarget) ?? undefined : undefined
  const output = tmuxBridge.getFullOutput(target)
  res.json({ output })
})

// Get all available panes
app.get('/api/panes', (req, res) => {
  const panes = serializePanes()
  res.json({ panes })
})

// Create a new window
app.post('/api/panes', (req, res) => {
  const cwd = validateCwd(req.body?.cwd) ?? undefined
  const cols = validateDimension(req.body?.cols, 40, 300)
  const rows = validateDimension(req.body?.rows, 10, 100)
  const newPane = tmuxBridge.createWindow(cwd, cols, rows)
  if (newPane) {
    res.json({
      success: true,
      pane: { ...newPane, ...tmuxBridge.getPaneRuntimeState(newPane.target) },
      panes: serializePanes()
    })
  } else {
    res.status(500).json({ success: false, error: 'Failed to create window' })
  }
})

// Close a window
app.post('/api/panes/close', (req, res) => {
  const target = validatePaneTarget(req.body?.target)
  if (!target) {
    return res.status(400).json({ success: false, error: 'Valid target required' })
  }
  const success = tmuxBridge.closeWindow(target)
  if (success) {
    res.json({ success: true, panes: serializePanes() })
  } else {
    res.status(500).json({ success: false, error: 'Failed to close window' })
  }
})

// Get available slash commands
app.get('/api/commands', async (req, res) => {
  try {
    const rawCwd = req.query.cwd as string | undefined
    const cwd = rawCwd ? validateCwd(rawCwd) ?? undefined : undefined
    const commands = await getAllCommands(cwd)
    res.json({ commands })
  } catch (error) {
    console.error('Error fetching commands:', error)
    res.status(500).json({ error: 'Failed to fetch commands' })
  }
})

// Drop tmux scrollback for a pane (used after launching Claude so the pre-TUI
// command echoes don't sit above Claude's UI in the canvas).
app.post('/api/clear-history', (req, res) => {
  const target = validatePaneTarget(req.body?.target)
  if (!target) {
    return res.status(400).json({ success: false, error: 'Valid target required' })
  }
  const success = tmuxBridge.clearHistory(target)
  res.json({ success })
})

// Send message via REST (fallback)
app.post('/api/send', (req, res) => {
  const message = req.body?.message
  if (typeof message !== 'string' || message.length === 0) {
    return res.status(400).json({ error: 'Message required' })
  }
  if (message.length > MAX_MESSAGE_CONTENT_CHARS) {
    return res.status(413).json({ error: 'Message too large' })
  }

  const target = validatePaneTarget(req.body?.target)
  if (!target) {
    return res.status(400).json({ error: 'Valid target required' })
  }
  const success = tmuxBridge.sendMessage(message, target)
  res.json({ success })
})

// Send a whitelisted key via REST (fallback)
app.post('/api/key', (req, res) => {
  const key = req.body?.key
  if (typeof key !== 'string' || key.length === 0) {
    return res.status(400).json({ error: 'Key required' })
  }

  const target = validatePaneTarget(req.body?.target)
  if (!target) {
    return res.status(400).json({ error: 'Valid target required' })
  }
  const success = tmuxBridge.sendKey(key, target)
  res.json({ success })
})

// Track active pane per client
interface ClientState {
  activePane: string | null
  activePaneTarget: string | null
}
const clientStates = new WeakMap<WebSocket, ClientState>()

function resolveClientPaneTarget(clientState?: ClientState): string | null {
  if (!clientState) return null

  const validatedTarget = clientState.activePaneTarget
    ? validatePaneTarget(clientState.activePaneTarget)
    : null
  if (validatedTarget) {
    clientState.activePaneTarget = validatedTarget
    return validatedTarget
  }

  if (!clientState.activePane) return null
  const pane = tmuxBridge.listPanes().find(p => p.id === clientState.activePane)
  if (!pane) return null

  clientState.activePaneTarget = pane.target
  return pane.target
}

// WebSocket handling for real-time communication
wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected')

  // Prevent unhandled 'error' from crashing the process
  ws.on('error', (error) => {
    console.error('WebSocket error:', error)
  })

  // Initialize client state
  const panes = serializePanes()
  const initialPane = panes[0] || null
  clientStates.set(ws, {
    activePane: initialPane?.id || null,
    activePaneTarget: initialPane?.target || null
  })

  // Send pane list
  ws.send(JSON.stringify({
    type: 'paneList',
    panes
  }))

  // Send initial status
  ws.send(JSON.stringify({
    type: 'status',
    tmuxSession: tmuxBridge.sessionExists(),
    claudeRunning: tmuxBridge.isClaudeRunning(initialPane?.target)
  }))

  // Send current output for first pane
  if (initialPane) {
    ws.send(JSON.stringify({
      type: 'output',
      paneId: initialPane.id,
      lines: toLines(tmuxBridge.getFullOutput(initialPane.target)),
      mode: tmuxBridge.detectMode(initialPane.target)
    }))
  }

  // Handle incoming messages
  ws.on('message', (data: Buffer) => {
    let msg: any
    try {
      msg = JSON.parse(data.toString('utf-8'))
    } catch {
      return // Ignore non-JSON frames
    }
    if (!msg || typeof msg !== 'object') return

    try {
      const clientState = clientStates.get(ws)
      // Resolve the pane target: either client-provided (validated) or the active one
      const requestedTarget = typeof msg.paneTarget === 'string' ? validatePaneTarget(msg.paneTarget) : null
      const paneTarget = requestedTarget ?? resolveClientPaneTarget(clientState)

      if (msg.type === 'switchPane') {
        // Client is switching to a different pane
        const panes = serializePanes()
        const pane = panes.find(p => p.id === msg.paneId)
        if (pane && clientState) {
          clientState.activePane = pane.id
          clientState.activePaneTarget = pane.target
          // Select the window in tmux (makes it visible in terminal)
          tmuxBridge.selectWindow(pane.target)
          // Send output for the new pane
          ws.send(JSON.stringify({
            type: 'output',
            paneId: pane.id,
            lines: toLines(tmuxBridge.getFullOutput(pane.target)),
            mode: tmuxBridge.detectMode(pane.target),
            ...tmuxBridge.getPaneRuntimeState(pane.target)
          }))
        }
      } else if (msg.type === 'send') {
        if (typeof msg.content !== 'string' || msg.content.length === 0) return
        if (msg.content.length > MAX_MESSAGE_CONTENT_CHARS) {
          ws.send(JSON.stringify({ type: 'sent', success: false, error: 'Message too large' }))
          return
        }
        if (!paneTarget) {
          ws.send(JSON.stringify({ type: 'sent', success: false, error: 'No active pane target' }))
          return
        }
        const success = tmuxBridge.sendMessage(msg.content, paneTarget)
        ws.send(JSON.stringify({
          type: 'sent',
          success,
          content: msg.content,
          paneId: clientState?.activePane
        }))
      } else if (msg.type === 'key') {
        // sendKey whitelists the key name internally and returns false for anything else
        if (!paneTarget) {
          ws.send(JSON.stringify({ type: 'keySent', success: false, error: 'No active pane target', key: msg.key }))
          return
        }
        const success = tmuxBridge.sendKey(msg.key, paneTarget)
        ws.send(JSON.stringify({
          type: 'keySent',
          success,
          key: msg.key,
          paneId: clientState?.activePane
        }))
      } else if (msg.type === 'refresh') {
        // Refresh pane list
        const panes = serializePanes()
        ws.send(JSON.stringify({
          type: 'paneList',
          panes
        }))
        if (!paneTarget) return
        // Send output for active pane
        ws.send(JSON.stringify({
          type: 'output',
          paneId: clientState?.activePane,
          lines: toLines(tmuxBridge.getFullOutput(paneTarget)),
          mode: tmuxBridge.detectMode(paneTarget),
          ...tmuxBridge.getPaneRuntimeState(paneTarget)
        }))
      } else if (msg.type === 'resize') {
        const cols = Number.isInteger(msg.cols) ? msg.cols : parseInt(String(msg.cols), 10)
        if (!Number.isInteger(cols) || cols <= 0 || cols > 1000) return
        if (!paneTarget) return
        const success = tmuxBridge.resizePane(cols, undefined, paneTarget)
        if (success) {
          // After resize, send updated output
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'output',
              paneId: clientState?.activePane,
              lines: toLines(tmuxBridge.getFullOutput(paneTarget)),
              mode: tmuxBridge.detectMode(paneTarget),
              ...tmuxBridge.getPaneRuntimeState(paneTarget)
            }))
          }, 100)
        }
      } else if (msg.type === 'typing') {
        tmuxBridge.setTypingState(msg.isTyping === true)
      } else if (msg.type === 'serverStop') {
        if (!paneTarget) {
          ws.send(JSON.stringify({ type: 'serverAction', action: 'stop', success: false, error: 'No active pane target' }))
          return
        }
        const success = tmuxBridge.stopServer(paneTarget)
        ws.send(JSON.stringify({
          type: 'serverAction',
          action: 'stop',
          success,
          paneId: clientState?.activePane
        }))
      } else if (msg.type === 'serverRestart') {
        if (!paneTarget) {
          ws.send(JSON.stringify({ type: 'serverAction', action: 'restart', success: false, error: 'No active pane target' }))
          return
        }
        const success = tmuxBridge.restartServer(paneTarget)
        ws.send(JSON.stringify({
          type: 'serverAction',
          action: 'restart',
          success,
          paneId: clientState?.activePane
        }))
      }
    } catch (error) {
      console.error('Error handling WS message:', error)
    }
  })

  ws.on('close', () => {
    console.log('Client disconnected')
    clientStates.delete(ws)
  })
})

// Forward tmux output changes to clients watching that pane
tmuxBridge.on('output', (rawContent: string, paneId: string, paneTarget: string) => {
  const message = JSON.stringify({
    type: 'output',
    paneId,
    lines: toLines(rawContent),
    mode: tmuxBridge.detectMode(paneTarget),
    ...tmuxBridge.getPaneRuntimeState(paneTarget)
  })

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      const clientState = clientStates.get(client)
      // Send to clients watching this pane
      if (clientState?.activePane === paneId) {
        try {
          client.send(message)
        } catch (err) {
          console.error('Failed to send to client:', err)
        }
      }
    }
  })
})

// Heartbeat: send a tiny ping to every open client so the browser can detect
// dead sockets after an iOS tab backgrounds and kills the underlying TCP.
const HEARTBEAT_INTERVAL_MS = 15000
setInterval(() => {
  const payload = JSON.stringify({ type: 'ping', t: Date.now() })
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload) } catch {}
    }
  })
}, HEARTBEAT_INTERVAL_MS)

// Broadcast per-pane runtime state to all clients so every tab's button can
// reflect current claudeRunning/shellReady regardless of which pane is active.
function broadcastRuntimeStates() {
  if (wss.clients.size === 0) return
  const states = tmuxBridge.getAllPaneRuntimeStates()
  const payload = JSON.stringify({ type: 'paneRuntimeList', states })
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload) } catch {}
    }
  })
}

// An async TLS probe that upgrades a newly-seen port from the default http
// guess to https fires this event. Debounce so a cluster of near-simultaneous
// probes only triggers one extra broadcast, and so we don't race the next
// scheduled 2s tick.
let earlyBroadcastTimer: NodeJS.Timeout | null = null
tmuxBridge.on('protocolResolved', () => {
  if (earlyBroadcastTimer) return
  earlyBroadcastTimer = setTimeout(() => {
    earlyBroadcastTimer = null
    broadcastRuntimeStates()
  }, 80)
})

// tmux session was auto-recreated (user killed it, tmux crashed). The fresh
// session has new pane IDs, so clients need a fresh paneList — otherwise
// they'd sit on stale state until they refreshed manually. Clients already
// handle "my activePane disappeared" inside handlePaneList by switching to
// the first available pane.
tmuxBridge.on('sessionRecreated', () => {
  if (wss.clients.size === 0) return
  const panes = serializePanes()
  const payload = JSON.stringify({ type: 'paneList', panes })
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload) } catch {}
    }
  })
  broadcastRuntimeStates()
})

const PANE_STATE_BROADCAST_MS = 2000
setInterval(() => {
  if (wss.clients.size === 0) return
  const states = tmuxBridge.getAllPaneRuntimeStates()
  const payload = JSON.stringify({ type: 'paneRuntimeList', states })
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload) } catch {}
    }
  })
}, PANE_STATE_BROADCAST_MS)

// Start polling for output changes
tmuxBridge.startPolling()

const PORT_RAW = process.env.PORT ?? '3001'
const PORT = Number(PORT_RAW)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT: ${JSON.stringify(PORT_RAW)}. Expected an integer 1-65535.`)
  process.exit(1)
}

httpServer.listen(PORT, HOST, () => {
  console.log(`
  Claude Relay Server
  ------------------------------------------------------------
  Listening on http://${HOST}:${PORT}
  Tmux Session: ${tmuxBridge.sessionExists() ? 'Connected' : 'NOT FOUND'}
  Claude Code:  ${tmuxBridge.isClaudeRunning() ? 'Running' : 'Not detected'}
`)
})

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...')
  tmuxBridge.stopPolling()
  httpServer.close()
  process.exit(0)
})
