import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import path from 'path'
import { fileURLToPath } from 'url'
import { tmuxBridge } from './tmux-bridge.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Split terminal output into raw ANSI lines
// Client handles ANSI-to-HTML conversion for better performance
function toLines(text: string): string[] {
  if (!text) return []
  return text.split('\n')
}

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server })

const PORT = process.env.PORT || 3001
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

// Get current pane content
app.get('/api/output', (req, res) => {
  const output = tmuxBridge.getFullOutput()
  res.json({ output })
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

// Start server
server.listen(Number(PORT), HOST, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    Claude Relay Server                     ║
╠════════════════════════════════════════════════════════════╣
║  Local:     http://localhost:${PORT}                         ║
║  Tailscale: http://100.113.9.34:${PORT}                      ║
╠════════════════════════════════════════════════════════════╣
║  Tmux Session: ${tmuxBridge.sessionExists() ? 'Connected' : 'NOT FOUND'}                              ║
║  Claude Code:  ${tmuxBridge.isClaudeRunning() ? 'Running' : 'Not detected'}                               ║
╚════════════════════════════════════════════════════════════╝

Open the Tailscale URL on your phone to chat with Claude Code!
`)
})

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...')
  tmuxBridge.stopPolling()
  server.close()
  process.exit(0)
})
