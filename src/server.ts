import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import crypto from 'crypto'
import { bridge } from './bridge-instance.js'
import { getAgents, getAgentsForClient } from './agents.js'
import { getShellsForClient } from './shells.js'
import { PORT } from './config.js'

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

// Image upload constants. Uploaded files live in UPLOAD_DIR as
// <uuid>.<ext>; that filename doubles as the token the client sends back
// in a later /api/send request.
//
// Two unlink timers can be attached per file:
//   - At upload: 10 min "orphan TTL" (user picked but never sent).
//   - At send:   30 s "sent TTL"    (file used, get rid of it quickly).
// Either firing first wins. The second harmlessly hits ENOENT.
// Startup sweep is the final safety net.
const UPLOAD_DIR = path.join(__dirname, '..', 'logs', 'uploads')
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const UPLOAD_CLEANUP_DELAY_MS = 30_000
const UPLOAD_ORPHAN_TTL_MS = 10 * 60_000
const MAX_ATTACHMENTS_PER_SEND = 10
const ALLOWED_MIME = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/i

// Split terminal output into raw ANSI lines
// Client handles ANSI-to-HTML conversion for better performance
function toLines(text: string): string[] {
  if (!text) return []
  return text.split('\n')
}

// Accept only values that match a currently-known pane target. Returns null if invalid.
async function validatePaneTarget(target: unknown): Promise<string | null> {
  if (typeof target !== 'string' || target.length === 0 || target.length > 128) return null
  const panes = await bridge.listPanes()
  return panes.some(p => p.target === target) ? target : null
}

// Build an output frame whose paneId is derived from the SAME target whose
// bytes are captured, so the tag and the content can never disagree.
//
// WS message handlers are async and interleave at their awaits, all sharing
// one mutable clientState. A handler that tagged the frame with a late read of
// clientState.activePane while capturing a separately-resolved paneTarget
// could emit one pane's content under another pane's id when a concurrent
// switchPane mutated clientState in between -- this was the "open a new tab and
// it shows the previous tab's terminal" bug (resize fires right after
// switchPane, so the two handlers reliably race). Deriving paneId from
// paneTarget removes the shared-state read entirely. Returns null if the pane
// closed between validation and capture.
// buildOutputFrame removed: rendering moved to xterm.js in the browser, fed by
// live `term-output` + `term-replay` (see subscribeOutput fan-out below).
// Runtime state (agent/server/mode) rides the 2s paneRuntimeList broadcast.

function validateDimension(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < min || n > max) return undefined
  return n
}

// Only allow absolute, reasonably-short paths (no nulls). The backend
// (tmux or the pane-host) rejects nonexistent dirs itself. win32's
// path.isAbsolute accepts both `C:\...` and `/` forms.
function validateCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string') return null
  if (cwd.length === 0 || cwd.length > 4096) return null
  if (cwd.includes('\0')) return null
  if (!path.isAbsolute(cwd)) return null
  return cwd
}

// Shell ids are registry-defined slugs ("pwsh", "git-bash", "wsl:Ubuntu").
// The bridge validates against the actual registry; this just rejects junk.
function validateShellId(shellId: unknown): string | undefined {
  if (typeof shellId !== 'string') return undefined
  if (!/^[a-z0-9][a-z0-9:._ -]{0,63}$/i.test(shellId)) return undefined
  return shellId
}

type SaveResult =
  | { ok: true; path: string; token: string }
  | { ok: false; status: number; error: string }

// Write a validated image Buffer to UPLOAD_DIR. The filename
// (<uuid>.<ext>) doubles as the token returned to the client — the
// client sends that back in /api/send to reference the stored file.
// Server generates the name; nothing client-supplied touches the
// filesystem, so there's no path-traversal surface.
function saveUploadedBytes(bytes: Buffer, mime: string): SaveResult {
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, status: 400, error: 'unsupported type' }
  }
  if (bytes.length === 0) {
    return { ok: false, status: 400, error: 'empty image' }
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, error: 'image too large' }
  }
  const ext = ALLOWED_MIME.get(mime)!
  const id = crypto.randomUUID()
  const token = `${id}.${ext}`
  const dest = path.join(UPLOAD_DIR, token)
  try {
    fs.writeFileSync(dest, bytes)
  } catch (err) {
    console.error('Failed to write upload:', err)
    return { ok: false, status: 500, error: 'write failed' }
  }
  return { ok: true, path: dest, token }
}

