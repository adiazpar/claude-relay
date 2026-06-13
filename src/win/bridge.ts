// The Windows session bridge: a client of the pane-host daemon. The
// pane-host owns the ConPTYs (so panes survive relay restarts); this
// side owns everything smart — detection, protocol probing, key
// mapping, WSL translation — so feature work needs no pane-host change.

import { EventEmitter } from 'events'
import { spawn, execFile } from 'child_process'
import net from 'net'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { TMUX_SESSION } from '../config.js'
import { getAgents } from '../agents.js'
import {
  SessionBridge, PaneInfo, PaneRuntimeState, PaneRuntimeRow, ServerPort,
  AgentMode, CreateWindowOptions, emptyRuntimeState
} from '../bridge.js'
import {
  ProtocolProber, detectAgentInTree, detectServerInTree, detectModeFromOutput,
  buildChildrenIndex, ProcessEntry
} from '../detection.js'
import { PROTOCOL_VERSION, paneHostPipePath, HostPane, CreateParams, HelloResult } from './protocol.js'
import { PowerShellWorker, WinSnapshot, WslSnapshot, emptySnapshot, wslSnapshot } from './detect.js'
import { getShellSpec, getDefaultShell, ShellSpec, WSL_TOKEN_PLACEHOLDER } from './shells.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const POLL_INTERVAL = 500 // ms
const CAPTURE_LINES = 500
const RPC_TIMEOUT_MS = 5000
const SPAWN_COOLDOWN_MS = 5000
const SNAPSHOT_MEMO_MS = 1000
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 30

// ConPTY plumbing that lives inside every pane's tree but is never "the
// user's process": with only these below the shell, the pane is idle.
const IGNORABLE_CHILD_RE = /\\?(conhost\.exe|openconsole\.exe)\b/i

// VT byte sequences for the client's whitelisted key names. ConPTY
// translates these to console input records for legacy apps and passes
// them through raw to VT-aware TUIs (Claude Code et al).
const KEY_MAP: Record<string, string> = {
  'Up': '\x1b[A',
  'Down': '\x1b[B',
  'Left': '\x1b[D',
  'Right': '\x1b[C',
  'Enter': '\r',
  'Escape': '\x1b',
  'Tab': '\t',
  'S-Tab': '\x1b[Z',
  'Space': ' ',
  'Backspace': '\x7f',
}

// --- pipe RPC client --------------------------------------------------------

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

class PipeClient {
  private socket: net.Socket
  private buffer = ''
  private nextRid = 1
  private pending = new Map<number, Pending>()
  private closed = false
  onClose: (() => void) | null = null
  onOutput: ((id: string, data: string) => void) | null = null

