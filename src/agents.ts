import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// An agent is any AI coding CLI that runs as a TUI inside a tmux pane.
// The relay's job is the same for all of them: launch via a shell command,
// detect that it's running, and pipe text/keys at it. Everything
// agent-specific lives in these definitions.
export interface AgentDefinition {
  id: string             // stable identifier, e.g. "claude"
  name: string           // display name shown in the UI, e.g. "Claude"
  command: string        // shell command typed into the pane to launch it
  binary: string         // executable name matched against the pane's process tree
  // Claude Code overrides process.title to its version string ("2.1.114"),
  // so tmux reports the version as pane_current_command and ps shows it in
  // place of the binary name. Agents with this quirk claim panes whose
  // foreground command looks like a bare semver.
  versionTitle?: boolean
  // Key (tmux KEY_MAP name) that cycles the agent's permission/approval
  // mode. Drives the "Change mode" button; omit if the agent has none.
  modeCycleKey?: string
  // Whether typing absolute image paths into the agent's input attaches
  // them (Claude Code auto-detects pasted paths). Drives the paperclip.
  imageAttach?: boolean
  // Milliseconds to wait between typing a message body and the Enter that
  // submits it (the bridges type the body, settle, then send a separate CR).
  // Codex's TUI arms a ~120ms paste-burst window in which an Enter is buffered
  // as a literal newline instead of submitting, so it needs a gap wider than
  // that; Ink-based agents (Claude) have no such window and use the smaller
  // default. Omit to use DEFAULT_SUBMIT_DELAY_MS.
  submitDelayMs?: number
}

// Keys allowed for modeCycleKey. Must stay a subset of TmuxBridge.KEY_MAP —
// the server-side key whitelist is the real enforcement; this just keeps
// config typos from silently producing a dead button.
const ALLOWED_MODE_KEYS = new Set(['S-Tab', 'Tab', 'Escape'])

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'claude',
    name: 'Claude',
    command: 'claude --dangerously-skip-permissions',
    binary: 'claude',
    versionTitle: true,
    modeCycleKey: 'S-Tab',
    imageAttach: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex --dangerously-bypass-approvals-and-sandbox',
    binary: 'codex',
    // Codex (Rust/ratatui) buffers an Enter as a literal newline for ~120ms
    // after a paste-like input burst (paste_burst.rs PASTE_ENTER_SUPPRESS_WINDOW);
    // a single body write lands all bytes in one read, arming that window, so the
    // default 50ms Enter is swallowed. 150ms clears it so the message submits.
    submitDelayMs: 150,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    command: 'gemini --yolo',
    binary: 'gemini',
  },
]

// Optional user config at the repo root (gitignored). Lets users add any
// CLI-launchable agent — aider, opencode, a wrapper script around a local
// model — or override a built-in (e.g. drop Claude's skip-permissions
// flag) by reusing its id. Shape:
//   { "agents": [{ "id": "aider", "name": "Aider",
//                  "command": "aider --model ollama/qwen3-coder" }] }
const CONFIG_PATH = path.join(__dirname, '..', 'agents.local.json')

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
const BINARY_PATTERN = /^[A-Za-z0-9._\/-]+$/

function sanitizeEntry(raw: unknown, existing: AgentDefinition | undefined): AgentDefinition | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const id = typeof r.id === 'string' && ID_PATTERN.test(r.id) ? r.id : null
  if (!id) {
    console.error('agents.local.json: skipping entry with missing/invalid id:', JSON.stringify(r.id))
    return null
  }

  const command = typeof r.command === 'string' && r.command.trim().length > 0 && r.command.length <= 500
    ? r.command.trim()
    : existing?.command
  if (!command) {
    console.error(`agents.local.json: agent "${id}" has no command; skipping`)
    return null
  }

  // Default the binary to the basename of the command's first word, so
  // simple entries only need id/name/command.
  const inferredBinary = command.split(/\s+/)[0].split('/').pop() || ''
  const binaryRaw = typeof r.binary === 'string' ? r.binary : (existing?.binary ?? inferredBinary)
  if (!BINARY_PATTERN.test(binaryRaw)) {
    console.error(`agents.local.json: agent "${id}" has invalid binary "${binaryRaw}"; skipping`)
    return null
  }

  let modeCycleKey = existing?.modeCycleKey
  if (typeof r.modeCycleKey === 'string') {
    if (ALLOWED_MODE_KEYS.has(r.modeCycleKey)) {
      modeCycleKey = r.modeCycleKey
    } else {
      console.error(`agents.local.json: agent "${id}" modeCycleKey "${r.modeCycleKey}" not allowed; ignoring`)
    }
  } else if (r.modeCycleKey === null) {
    modeCycleKey = undefined
  }

  return {
    id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : (existing?.name ?? id),
    command,
    binary: binaryRaw,
    versionTitle: typeof r.versionTitle === 'boolean' ? r.versionTitle : existing?.versionTitle,
    modeCycleKey,
    imageAttach: typeof r.imageAttach === 'boolean' ? r.imageAttach : existing?.imageAttach,
    submitDelayMs: typeof r.submitDelayMs === 'number' && Number.isFinite(r.submitDelayMs)
      && r.submitDelayMs >= 0 && r.submitDelayMs <= 5000
      ? r.submitDelayMs
      : existing?.submitDelayMs,
  }
}