// Validate an array of tokens from the client and resolve each to a
// filesystem path, confirming the file still exists. Any invalid or
// missing token fails the whole batch.
function resolveTokens(tokens: unknown):
  | { ok: true; paths: string[] }
  | { ok: false; error: string } {
  if (!Array.isArray(tokens)) return { ok: false, error: 'tokens must be array' }
  if (tokens.length === 0) return { ok: true, paths: [] }
  if (tokens.length > MAX_ATTACHMENTS_PER_SEND) {
    return { ok: false, error: 'too many attachments' }
  }
  const paths: string[] = []
  for (const t of tokens) {
    if (typeof t !== 'string' || !TOKEN_PATTERN.test(t)) {
      return { ok: false, error: 'invalid token' }
    }
    const p = path.join(UPLOAD_DIR, t)
    if (!fs.existsSync(p)) {
      return { ok: false, error: 'token expired or invalid' }
    }
    paths.push(p)
  }
  return { ok: true, paths }
}

// Schedule a fire-and-forget delete of an uploaded file. ENOENT is fine —
// the startup sweep or a competing cleanup timer may have beaten us.
function scheduleUnlink(filePath: string, delayMs: number): void {
  setTimeout(() => {
    fs.unlink(filePath, err => {
      if (err && err.code !== 'ENOENT') {
        console.error('Cleanup failed:', filePath, err)
      }
    })
  }, delayMs)
}

// Multi-device support: the phone UI may be served from one relay's origin
// while talking to this relay's API (the in-app device switcher). That
// requires CORS — but a blanket Access-Control-Allow-Origin: * would let any
// public website the user's browser visits read terminal output and type
// into tmux. Instead we reflect only origins that cannot exist on the public
// internet: MagicDNS (*.ts.net), mDNS (*.local), localhost, single-label
// intranet names, and private/CGNAT IP literals. An attacker can't serve a
// page from any of those origins to this user's browser, so reflection is
// safe by construction with zero configuration. Don't loosen this to '*'.
function isPrivateOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true
  if (host.endsWith('.ts.net') || host.endsWith('.local')) return true
  // IPv6 ULA (Tailscale's fd7a:... range) and link-local literals.
  if (host.startsWith('[fd') || host.startsWith('[fe80')) return true
  // Single-label hostnames (MagicDNS short names, plain LAN hostnames).
  // Public DNS cannot resolve dotless names, so these are intranet-only.
  if (!host.includes('.') && !host.includes(':')) return true
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 10 || a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true // Tailscale CGNAT range
  }
  return false
}

const app = express()

const httpServer = createServer(app)

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: MAX_WS_MESSAGE_BYTES,
  // Browsers always send Origin on the WS handshake. Without this check any
  // public website could open a socket to the relay (WS is exempt from
  // CORS) — cross-site WebSocket hijacking. Non-browser clients (curl,
  // scripts) send no Origin and pass.
  verifyClient: (info: { origin?: string }) =>
    !info.origin || isPrivateOrigin(info.origin)
})

const HOST = process.env.HOST || '0.0.0.0' // Listen on all interfaces for Tailscale

async function serializePanes() {
  const panes = await bridge.listPanes()
  return Promise.all(panes.map(async pane => ({
    ...pane,
    ...await bridge.getPaneRuntimeState(pane.target)
  })))
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

// CORS for the device switcher (see isPrivateOrigin above). Applies to all
// /api routes including the raw-body /api/upload, whose image/* content type
// is non-simple and therefore preflights.
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && isPrivateOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Max-Age', '600')
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }
  next()
})

app.use(express.json({ limit: '128kb' }))

// Health check endpoint. The key is still named tmuxSession for client
// back-compat; on Windows it reports pane-host health.
app.get('/api/health', async (req, res) => {
  res.json({
    status: 'ok',
    tmuxSession: await bridge.sessionExists()
  })
})

