// The pane-host daemon: the tmux-server role on Windows. Owns one
// ConPTY per pane and serves a tiny NDJSON RPC over a named pipe.
//
// Design rule: this process must stay so simple it never needs a
// restart in normal feature work — it is the persistence layer. Panes
// (and the dev servers / Claude sessions inside them) survive relay
// restarts precisely because nothing here depends on relay code.
//
// Run: node tsx src/win/pane-host.ts --session <name>
// Spawned detached+hidden by WinBridge when the pipe is absent.

import net from 'net'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { spawn as ptySpawn, IPty } from '@lydell/node-pty'
// @xterm/headless ships as bundled CommonJS: its package `main` is a UMD
// bundle and Node ignores the `module` (ESM) field for a bare specifier
// with no `exports` map, so Node's ESM loader can't statically detect its
// named exports - `import { Terminal }` throws "does not provide an export
// named 'Terminal'" and the pane-host dies at startup. Default-import the
// module object, destructure the class at runtime, and re-derive the
// instance type with InstanceType so the type positions still resolve.
import xtermHeadless from '@xterm/headless'
import { PROTOCOL_VERSION, paneHostPipePath, HostPane, CreateParams, HostResponse } from './protocol.js'
import { serializeScreen } from './serialize-screen.js'
import { RingBuffer } from '../ring-buffer.js'

const { Terminal } = xtermHeadless
type Terminal = InstanceType<typeof Terminal>

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const SESSION = argValue('--session') || 'dev'
const BOOT_ID = crypto.randomUUID()
const SCROLLBACK = 500 // matches the tmux path's CAPTURE_LINES

// --- logging --------------------------------------------------------------

const LOG_PATH = path.join(__dirname, '..', '..', 'logs', 'pane-host.log')
function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    fs.appendFileSync(LOG_PATH, line)
  } catch {}
}

// --- pane state -------------------------------------------------------------

interface PaneRecord {
  id: string
  index: number
  pid: number
  shellId: string
  shellKind: string
  cwd: string
  cols: number
  rows: number
  seq: number
  meta: Record<string, string>
  pty: IPty
  term: Terminal
  ring: RingBuffer
}

const panes = new Map<string, PaneRecord>()
let nextIndex = 0

// Connected relay clients (normally one). Live output is pushed to all of them
// as unsolicited NDJSON notifications; the relay fans out to browsers.
const clients = new Set<net.Socket>()
function pushOutput(id: string, data: string): void {
  if (clients.size === 0) return
  const line = JSON.stringify({ type: 'output', id, data }) + '\n'
  for (const socket of clients) {
    try { socket.write(line) } catch {}
  }
}

function toHostPane(p: PaneRecord): HostPane {
  return {
    id: p.id,
    index: p.index,
    pid: p.pid,
    shellId: p.shellId,
    shellKind: p.shellKind,
    cwd: p.cwd,
    cols: p.cols,
    rows: p.rows,
    seq: p.seq,
    meta: p.meta
  }
}

function createPane(params: CreateParams): HostPane {
  const index = nextIndex++
  const id = `w${index}`
  const cols = clamp(params.cols, 40, 300)
  const rows = clamp(params.rows, 10, 100)

  const pty = ptySpawn(params.file, params.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: params.cwd,
    // Force Claude Code's classic inline renderer (vs the alt-screen fullscreen
    // TUI it defaults to since v2.1.89). Inline output flows into xterm's native
    // scrollback in the browser, so scrolling is smooth/consistent and never
    // re-wraps mid-scroll. Claude-only var; other agents/shells ignore it.
    env: { ...process.env, CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' } as Record<string, string>
  })

  // allowProposedApi enables the buffer cell-inspection API (per-cell
  // colors/attributes) that serializeScreen() reads to build the capture.
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })

  const record: PaneRecord = {
    id,
    index,
    pid: pty.pid,
    shellId: params.shellId,
    shellKind: params.shellKind,
    cwd: params.cwd,
    cols,
    rows,
    seq: 0,
    meta: params.meta || {},
    pty,
    term,
    ring: new RingBuffer(256 * 1024)
  }

  pty.onData(data => {
    record.term.write(data)
    record.ring.push(data)
    pushOutput(record.id, data)
    record.seq++
  })

  pty.onExit(({ exitCode }) => {
    log(`pane ${id} exited (code ${exitCode})`)
    const current = panes.get(id)
    if (current === record) {
      panes.delete(id)
      try { record.term.dispose() } catch {}
    }
  })

  panes.set(id, record)
  log(`pane ${id} created: ${params.file} ${params.args.join(' ')} (pid ${pty.pid})`)
  return toHostPane(record)
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function killPane(id: string): void {
  const record = panes.get(id)
  if (!record) return
  panes.delete(id)
  try { record.pty.kill() } catch {}
  try { record.term.dispose() } catch {}
  log(`pane ${id} killed`)
}

