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
const wss = new WebSocketServer({ server: httpsServer || httpServer })

const HOST = process.env.HOST || '0.0.0.0' // Listen on all interfaces for Tailscale

// Serve static files
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.json())

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
  const target = req.query.target as string | undefined
  const output = tmuxBridge.getFullOutput(target)
  res.json({ output })
})

// Get all available panes
app.get('/api/panes', (req, res) => {
  const panes = tmuxBridge.listPanes()
  res.json({ panes })
})

// Get available slash commands
app.get('/api/commands', async (req, res) => {
  try {
    const cwd = req.query.cwd as string | undefined
    const commands = await getAllCommands(cwd)
    res.json({ commands })
  } catch (error) {
    console.error('Error fetching commands:', error)
    res.status(500).json({ error: 'Failed to fetch commands' })
  }
})

// Send message via REST (fallback)
app.post('/api/send', (req, res) => {
  const { message } = req.body
  if (!message) {
    return res.status(400).json({ error: 'Message required' })
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
    try {
      const msg = JSON.parse(data.toString())
      const clientState = clientStates.get(ws)
      const paneTarget = msg.paneTarget || clientState?.activePaneTarget

      if (msg.type === 'switchPane') {
        // Client is switching to a different pane
        const panes = tmuxBridge.listPanes()
        const pane = panes.find(p => p.id === msg.paneId)
        if (pane && clientState) {
          clientState.activePane = pane.id
          clientState.activePaneTarget = pane.target
          // Send output for the new pane
          ws.send(JSON.stringify({
            type: 'output',
            paneId: pane.id,
            lines: toLines(tmuxBridge.getFullOutput(pane.target)),
            mode: tmuxBridge.detectMode(pane.target)
          }))
        }
      } else if (msg.type === 'send') {
        const success = tmuxBridge.sendMessage(msg.content, paneTarget)
        ws.send(JSON.stringify({
          type: 'sent',
          success,
          content: msg.content,
          paneId: clientState?.activePane
        }))
      } else if (msg.type === 'key') {
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
        const cols = parseInt(msg.cols, 10)
        if (cols && cols > 0) {
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
        }
      } else if (msg.type === 'typing') {
        // Client is typing - slow down polling to reduce main thread work
        tmuxBridge.setTypingState(msg.isTyping === true)
      }
    } catch (error) {
      console.error('Invalid message:', error)
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
        client.send(message)
      }
    }
  })
})

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