  private constructor(socket: net.Socket) {
    this.socket = socket
    socket.setEncoding('utf-8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      let idx: number
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg && msg.type === 'output') {
            this.onOutput?.(String(msg.id), typeof msg.data === 'string' ? msg.data : '')
            continue
          }
          const entry = this.pending.get(msg?.rid)
          if (entry) {
            this.pending.delete(msg.rid)
            clearTimeout(entry.timer)
            if (msg.ok) entry.resolve(msg.result)
            else entry.reject(new Error(String(msg.error || 'pane-host error')))
          }
        } catch {
          // Malformed line — skip; rid timeout will clean up the caller.
        }
      }
    })
    const teardown = () => {
      if (this.closed) return
      this.closed = true
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('pane-host connection closed'))
      }
      this.pending.clear()
      this.onClose?.()
    }
    socket.on('close', teardown)
    socket.on('error', teardown)
  }

  static connect(pipePath: string, timeoutMs = 2000): Promise<PipeClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(pipePath)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('pipe connect timeout'))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(new PipeClient(socket))
      })
      socket.once('error', err => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  get isOpen(): boolean {
    return !this.closed
  }

  request<T = any>(method: string, params: object = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new Error('pane-host connection closed'))
      const rid = this.nextRid++
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        reject(new Error(`pane-host rpc timeout: ${method}`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(rid, { resolve, reject, timer })
      try {
        this.socket.write(JSON.stringify({ rid, method, params }) + '\n')
      } catch (err) {
        this.pending.delete(rid)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  destroy(): void {
    try { this.socket.destroy() } catch {}
  }
}

// --- bridge ---------------------------------------------------------------

export class WinBridge extends EventEmitter implements SessionBridge {
  private client: PipeClient | null = null
  private connecting: Promise<PipeClient | null> | null = null
  private lastBootId: string | null = null
  private lastSpawnAttempt = 0
  private lastDefaultPaneAttempt = 0

  private polling = false
  private pollTimer: NodeJS.Timeout | null = null
  private pollBusy = false

  private lastOutputByPane = new Map<string, string>()
  private lastSeqByPane = new Map<string, number>()
  private cachedHostPanes = new Map<string, HostPane>() // by pane id
  private lastRuntimeByTarget = new Map<string, PaneRuntimeState>()
  private outputHandlers = new Set<(paneId: string, data: string) => void>()

  private prober = new ProtocolProber()
  private worker = new PowerShellWorker()
  private snapshotMemo: { at: number; promise: Promise<{ win: WinSnapshot; wsl: Map<string, WslSnapshot> }> } | null = null

  constructor() {
    super()
    this.prober.on('resolved', (port: number, protocol: 'https') => {
      this.emit('protocolResolved', port, protocol)
    })
  }

  // ----- host lifecycle -----

  private spawnPaneHost(): void {
    const now = Date.now()
    if (now - this.lastSpawnAttempt < SPAWN_COOLDOWN_MS) return
    this.lastSpawnAttempt = now
    try {
      // The pane-host is TypeScript run through tsx, same as the relay,
      // but launched as `node --import tsx <entry>` (loader in-process)
      // rather than `node <tsx-cli> <entry>`. The tsx CLI re-spawns node
      // internally to inject its loader flags; on Windows that inner
      // process gets a fresh, VISIBLE console window that `windowsHide`
      // cannot suppress — because this outer process is `detached`
      // (DETACHED_PROCESS = no console), the inner one has none to
      // inherit and Windows hands it a new visible one. Loading the tsx
      // loader in-process keeps the pane-host to a single detached,
      // console-less process, so no window ever appears.
      const paneHostPath = path.join(__dirname, 'pane-host.ts')
      const child = spawn(process.execPath, ['--import', 'tsx', paneHostPath, '--session', TMUX_SESSION], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: path.join(__dirname, '..', '..')
      })
      child.unref()
      console.log(`Spawned pane-host (pid ${child.pid})`)
    } catch (err) {
      console.error('Failed to spawn pane-host:', err)
    }
  }

  // Connect to the pane-host, spawning it if the pipe is absent. A
  // changed bootId means the previous host (and every pane in it) is
  // gone — the Windows equivalent of "tmux session was recreated".
  private ensureConnected(): Promise<PipeClient | null> {
    if (this.client?.isOpen) return Promise.resolve(this.client)
    if (this.connecting) return this.connecting

    this.connecting = (async (): Promise<PipeClient | null> => {
      const pipePath = paneHostPipePath(TMUX_SESSION)
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const client = await PipeClient.connect(pipePath)
          const hello = await client.request<HelloResult>('hello')
          if (hello.version !== PROTOCOL_VERSION) {
            console.warn(`pane-host protocol v${hello.version} != relay v${PROTOCOL_VERSION} — restart the pane-host (close its panes) after updating`)
          }
          client.onClose = () => {
            if (this.client === client) this.client = null
          }
          client.onOutput = (id, data) => {
            for (const h of this.outputHandlers) h(id, data)
          }
          const isFreshHost = this.lastBootId !== null && this.lastBootId !== hello.bootId
          this.lastBootId = hello.bootId
          this.client = client
          if (isFreshHost) {
            console.log('pane-host was restarted; resetting pane caches')
            this.lastOutputByPane.clear()
            this.lastSeqByPane.clear()
            this.cachedHostPanes.clear()
            this.lastRuntimeByTarget.clear()
            this.prober.clear()
            this.emit('sessionRecreated')
          }
          return client
        } catch {
          // Pipe absent or dead — spawn (rate-limited) and retry once.
          if (attempt === 0) {
            this.spawnPaneHost()
            await new Promise(r => setTimeout(r, 750))
          }
        }
      }
      return null
    })().finally(() => { this.connecting = null })

    return this.connecting
  }

  private async hostPanes(): Promise<HostPane[]> {
    const client = await this.ensureConnected()
    if (!client) return []
    try {
      const result = await client.request<{ panes: HostPane[] }>('list')
      const panes = result.panes || []
      this.cachedHostPanes = new Map(panes.map(p => [p.id, p]))
      return panes
    } catch (err) {
      console.error('Failed to list panes:', err)
      return []
    }
  }

  private toPaneInfo(p: HostPane): PaneInfo {
    return {
      id: p.id,
      target: `${TMUX_SESSION}:${p.index}`,
      index: p.index,
      windowIndex: p.index,
      cwd: p.cwd,
      panePid: p.pid,
      currentCommand: p.shellId,
      paneTitle: '',
      width: p.cols,
      height: p.rows,
      shellId: p.shellId
    }
  }

  private async findHostPane(target?: string): Promise<HostPane | null> {
    if (!target) return null
    const panes = await this.hostPanes()
    return panes.find(p => `${TMUX_SESSION}:${p.index}` === target) || null
  }

  // ----- SessionBridge -----

  async sessionExists(): Promise<boolean> {
    return (await this.ensureConnected()) !== null
  }

  async listPanes(): Promise<PaneInfo[]> {
    const panes = await this.hostPanes()
    return panes.map(p => this.toPaneInfo(p))
  }

  async createWindow(opts: CreateWindowOptions = {}): Promise<PaneInfo | null> {
    const client = await this.ensureConnected()
    if (!client) {
      console.error('pane-host unavailable; cannot create pane')
      return null
    }

    const spec: ShellSpec | null = opts.shellId
      ? await getShellSpec(opts.shellId)
      : await getDefaultShell()
    if (!spec) {
      console.error(`No such shell: ${opts.shellId ?? '(default)'}`)
      return null
    }

    const meta: Record<string, string> = {}
    let args = spec.args
    if (spec.kind === 'wsl') {
      const token = crypto.randomBytes(6).toString('hex')
      meta.wslToken = token
      meta.distro = spec.distro || ''
      args = spec.args.map(a => a.replaceAll(WSL_TOKEN_PLACEHOLDER, token))
    }

    const params: CreateParams = {
      file: spec.file,
      args,
      cwd: opts.cwd || process.env.USERPROFILE || 'C:\\',
      cols: opts.cols ?? DEFAULT_COLS,
      rows: opts.rows ?? DEFAULT_ROWS,
      shellId: spec.id,
      shellKind: spec.kind,
      meta
    }

    try {
      const result = await client.request<{ pane: HostPane }>('create', params)
      this.cachedHostPanes.set(result.pane.id, result.pane)
      return this.toPaneInfo(result.pane)
    } catch (err) {
      console.error('Failed to create pane:', err)
      return null
    }
  }

  async clearHistory(target: string): Promise<boolean> {
    const pane = await this.findHostPane(target)
    const client = this.client
    if (!pane || !client?.isOpen) return false
    try {
      await client.request('clearScrollback', { id: pane.id })
      return true
    } catch (err) {
      console.error('Failed to clear history:', err)
      return false
    }
  }

  async closeWindow(target: string): Promise<boolean> {
    const pane = await this.findHostPane(target)
    const client = this.client
    if (!pane || !client?.isOpen) return false
    try {
      await client.request('kill', { id: pane.id })
      this.lastOutputByPane.delete(pane.id)
      this.lastSeqByPane.delete(pane.id)
      this.cachedHostPanes.delete(pane.id)
      return true
    } catch (err) {
      console.error('Failed to close pane:', err)
      return false
    }
  }

  private async write(paneId: string, data: string): Promise<boolean> {
    const client = await this.ensureConnected()
    if (!client) return false
    try {
      await client.request('write', { id: paneId, data })
      return true
    } catch (err) {
      console.error('Failed to write to pane:', err)
      return false
    }
  }

  // C:\foo\bar.png → /mnt/c/foo/bar.png (default WSL automount). Panes
  // inside a distro can't read Windows paths, so image attachments get
  // translated before being typed.
  private winPathToWsl(p: string): string {
    const m = p.match(/^([A-Za-z]):[\\/](.*)$/)
    if (!m) return p
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
  }

  async sendMessage(message: string, target?: string, imagePaths?: string[]): Promise<boolean> {
    if (!target) {
      console.error('Refusing to send message without a pane target')
      return false
    }
    const pane = await this.findHostPane(target)
    if (!pane) {
      console.error('No such pane:', target)
      return false
    }

    const hasImages = !!imagePaths && imagePaths.length > 0

    // `clear` at an idle shell prompt: translate to a real screen wipe
    // (Ctrl-L, or `cls` for cmd which has no Ctrl-L binding) plus a
    // scrollback drop — parity with the tmux path. Runtime state from
    // the 2s detection cycle tells us whether the pane is shell-ready;
    // when an agent is running, "clear" passes through to its input.
    if (!hasImages && message.trim() === 'clear') {
      const state = this.lastRuntimeByTarget.get(target)
      if (state?.shellReady) {
        const ok = pane.shellKind === 'cmd'
          ? await this.write(pane.id, 'cls\r')
          : await this.write(pane.id, '\x0c')
        if (ok) {
          setTimeout(() => {
            this.client?.request('clearScrollback', { id: pane.id }).catch(() => {})
          }, 250)
          return true
        }
      }
    }

    let paths = imagePaths || []
    if (hasImages && pane.shellKind === 'wsl') {
      paths = paths.map(p => this.winPathToWsl(p))
    }

    const prefix = hasImages ? paths.join(' ') : ''
    const payload = hasImages
      ? (message.length > 0 ? `${prefix} ${message}` : prefix)
      : message

    return this.write(pane.id, payload + '\r')
  }

  async sendKey(key: string, target?: string): Promise<boolean> {
    if (!target) {
      console.error('Refusing to send key without a pane target')
      return false
    }
    const seq = KEY_MAP[key]
    if (!seq) {
      console.error('Rejected unknown key:', key)
      return false
    }
    const pane = await this.findHostPane(target)
    if (!pane) return false
    return this.write(pane.id, seq)
  }

  private async capture(paneId: string, lines?: number): Promise<string> {
    const client = await this.ensureConnected()
    if (!client) return ''
    try {
      const result = await client.request<{ text: string }>('capture', { id: paneId, lines })
      return result.text || ''
    } catch (err) {
      console.error('Failed to capture pane:', err)
      return ''
    }
  }

  async getFullOutput(target?: string): Promise<string> {
    const pane = target
      ? await this.findHostPane(target)
      : (await this.hostPanes())[0] || null
    if (!pane) return ''
    return this.capture(pane.id, CAPTURE_LINES)
  }

  async detectMode(target?: string): Promise<AgentMode> {
    const pane = target
      ? await this.findHostPane(target)
      : (await this.hostPanes())[0] || null
    if (!pane) return 'normal'
    return detectModeFromOutput(await this.capture(pane.id, 30))
  }

  async resizePane(cols: number, rows?: number, target?: string): Promise<boolean> {
    if (!target) {
      console.error('Refusing to resize without a pane target')
      return false
    }
    const pane = await this.findHostPane(target)
    const client = this.client
    if (!pane || !client?.isOpen) return false
    try {
      await client.request('resize', {
        id: pane.id,
        cols: Math.max(40, Math.min(300, cols)),
        rows: rows !== undefined ? Math.max(10, Math.min(100, rows)) : pane.rows
      })
      return true
    } catch (err) {
      console.error('Failed to resize pane:', err)
      return false
    }
  }

  // No attach concept on Windows — the pane-host has no local viewer to
  // sync. The web UI (desktop browser included) is the viewer.
  async selectWindow(_target: string): Promise<boolean> {
    return true
  }

  setTypingState(_isTyping: boolean): void {}

  // ----- detection -----

  // One Windows snapshot + one pass per WSL distro in use, memoized for
  // 1s so an output-event burst and the 2s broadcast don't double-pay.
  private getSnapshots(): Promise<{ win: WinSnapshot; wsl: Map<string, WslSnapshot> }> {
    const now = Date.now()
    if (this.snapshotMemo && now - this.snapshotMemo.at < SNAPSHOT_MEMO_MS) {
      return this.snapshotMemo.promise
    }
    const promise = (async () => {
      const distros = new Set<string>()
      for (const p of this.cachedHostPanes.values()) {
        if (p.shellKind === 'wsl' && p.meta?.distro) distros.add(p.meta.distro)
      }
      const [win, ...wslResults] = await Promise.all([
        this.worker.snapshot(),
        ...[...distros].map(d => wslSnapshot(d))
      ])
      const wsl = new Map<string, WslSnapshot>()
      ;[...distros].forEach((d, i) => wsl.set(d, wslResults[i]))
      return { win, wsl }
    })().catch(err => {
      console.error('Snapshot failed:', err)
      return { win: emptySnapshot(), wsl: new Map<string, WslSnapshot>() }
    })
    this.snapshotMemo = { at: now, promise }
    return promise
  }

  private hasForegroundWork(rootPid: number, processes: ProcessEntry[]): boolean {
    const byParent = buildChildrenIndex(processes)
    const stack = (byParent.get(rootPid) || []).map(p => p.pid)
    const seen = new Set<number>()
    const byPid = new Map(processes.map(p => [p.pid, p]))
    while (stack.length > 0) {
      const pid = stack.pop()!
      if (seen.has(pid)) continue
      seen.add(pid)
      const proc = byPid.get(pid)
      if (proc && !IGNORABLE_CHILD_RE.test(proc.command)) return true
      for (const child of byParent.get(pid) || []) stack.push(child.pid)
    }
    return false
  }

  private computeRuntimeState(
    pane: HostPane,
    win: WinSnapshot,
    wsl: Map<string, WslSnapshot>
  ): PaneRuntimeState {
    const agents = getAgents()

    let rootPid = pane.pid
    let processes = win.processes
    let listeningByPid = win.listeningByPid

    if (pane.shellKind === 'wsl') {
      const snap = pane.meta?.distro ? wsl.get(pane.meta.distro) : undefined
      const shellPid = snap && pane.meta?.wslToken ? snap.shellPidByToken.get(pane.meta.wslToken) : undefined
      if (!snap || !shellPid) {
        // Distro snapshot failed or the marker is gone — degrade to "idle
        // shell unknown": no buttons light up, terminal still works.
        return { ...emptyRuntimeState(), currentCommand: pane.shellId }
      }
      rootPid = shellPid
      processes = snap.processes
      listeningByPid = snap.listeningByPid
    }

    const agentId = detectAgentInTree(rootPid, agents, processes)
    const shellReady = !agentId && !this.hasForegroundWork(rootPid, processes)

    let serverRunning = false
    let serverCommand: string | null = null
    let serverPorts: ServerPort[] = []
    if (!agentId) {
      const detected = detectServerInTree(rootPid, listeningByPid, processes, this.prober.getPortProtocol)
      if (detected) {
        serverRunning = true
        serverCommand = detected.command
        serverPorts = detected.ports
      }
    }

    return {
      agentId,
      shellReady,
      currentCommand: pane.shellId,
      serverRunning,
      serverCommand,
      serverPorts,
      mode: null
    }
  }

  async getPaneRuntimeState(target?: string): Promise<PaneRuntimeState> {
    if (!target) return emptyRuntimeState()
    const pane = await this.findHostPane(target)
    if (!pane) return emptyRuntimeState()
    const { win, wsl } = await this.getSnapshots()
    const state = this.computeRuntimeState(pane, win, wsl)
    if (state.agentId) state.mode = detectModeFromOutput(await this.capture(pane.id, 30))
    this.lastRuntimeByTarget.set(target, state)
    return state
  }

  async getAllPaneRuntimeStates(): Promise<PaneRuntimeRow[]> {
    const panes = await this.hostPanes()
    const { win, wsl } = await this.getSnapshots()

    // GC the protocol cache against everything currently listening
    // (Windows side and inside the distros).
    const activePorts = new Set<number>()
    for (const ports of win.listeningByPid.values()) for (const p of ports) activePorts.add(p)
    for (const snap of wsl.values()) {
      for (const ports of snap.listeningByPid.values()) for (const p of ports) activePorts.add(p)
    }
    this.prober.gc(activePorts)

    this.lastRuntimeByTarget.clear()
    return Promise.all(panes.map(async pane => {
      const target = `${TMUX_SESSION}:${pane.index}`
      const state = this.computeRuntimeState(pane, win, wsl)
      if (state.agentId) state.mode = detectModeFromOutput(await this.capture(pane.id, 30))
      this.lastRuntimeByTarget.set(target, state)
      return { paneId: pane.id, target, ...state }
    }))
  }

  subscribeOutput(handler: (paneId: string, data: string) => void): () => void {
    this.outputHandlers.add(handler)
    return () => { this.outputHandlers.delete(handler) }
  }

  async getReplay(paneId: string): Promise<string> {
    const client = await this.ensureConnected()
    if (!client) return ''
    try {
      const r = await client.request<{ data: string }>('getReplay', { id: paneId })
      return r?.data ?? ''
    } catch {
      return ''
    }
  }

  async stopServer(target: string): Promise<boolean> {
    const pane = await this.findHostPane(target)
    if (!pane) return false
    // \x03 through ConPTY becomes CTRL_C_EVENT for the foreground app —
    // the send-keys C-c equivalent.
    return this.write(pane.id, '\x03')
  }

  async restartServer(target: string): Promise<boolean> {
    const pane = await this.findHostPane(target)
    if (!pane) return false

    // Capture the shell-level command BEFORE Ctrl-C — once the process
    // tree is gone we can't look it up.
    const { win, wsl } = await this.getSnapshots()
    const state = this.computeRuntimeState(pane, win, wsl)
    if (!state.serverRunning || !state.serverCommand) {
      console.error('No server command found to restart for pane', target)
      return false
    }
    const command = state.serverCommand

    if (!await this.write(pane.id, '\x03')) return false

    setTimeout(async () => {
      try {
        // Flush any half-typed input before replaying the command:
        // PSReadLine and cmd both clear the line on Esc; bash and WSL
        // shells use Ctrl-U.
        const flush = pane.shellKind === 'gitbash' || pane.shellKind === 'wsl' ? '\x15' : '\x1b'
        await this.write(pane.id, flush)
        await this.write(pane.id, command + '\r')
      } catch (err) {
        console.error('Failed to replay server command:', err)
      }
    }, 250)
    return true
  }

  // ----- polling -----

  startPolling(): void {
    if (this.polling) return
    this.polling = true
    this.pollTimer = setInterval(() => {
      if (this.pollBusy) return // a slow tick (host respawn) shouldn't stack
      this.pollBusy = true
      this.pollTick()
        .catch(err => console.error('Poll tick failed:', err))
        .finally(() => { this.pollBusy = false })
    }, POLL_INTERVAL)
  }

  stopPolling(): void {
    this.polling = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.lastOutputByPane.clear()
    this.lastSeqByPane.clear()
    this.worker.dispose()
  }

  private async pollTick(): Promise<void> {
    const client = await this.ensureConnected()
    if (!client) return

    const panes = await this.hostPanes()

    // Self-heal parity with tmux: an empty host (every pane exited, or a
    // fresh host after a crash) gets one default pane back, and clients
    // get a fresh paneList push via sessionRecreated.
    if (panes.length === 0) {
      const now = Date.now()
      if (now - this.lastDefaultPaneAttempt >= SPAWN_COOLDOWN_MS) {
        this.lastDefaultPaneAttempt = now
        const created = await this.createWindow({})
        if (created) {
          console.log('Created fresh default pane (no panes left)')
          this.emit('sessionRecreated')
        }
      }
      return
    }

    // Live output now streams via the pane-host's `output` push ->
    // subscribeOutput -> the relay. The poller's remaining jobs are keeping
    // the pipe connected (ensureConnected, above) and self-healing an empty
    // host (above); it no longer captures/diffs render frames.
    void panes
  }
}

// Availability probe used by agents.ts on Windows: where.exe searches
// the daemon's PATH, which under the user-level Scheduled Task includes
// the user's npm global bin. Same contract as the POSIX login-shell
// probe: true/false, or null (fail open) when the probe itself errors.
export function probeBinaryWindows(binary: string): Promise<boolean | null> {
  return new Promise(resolve => {
    execFile('where.exe', [binary], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        const code = (err as any).code
        const cleanMiss = code === 1 && !(err as any).killed
        resolve(cleanMiss ? false : null)
        return
      }
      resolve(String(stdout).trim().length > 0 ? true : null)
    })
  })
}