function loadAgents(): AgentDefinition[] {
  const agents = [...BUILTIN_AGENTS]
  const customIds = new Set<string>()
  let rawText: string
  try {
    rawText = fs.readFileSync(CONFIG_PATH, 'utf-8')
  } catch {
    return agents // no config file — built-ins only
  }
  try {
    const parsed = JSON.parse(rawText)
    const entries = Array.isArray(parsed?.agents) ? parsed.agents : []
    for (const raw of entries) {
      const existingIdx = agents.findIndex(a => a.id === (raw as any)?.id)
      const entry = sanitizeEntry(raw, existingIdx >= 0 ? agents[existingIdx] : undefined)
      if (!entry) continue
      customIds.add(entry.id)
      if (existingIdx >= 0) {
        agents[existingIdx] = entry
      } else {
        agents.push(entry)
      }
    }
  } catch (err) {
    console.error('agents.local.json: failed to parse, using built-in agents only:', err)
  }
  configuredIds = customIds
  return agents
}

// Ids that came from the user's config file. These are always offered in
// the UI even if the availability probe can't find the binary — the user
// asked for them explicitly, and a wrong "missing" verdict (exotic shell
// init, PATH set only in .zshrc, etc.) would hide their agent.
let configuredIds = new Set<string>()

const AGENTS: AgentDefinition[] = loadAgents()

export function getAgents(): AgentDefinition[] {
  return AGENTS
}

export function getAgent(id: string): AgentDefinition | undefined {
  return AGENTS.find(a => a.id === id)
}

// Default gap between typing a message body and its submitting Enter, used by
// both bridges' submit split. Agents override via submitDelayMs.
export const DEFAULT_SUBMIT_DELAY_MS = 50

export function getSubmitDelayMs(agentId: string | null | undefined): number {
  const agent = agentId ? getAgent(agentId) : undefined
  return agent?.submitDelayMs ?? DEFAULT_SUBMIT_DELAY_MS
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------
// The daemon runs under launchd/systemd with a minimal PATH, but launch
// commands are typed into the user's interactive tmux shell, which has the
// user's full PATH. So availability is probed through the user's login
// shell, not the daemon's own env. Results: true/false, or null when the
// probe itself failed (timeout, weird shell) — null fails open and the
// agent is offered anyway; a genuinely missing binary just shows
// "command not found" in the pane, which is self-explanatory.
const PROBE_TIMEOUT_MS = 5000
const PROBE_TTL_MS = 30_000

let availabilityCache: Map<string, boolean | null> | null = null
let availabilityFetchedAt = 0
let availabilityInFlight: Promise<Map<string, boolean | null>> | null = null

function probeBinary(shell: string, binary: string): Promise<boolean | null> {
  return new Promise(resolve => {
    // -l so login-shell PATH setup runs; -i so rc files that only run for
    // interactive shells (where nvm/asdf often live) run too. A shell that
    // chokes on -i resolves to null via the error path.
    execFile(shell, ['-ilc', `command -v -- ${binary}`], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        // Exit code 1 from `command -v` means a clean "not found"; any
        // other failure (timeout, signal, bad shell flags) is unknown.
        const cleanMiss = typeof (err as any).code === 'number' && (err as any).code === 1 && !(err as any).killed
        resolve(cleanMiss ? false : null)
        return
      }
      resolve(stdout.trim().length > 0 ? true : null)
    })
  })
}

async function probeAvailability(): Promise<Map<string, boolean | null>> {
  // Windows has no login-shell convention; where.exe against the
  // daemon's PATH (the user PATH under a user-level Scheduled Task,
  // including the npm global bin) is the equivalent probe.
  if (process.platform === 'win32') {
    const { probeBinaryWindows } = await import('./win/bridge.js')
    const results = await Promise.all(
      AGENTS.map(async agent => [agent.id, await probeBinaryWindows(agent.binary)] as const)
    )
    return new Map(results)
  }
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  const results = await Promise.all(
    AGENTS.map(async agent => [agent.id, await probeBinary(shell, agent.binary)] as const)
  )
  return new Map(results)
}

export async function getAgentAvailability(): Promise<Map<string, boolean | null>> {
  const now = Date.now()
  if (availabilityCache && now - availabilityFetchedAt < PROBE_TTL_MS) {
    return availabilityCache
  }
  if (!availabilityInFlight) {
    availabilityInFlight = probeAvailability()
      .then(map => {
        availabilityCache = map
        availabilityFetchedAt = Date.now()
        return map
      })
      .finally(() => { availabilityInFlight = null })
  }
  return availabilityInFlight
}

// The list shipped to the phone UI: built-ins that probed as definitively
// missing are dropped; everything else (present, unknown, or explicitly
// configured) is offered.
export async function getAgentsForClient(): Promise<Array<{
  id: string
  name: string
  command: string
  modeCycleKey: string | null
  imageAttach: boolean
  available: boolean | null
}>> {
  const availability = await getAgentAvailability()
  return AGENTS
    .filter(agent => {
      const available = availability.get(agent.id) ?? null
      return available !== false || configuredIds.has(agent.id)
    })
    .map(agent => ({
      id: agent.id,
      name: agent.name,
      command: agent.command,
      modeCycleKey: agent.modeCycleKey ?? null,
      imageAttach: agent.imageAttach === true,
      available: availability.get(agent.id) ?? null,
    }))
}
