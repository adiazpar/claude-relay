// Wire protocol between the relay (WinBridge client) and the pane-host
// daemon. NDJSON over a named pipe: one JSON object per line.
//
//   request:  { rid, method, params }
//   response: { rid, ok: true, result } | { rid, ok: false, error }
//
// The pane-host is deliberately dumb: it spawns exactly the argv the
// relay hands it and knows nothing about shells, agents, or detection.
// That's what makes it safe to leave running across relay updates —
// panes survive `relay restart` because only the client side restarts.

export const PROTOCOL_VERSION = 1

// Username- and session-scoped so concurrent users (fast user switching)
// and multi-instance setups (second relay on another port with its own
// --session) never collide on the pipe.
export function paneHostPipePath(session: string): string {
  const user = (process.env.USERNAME || process.env.USER || 'user').replace(/[^A-Za-z0-9_-]/g, '_')
  const sess = session.replace(/[^A-Za-z0-9_-]/g, '_')
  return `\\\\.\\pipe\\claude-relay-panehost-${user}-${sess}`
}

export interface HostPane {
  id: string         // "w3" — stable for the pane's lifetime
  index: number      // creation order, also the suffix in target
  pid: number        // pid of the spawned shell process
  shellId: string    // registry id the relay resolved at create time
  shellKind: string  // 'powershell' | 'cmd' | 'gitbash' | 'wsl'
  cwd: string        // spawn cwd (Windows has no cheap live-cwd query)
  cols: number
  rows: number
  seq: number        // bumped on every PTY output chunk; poll dirty-check
  meta: Record<string, string> // opaque relay data (e.g. WSL marker token)
}

export interface CreateParams {
  file: string       // executable to spawn
  args: string[]
  cwd: string
  cols: number
  rows: number
  shellId: string
  shellKind: string
  meta?: Record<string, string>
}

export interface HelloResult {
  version: number
  session: string
  // Random id minted at pane-host boot. A changed bootId tells the
  // relay this is a fresh host (old one died → panes are gone), which
  // maps onto the tmux 'sessionRecreated' self-heal contract.
  bootId: string
}

export type HostRequest =
  | { rid: number; method: 'hello'; params: {} }
  | { rid: number; method: 'list'; params: {} }
  | { rid: number; method: 'create'; params: CreateParams }
  | { rid: number; method: 'kill'; params: { id: string } }
  | { rid: number; method: 'write'; params: { id: string; data: string } }
  | { rid: number; method: 'resize'; params: { id: string; cols: number; rows: number } }
  | { rid: number; method: 'capture'; params: { id: string; lines?: number } }
  | { rid: number; method: 'clearScrollback'; params: { id: string } }

export type HostResponse =
  | { rid: number; ok: true; result: unknown }
  | { rid: number; ok: false; error: string }