// Registered agents the client can offer in the launcher. Availability is
// probed through the user's login shell (cached) — see agents.ts.
app.get('/api/agents', async (req, res) => {
  try {
    const agents = await getAgentsForClient()
    res.json({ agents })
  } catch (error) {
    console.error('Error listing agents:', error)
    res.status(500).json({ error: 'Failed to list agents' })
  }
})

// Shells available for new panes. On macOS/Linux this is a single default
// entry (tmux windows always run the user's shell); on Windows it lists
// PowerShell/cmd/Git Bash/WSL distros so the client can offer a picker.
app.get('/api/shells', async (req, res) => {
  try {
    const shells = await getShellsForClient()
    res.json({ shells })
  } catch (error) {
    console.error('Error listing shells:', error)
    res.status(500).json({ error: 'Failed to list shells' })
  }
})

// Get current pane content
app.get('/api/output', async (req, res) => {
  const rawTarget = req.query.target as string | undefined
  const target = rawTarget ? await validatePaneTarget(rawTarget) ?? undefined : undefined
  const output = await bridge.getFullOutput(target)
  res.json({ output })
})

// Get all available panes
app.get('/api/panes', async (req, res) => {
  const panes = await serializePanes()
  res.json({ panes })
})

// Create a new window
app.post('/api/panes', async (req, res) => {
  const cwd = validateCwd(req.body?.cwd) ?? undefined
  const cols = validateDimension(req.body?.cols, 40, 300)
  const rows = validateDimension(req.body?.rows, 10, 100)
  const shellId = validateShellId(req.body?.shellId)
  const newPane = await bridge.createWindow({ cwd, cols, rows, shellId })
  if (newPane) {
    res.json({
      success: true,
      pane: { ...newPane, ...await bridge.getPaneRuntimeState(newPane.target) },
      panes: await serializePanes()
    })
  } else {
    res.status(500).json({ success: false, error: 'Failed to create window' })
  }
})

// Close a window
app.post('/api/panes/close', async (req, res) => {
  const target = await validatePaneTarget(req.body?.target)
  if (!target) {
    return res.status(400).json({ success: false, error: 'Valid target required' })
  }
  const success = await bridge.closeWindow(target)
  if (success) {
    res.json({ success: true, panes: await serializePanes() })
  } else {
    res.status(500).json({ success: false, error: 'Failed to close window' })
  }
})

// Drop scrollback for a pane (used after launching an agent so the pre-TUI
// command echoes don't sit above Claude's UI in the canvas).
app.post('/api/clear-history', async (req, res) => {
  const target = await validatePaneTarget(req.body?.target)
  if (!target) {
    return res.status(400).json({ success: false, error: 'Valid target required' })
  }
  const success = await bridge.clearHistory(target)
  res.json({ success })
})

// Upload one image as a raw binary body. Content-Type header carries
// the mime (e.g. image/jpeg). Route-scoped express.raw parses into a
// Buffer without any JSON/base64 overhead — ~25% less bytes on the
// wire and no parse step compared to base64-wrapped JSON.
//
// Writes <uuid>.<ext> under logs/uploads/ and returns the filename as
// a token. Client holds the token until it sends the message; at that
// point /api/send references the token. Orphan files (uploaded but
// never referenced) get unlinked after UPLOAD_ORPHAN_TTL_MS.
app.post(
  '/api/upload',
  express.raw({ type: () => true, limit: `${Math.ceil(MAX_IMAGE_BYTES / (1024 * 1024))}mb` }),
  (req, res) => {
    const mime = (req.header('content-type') || '').split(';')[0].trim()
    const bytes = req.body
    if (!Buffer.isBuffer(bytes)) {
      return res.status(400).json({ success: false, error: 'bad payload' })
    }
    const result = saveUploadedBytes(bytes, mime)
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error })
    }
    scheduleUnlink(result.path, UPLOAD_ORPHAN_TTL_MS)
    res.json({ success: true, token: result.token })
  }
)