// Rendered screen + scrollback as capture-pane-style flat text+SGR: real
// spaces (no cursor-motion escapes), \n line endings - matching the
// POSIX/tmux path that the relay's pipeline (toLines, diffing, mode
// detection) and the shared web renderer expect. See serialize-screen.ts
// for why we don't use SerializeAddon's replay-stream output.
function capturePane(record: PaneRecord, lines?: number): string {
  return serializeScreen(record.term, lines)
}

function clearScrollback(record: PaneRecord): void {
  // Clears scrollback AND resets the viewport to a blank screen with the
  // cursor at top — the shell repaints its prompt on the next output.
  record.term.clear()
  record.ring.clear()
  record.seq++
}

// --- RPC server ---------------------------------------------------------------

function handleRequest(method: string, params: any): unknown {
  switch (method) {
    case 'hello':
      return { version: PROTOCOL_VERSION, session: SESSION, bootId: BOOT_ID }
    case 'list':
      return { panes: [...panes.values()].sort((a, b) => a.index - b.index).map(toHostPane) }
    case 'create': {
      if (!params || typeof params.file !== 'string' || !Array.isArray(params.args)) {
        throw new Error('create: file and args required')
      }
      return { pane: createPane(params as CreateParams) }
    }
    case 'kill':
      killPane(String(params?.id))
      return {}
    case 'write': {
      const record = panes.get(String(params?.id))
      if (!record) throw new Error('no such pane')
      if (typeof params.data !== 'string') throw new Error('write: data required')
      record.pty.write(params.data)
      return {}
    }
    case 'resize': {
      const record = panes.get(String(params?.id))
      if (!record) throw new Error('no such pane')
      const cols = clamp(params.cols, 40, 300)
      const rows = clamp(params.rows, 10, 100)
      if (cols !== record.cols || rows !== record.rows) {
        record.pty.resize(cols, rows)
        record.term.resize(cols, rows)
        record.cols = cols
        record.rows = rows
        record.seq++
      }
      return {}
    }
    case 'capture': {
      const record = panes.get(String(params?.id))
      if (!record) throw new Error('no such pane')
      const lines = Number.isInteger(params?.lines) ? params.lines : undefined
      return { text: capturePane(record, lines) }
    }
    case 'getReplay': {
      const record = panes.get(String(params?.id))
      if (!record) throw new Error('no such pane')
      return { data: record.ring.replay() }
    }
    case 'clearScrollback': {
      const record = panes.get(String(params?.id))
      if (!record) throw new Error('no such pane')
      clearScrollback(record)
      return {}
    }
    default:
      throw new Error(`unknown method: ${method}`)
  }
}

const pipePath = paneHostPipePath(SESSION)

const server = net.createServer(socket => {
  let buffer = ''
  socket.setEncoding('utf-8')
  clients.add(socket)
  socket.on('close', () => clients.delete(socket))
  socket.on('data', chunk => {
    buffer += chunk
    // Backstop against a runaway client — no legitimate request is 10 MB.
    if (buffer.length > 10 * 1024 * 1024) {
      socket.destroy()
      return
    }
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx)
      buffer = buffer.slice(newlineIdx + 1)
      if (!line.trim()) continue
      let response: HostResponse
      let rid = 0
      try {
        const req = JSON.parse(line)
        rid = typeof req?.rid === 'number' ? req.rid : 0
        const result = handleRequest(String(req?.method), req?.params)
        response = { rid, ok: true, result }
      } catch (err) {
        response = { rid, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      try { socket.write(JSON.stringify(response) + '\n') } catch {}
    }
  })
  socket.on('error', () => { clients.delete(socket) })
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // Another pane-host already owns this pipe — single-instance by
    // construction. Exit quietly; the relay connects to the incumbent.
    log('pipe already in use; exiting (incumbent pane-host wins)')
    process.exit(0)
  }
  log(`pipe server error: ${err.message}`)
  process.exit(1)
})

server.listen(pipePath, () => {
  log(`pane-host up: session '${SESSION}', pipe ${pipePath}, pid ${process.pid}`)
})

// Never die with the relay: ignore the signals a closing parent console
// might forward. launchd-style supervision isn't needed — the relay
// respawns us if the pipe goes away.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})
process.on('uncaughtException', err => {
  log(`uncaught: ${err?.stack || err}`)
})
process.on('unhandledRejection', reason => {
  log(`unhandled rejection: ${reason}`)
})
