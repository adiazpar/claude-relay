import express from 'express'
import { createServer } from 'http'
import { createServer as createHttpsServer } from 'https'
import { readFileSync, existsSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import path from 'path'
import { fileURLToPath } from 'url'
import { tmuxBridge } from './tmux-bridge.js'
import { getAllCommands } from './commands.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Max inbound WebSocket message size (bytes)
const MAX_WS_MESSAGE_BYTES = 64 * 1024
// Max inbound message content length (characters)
const MAX_MESSAGE_CONTENT_CHARS = 16 * 1024

// SSL certificate paths - check both project root and dist parent
const certsInCurrentDir = path.join(__dirname, 'certs')
const certsInParentDir = path.join(__dirname, '..', 'certs')
const certsDir = existsSync(certsInCurrentDir) ? certsInCurrentDir : certsInParentDir
const certPath = path.join(certsDir, 'cert.pem')
const keyPath = path.join(certsDir, 'key.pem')
const sslAvailable = existsSync(certPath) && existsSync(keyPath)

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

// Only allow absolute, reasonably-short paths (no nulls). tmux will reject nonexistent dirs itself.
function validateCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string') return null
  if (cwd.length === 0 || cwd.length > 4096) return null
  if (cwd.includes('\0')) return null
  if (!path.isAbsolute(cwd)) return null
  return cwd
}

const app = express()

// Create HTTP server
const httpServer = createServer(app)

// Create HTTPS server if certificates are available
const httpsServer = sslAvailable
  ? createHttpsServer({
      key: readFileSync(keyPath),
      cert: readFileSync(certPath)
    }, app)
  : null

// WebSocket server - attach to HTTPS if available, otherwise HTTP
const wss = new WebSocketServer({
  server: httpsServer || httpServer,
  maxPayload: MAX_WS_MESSAGE_BYTES
})

const HOST = process.env.HOST || '0.0.0.0' // Listen on all interfaces for Tailscale

// Serve static files
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.json({ limit: '128kb' }))

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    tmuxSession: tmuxBridge.sessionExists(),
    claudeRunning: tmuxBridge.isClaudeRunning()
  })
})

// Serve SSL certificate for iOS installation
app.get('/cert', (req, res) => {
  if (sslAvailable) {
    res.setHeader('Content-Type', 'application/x-x509-ca-cert')
    res.setHeader('Content-Disposition', 'attachment; filename="claude-relay.cer"')
    res.sendFile(certPath)
  } else {
    res.status(404).send('No certificate available')
  }
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
  const panes = tmuxBridge.listPanes()
  res.json({ panes })
})

// Create a new window
app.post('/api/panes', (req, res) => {
  const cwd = validateCwd(req.body?.cwd) ?? undefined
  const newPane = tmuxBridge.createWindow(cwd)
  if (newPane) {
    res.json({ success: true, pane: newPane, panes: tmuxBridge.listPanes() })
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
    res.json({ success: true, panes: tmuxBridge.listPanes() })
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

// Send message via REST (fallback)
app.post('/api/send', (req, res) => {
  const message = req.body?.message
  if (typeof message !== 'string' || message.length === 0) {
    return res.status(400).json({ error: 'Message required' })
  }
  if (message.length > MAX_MESSAGE_CONTENT_CHARS) {
    return res.status(413).json({ error: 'Message too large' })
  }

  const success = tmuxBridge.sendMessage(message)
  res.json({ success })
})

// Track active pane per client
interface ClientState {
  activePane: string | null
  activePaneTarget: string | null
}
const clientStates = new WeakMap<WebSocket, ClientState>()

// WebSocket handling for real-time communication
wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected')

  // Prevent unhandled 'error' from crashing the process
  ws.on('error', (error) => {
    console.error('WebSocket error:', error)
  })

  // Initialize client state
  const panes = tmuxBridge.listPanes()
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
      const paneTarget = requestedTarget ?? clientState?.activePaneTarget ?? undefined

      if (msg.type === 'switchPane') {
        // Client is switching to a different pane
        const panes = tmuxBridge.listPanes()
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
            mode: tmuxBridge.detectMode(pane.target)
          }))
        }
      } else if (msg.type === 'send') {
        if (typeof msg.content !== 'string' || msg.content.length === 0) return
        if (msg.content.length > MAX_MESSAGE_CONTENT_CHARS) {
          ws.send(JSON.stringify({ type: 'sent', success: false, error: 'Message too large' }))
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
        const success = tmuxBridge.sendKey(msg.key, paneTarget)
        ws.send(JSON.stringify({
          type: 'keySent',
          success,
          key: msg.key,
          paneId: clientState?.activePane
        }))
      } else if (msg.type === 'refresh') {
        // Refresh pane list
        const panes = tmuxBridge.listPanes()
        ws.send(JSON.stringify({
          type: 'paneList',
          panes
        }))
        // Send output for active pane
        ws.send(JSON.stringify({
          type: 'output',
          paneId: clientState?.activePane,
          lines: toLines(tmuxBridge.getFullOutput(paneTarget)),
          mode: tmuxBridge.detectMode(paneTarget)
        }))
      } else if (msg.type === 'resize') {
        const cols = Number.isInteger(msg.cols) ? msg.cols : parseInt(String(msg.cols), 10)
        if (!Number.isInteger(cols) || cols <= 0 || cols > 1000) return
        const success = tmuxBridge.resizePane(cols, undefined, paneTarget)
        if (success) {
          // After resize, send updated output
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'output',
              paneId: clientState?.activePane,
              lines: toLines(tmuxBridge.getFullOutput(paneTarget)),
              mode: tmuxBridge.detectMode(paneTarget)
            }))
          }, 100)
        }
      } else if (msg.type === 'typing') {
        tmuxBridge.setTypingState(msg.isTyping === true)
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
    mode: tmuxBridge.detectMode(paneTarget)
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

// Start polling for output changes
tmuxBridge.startPolling()

const PORT = 3001

// Start HTTPS server if available, otherwise HTTP
if (httpsServer) {
  httpsServer.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                    Claude Relay Server                     ║
╠════════════════════════════════════════════════════════════╣
║  URL: https://100.113.9.34:${PORT}                           ║
╠════════════════════════════════════════════════════════════╣
║  Tmux Session: ${tmuxBridge.sessionExists() ? 'Connected' : 'NOT FOUND'}                              ║
║  Claude Code:  ${tmuxBridge.isClaudeRunning() ? 'Running' : 'Not detected'}                               ║
║  Voice Input:  Enabled                                     ║
╚════════════════════════════════════════════════════════════╝
`)
  })
} else {
  httpServer.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                    Claude Relay Server                     ║
╠════════════════════════════════════════════════════════════╣
║  URL: http://100.113.9.34:${PORT}                            ║
╠════════════════════════════════════════════════════════════╣
║  Tmux Session: ${tmuxBridge.sessionExists() ? 'Connected' : 'NOT FOUND'}                              ║
║  Claude Code:  ${tmuxBridge.isClaudeRunning() ? 'Running' : 'Not detected'}                               ║
║  Voice Input:  Disabled (no SSL certs)                     ║
╚════════════════════════════════════════════════════════════╝
`)
  })
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...')
  tmuxBridge.stopPolling()
  if (httpsServer) {
    httpsServer.close()
  } else {
    httpServer.close()
  }
  process.exit(0)
})