// Send a message, optionally with a list of upload tokens for images the
// client already uploaded via /api/upload. Tokens resolve to paths and
// get typed into the pane alongside the message.
app.post('/api/send', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message : ''
  const hasTokens = Array.isArray(req.body?.tokens) && req.body.tokens.length > 0

  if (!message && !hasTokens) {
    return res.status(400).json({ success: false, error: 'Message or image required' })
  }
  if (message.length > MAX_MESSAGE_CONTENT_CHARS) {
    return res.status(413).json({ success: false, error: 'Message too large' })
  }

  const target = await validatePaneTarget(req.body?.target)
  if (!target) {
    return res.status(400).json({ success: false, error: 'Valid target required' })
  }

  let imagePaths: string[] | undefined
  if (hasTokens) {
    const result = resolveTokens(req.body.tokens)
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error })
    }
    imagePaths = result.paths
  }

  const success = await bridge.sendMessage(message, target, imagePaths)
  if (imagePaths) {
    for (const p of imagePaths) scheduleUnlink(p, UPLOAD_CLEANUP_DELAY_MS)
  }

  res.json({ success })
})

// Send a whitelisted key via REST (fallback)
app.post('/api/key', async (req, res) => {
  const key = req.body?.key
  if (typeof key !== 'string' || key.length === 0) {
    return res.status(400).json({ error: 'Key required' })
  }

  const target = await validatePaneTarget(req.body?.target)
  if (!target) {
    return res.status(400).json({ error: 'Valid target required' })
  }
  const success = await bridge.sendKey(key, target)
  res.json({ success })
})

// Track active pane per client
interface ClientState {
  activePane: string | null
  activePaneTarget: string | null
}
const clientStates = new WeakMap<WebSocket, ClientState>()

async function resolveClientPaneTarget(clientState?: ClientState): Promise<string | null> {
  if (!clientState) return null

  const validatedTarget = clientState.activePaneTarget
    ? await validatePaneTarget(clientState.activePaneTarget)
    : null
  if (validatedTarget) {
    clientState.activePaneTarget = validatedTarget
    return validatedTarget
  }

  if (!clientState.activePane) return null
  const panes = await bridge.listPanes()
  const pane = panes.find(p => p.id === clientState.activePane)
  if (!pane) return null

  clientState.activePaneTarget = pane.target
  return pane.target
}

