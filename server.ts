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
  const output = tmuxBridge.getFullOutput()
  res.json({ output })
})

// Get available slash commands
app.get('/api/commands', async (req, res) => {
  try {
    const commands = await getAllCommands()
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

// WebSocket handling for real-time communication
wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected')

  // Send initial status
  ws.send(JSON.stringify({
    type: 'status',
    tmuxSession: tmuxBridge.sessionExists(),
    claudeRunning: tmuxBridge.isClaudeRunning()
  }))

  // Send current output as lines (for virtual scrolling) and mode
  ws.send(JSON.stringify({
    type: 'output',
    lines: toLines(tmuxBridge.getFullOutput()),
    mode: tmuxBridge.detectMode()
  }))

  // Handle incoming messages
  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString())

      if (msg.type === 'send') {
        const success = tmuxBridge.sendMessage(msg.content)
        ws.send(JSON.stringify({
          type: 'sent',
          success,
          content: msg.content
        }))
      } else if (msg.type === 'key') {
        const success = tmuxBridge.sendKey(msg.key)
        ws.send(JSON.stringify({
          type: 'keySent',
          success,
          key: msg.key
        }))
      } else if (msg.type === 'refresh') {
        ws.send(JSON.stringify({
          type: 'output',
          lines: toLines(tmuxBridge.getFullOutput()),
          mode: tmuxBridge.detectMode()
        }))
      } else if (msg.type === 'resize') {
        const cols = parseInt(msg.cols, 10)
        if (cols && cols > 0) {
          const success = tmuxBridge.resizePane(cols)
          if (success) {
            // After resize, send updated output
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'output',
                lines: toLines(tmuxBridge.getFullOutput()),
                mode: tmuxBridge.detectMode()
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
  })
})

// Forward tmux output changes to all connected clients
tmuxBridge.on('output', (rawContent: string) => {
  const message = JSON.stringify({
    type: 'output',  // Lines for virtual scrolling
    lines: toLines(rawContent),
    mode: tmuxBridge.detectMode()
  })

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  })
})

// Start polling for output changes
tmuxBridge.startPolling()

const HTTP_PORT = 3001
const HTTPS_PORT = 3443

// Always start HTTP server (for cert download and fallback)
httpServer.listen(HTTP_PORT, HOST, () => {
  console.log(`HTTP server on port ${HTTP_PORT}`)
})

// Start HTTPS server if available
if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                    Claude Relay Server                     ║
╠════════════════════════════════════════════════════════════╣
║  HTTP:      http://100.113.9.34:${HTTP_PORT}  (no voice)          ║
║  HTTPS:     https://100.113.9.34:${HTTPS_PORT} (voice enabled)    ║
╠════════════════════════════════════════════════════════════╣
║  Tmux Session: ${tmuxBridge.sessionExists() ? 'Connected' : 'NOT FOUND'}                              ║
║  Claude Code:  ${tmuxBridge.isClaudeRunning() ? 'Running' : 'Not detected'}                               ║
╠════════════════════════════════════════════════════════════╣
║  To enable voice on iOS:                                   ║
║  1. Go to http://100.113.9.34:${HTTP_PORT}/cert                   ║
║  2. Install the certificate in Settings > General >        ║
║     VPN & Device Management                                ║
║  3. Trust it in Settings > General > About >               ║
║     Certificate Trust Settings                             ║
║  4. Then visit https://100.113.9.34:${HTTPS_PORT}                 ║
╚════════════════════════════════════════════════════════════╝
`)
  })
} else {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    Claude Relay Server                     ║
╠════════════════════════════════════════════════════════════╣
║  URL: http://100.113.9.34:${HTTP_PORT}                            ║
╠════════════════════════════════════════════════════════════╣
║  WARNING: No SSL certs. Voice input unavailable.           ║
╚════════════════════════════════════════════════════════════╝
`)
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...')
  tmuxBridge.stopPolling()
  httpServer.close()
  if (httpsServer) httpsServer.close()
  process.exit(0)
})