// WebSocket handling for real-time communication
wss.on('connection', async (ws: WebSocket) => {
  console.log('Client connected')

  // Prevent unhandled 'error' from crashing the process
  ws.on('error', (error) => {
    console.error('WebSocket error:', error)
  })

  // Handle incoming messages. Registered before the initial awaits so no
  // early client frame is dropped.
  ws.on('message', async (data: Buffer) => {
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
      const requestedTarget = typeof msg.paneTarget === 'string' ? await validatePaneTarget(msg.paneTarget) : null
      const paneTarget = requestedTarget ?? await resolveClientPaneTarget(clientState)

      if (msg.type === 'switchPane') {
        // The CLIENT is the authority on which pane it is displaying, so record
        // its stated active pane FIRST and unconditionally (subject only to a
        // sanity bound) -- the term-output fan-out keys solely on this value, so
        // it must track what the user is actually viewing with no drop path.
        //
        // The old shape (`const pane = serializePanes().find(...); if (pane &&
        // clientState) { activePane = pane.id; ... }`) coupled the authoritative
        // state to a best-effort lookup: a transient list miss (a just-created
        // pane not yet in cachedHostPanes, a post-pane-host-restart cache reset,
        // or -- before the synchronous clientStates.set below -- clientState
        // being undefined during a reconnect) silently bailed, leaving activePane
        // pinned to a stale pane. Because the live stream has NO other self-heal,
        // the viewed pane then froze until the user manually switched again.
        // activePane is only ever compared by equality in the fan-out, so a
        // not-yet-listed id simply matches nothing until that pane's bytes appear
        // -- it can never mis-route another pane's output.
        if (clientState && typeof msg.paneId === 'string' && msg.paneId.length > 0 && msg.paneId.length <= 128) {
          clientState.activePane = msg.paneId
          const panes = await serializePanes()
          const pane = panes.find(p => p.id === msg.paneId)
          // Best-effort follow-up: select + size + replay only when the pane is
          // actually live right now. If it isn't yet, the authoritative
          // activePane above already routes its live output the moment it starts;
          // the client keeps its existing buffer until then (no freeze).
          if (pane) {
            clientState.activePaneTarget = pane.target
            // Select the window in tmux (makes it visible in terminal)
            await bridge.selectWindow(pane.target)
            // Resize the pane to the client's measured geometry FIRST (when the
            // switchPane carries it) so subsequent live output is authored at the
            // exact width this client's xterm renders. We do NOT reflow replayed
            // history: the ring is raw VT (same format as live, no double-paint
            // seam) and alt-screen content can't be reflowed anyway; stale-width
            // scrollback self-corrects on the app's next full repaint.
            const swCols = Number.isInteger(msg.cols) ? msg.cols : parseInt(String(msg.cols), 10)
            const swRows = Number.isInteger(msg.rows) ? msg.rows : parseInt(String(msg.rows), 10)
            if (Number.isInteger(swCols) && swCols > 0 && swCols <= 1000) {
              await bridge.resizePane(swCols, Number.isInteger(swRows) && swRows > 0 ? swRows : undefined, pane.target)
            }
            // Replay the pane's history (raw VT ring) into the client's xterm.js;
            // live output then arrives via the term-output fan-out.
            ws.send(JSON.stringify({ type: 'term-replay', paneId: pane.id, data: await bridge.getReplay(pane.id) }))
          }
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
        const success = await bridge.sendMessage(msg.content, paneTarget)
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
        const success = await bridge.sendKey(msg.key, paneTarget)
        ws.send(JSON.stringify({
          type: 'keySent',
          success,
          key: msg.key,
          paneId: clientState?.activePane
        }))
      } else if (msg.type === 'refresh') {
        // Refresh pane list
        const panes = await serializePanes()
        ws.send(JSON.stringify({
          type: 'paneList',
          panes
        }))
        // Live output streams via term-output; the client re-attaches (replay)
        // through switchPane, so no output frame is pushed on refresh.
      } else if (msg.type === 'resize') {
        const cols = Number.isInteger(msg.cols) ? msg.cols : parseInt(String(msg.cols), 10)
        if (!Number.isInteger(cols) || cols <= 0 || cols > 1000) return
        const rows = Number.isInteger(msg.rows) ? msg.rows : parseInt(String(msg.rows), 10)
        if (!paneTarget) return
        // Resize the PTY/tmux pane to the client's measured geometry; the app
        // redraws and that redraw streams via term-output, so we no longer push
        // a post-resize snapshot.
        await bridge.resizePane(cols, Number.isInteger(rows) && rows > 0 ? rows : undefined, paneTarget)
      } else if (msg.type === 'typing') {
        bridge.setTypingState(msg.isTyping === true)
      } else if (msg.type === 'serverStop') {
        if (!paneTarget) {
          ws.send(JSON.stringify({ type: 'serverAction', action: 'stop', success: false, error: 'No active pane target' }))
          return
        }
        const success = await bridge.stopServer(paneTarget)
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
        const success = await bridge.restartServer(paneTarget)
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

  // Create the client's state SYNCHRONOUSLY, before the awaits below. A
  // reconnecting client sends `switchPane` from its socket.onopen the instant
  // the handshake completes (syncSocketSession), and that frame can land while
  // serializePanes() -- a round-trip to the pane-host on Windows -- is still in
  // flight. The message handler is already registered, so it runs with
  // clientStates.get(ws) === undefined; the switchPane guard `if (pane &&
  // clientState)` then silently drops it, the default below pins activePane to
  // the FIRST pane, and the output fan-out streams the wrong pane -- the pane
  // the user is actually viewing goes dark ("frozen") until they switch tabs
  // (which re-sends switchPane after setup has completed). Manifests with 2+
  // panes when the active one isn't panes[0]; re-triggers on every
  // background->resume because each resume reconnects. The slow Windows pipe
  // RPC makes the window wide enough to hit reliably; tmux's fast local
  // listPanes mostly hides it, but the race is the same shared code.
  clientStates.set(ws, { activePane: null, activePaneTarget: null })

  try {
    const panes = await serializePanes()
    const clientState = clientStates.get(ws)

    // Send pane list
    ws.send(JSON.stringify({
      type: 'paneList',
      panes
    }))

    // Default to the first pane ONLY if the client hasn't already chosen one
    // via a switchPane that raced the await above (clientState is mutated, never
    // replaced, so that choice survives). Skipped entirely if the socket closed
    // mid-setup (close handler deleted the state). Live output then arrives via
    // the term-output fan-out.
    if (clientState && !clientState.activePane) {
      const initialPane = panes[0] || null
      clientState.activePane = initialPane?.id || null
      clientState.activePaneTarget = initialPane?.target || null
      if (initialPane) {
        ws.send(JSON.stringify({ type: 'term-replay', paneId: initialPane.id, data: await bridge.getReplay(initialPane.id) }))
      }
    }
  } catch (error) {
    console.error('Error initializing WS client:', error)
  }
})

// Fan out live VT output to each client watching that pane. One global
// subscription; xterm.js in the browser renders the stream. Runtime state
// (agent/server/mode) rides the separate 2s paneRuntimeList broadcast.
bridge.subscribeOutput((paneId, data) => {
  const message = JSON.stringify({ type: 'term-output', paneId, data })
  wss.clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return
    const clientState = clientStates.get(client)
    if (clientState?.activePane === paneId) {
      try { client.send(message) } catch (err) { console.error('Failed to send term-output:', err) }
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
// reflect current agent/shell state regardless of which pane is active.
async function broadcastRuntimeStates() {
  if (wss.clients.size === 0) return
  try {
    const states = await bridge.getAllPaneRuntimeStates()
    const payload = JSON.stringify({ type: 'paneRuntimeList', states })
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(payload) } catch {}
      }
    })
  } catch (error) {
    console.error('Error broadcasting runtime states:', error)
  }
}

// An async TLS probe that upgrades a newly-seen port from the default http
// guess to https fires this event. Debounce so a cluster of near-simultaneous
// probes only triggers one extra broadcast, and so we don't race the next
// scheduled 2s tick.
let earlyBroadcastTimer: NodeJS.Timeout | null = null
bridge.on('protocolResolved', () => {
  if (earlyBroadcastTimer) return
  earlyBroadcastTimer = setTimeout(() => {
    earlyBroadcastTimer = null
    void broadcastRuntimeStates()
  }, 80)
})

// The terminal session was auto-recreated (user killed tmux, the pane-host
// died, etc). The fresh session has new pane IDs, so clients need a fresh
// paneList — otherwise they'd sit on stale state until they refreshed
// manually. Clients already handle "my activePane disappeared" inside
// handlePaneList by switching to the first available pane.
bridge.on('sessionRecreated', async () => {
  if (wss.clients.size === 0) return
  try {
    const panes = await serializePanes()
    const payload = JSON.stringify({ type: 'paneList', panes })
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(payload) } catch {}
      }
    })
    void broadcastRuntimeStates()
  } catch (error) {
    console.error('Error handling sessionRecreated:', error)
  }
})

const PANE_STATE_BROADCAST_MS = 2000
setInterval(() => {
  void broadcastRuntimeStates()
}, PANE_STATE_BROADCAST_MS)

// Start polling for output changes
bridge.startPolling()

// JSON error handler — catches body-parser rejections (oversized payloads,
// malformed JSON) so clients parsing xhr.responseText always get a JSON
// shape instead of Express's default HTML error page. Must be registered
// AFTER all routes.
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err)
  if (err && (err.type === 'entity.too.large' || err.statusCode === 413)) {
    return res.status(413).json({ success: false, error: 'image too large' })
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'malformed body' })
  }
  console.error('Unhandled request error:', err)
  res.status(500).json({ success: false, error: 'internal error' })
})

httpServer.listen(PORT, HOST, () => {
  void (async () => {
    const sessionUp = await bridge.sessionExists()
    console.log(`
  Claude Relay Server
  ------------------------------------------------------------
  Listening on http://${HOST}:${PORT}
  Session:      ${sessionUp ? 'Connected' : 'NOT FOUND'}
  Agents:       ${getAgents().map(a => a.id).join(', ')}
`)
  })()
})

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...')
  bridge.stopPolling()
  httpServer.close()
  process.exit(0)
})
