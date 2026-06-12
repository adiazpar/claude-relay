// Windows shell discovery. Each pane on Windows spawns an explicit
// shell; this registry enumerates what's installed: PowerShell 7
// (pwsh), Windows PowerShell 5.1, cmd, Git Bash, and one entry per WSL
// distro. Results are cached for 30s (same TTL philosophy as agent
// availability probing).

import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ClientShell } from '../shells.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export type ShellKind = 'powershell' | 'cmd' | 'gitbash' | 'wsl'

export interface ShellSpec {
  id: string
  name: string
  kind: ShellKind
  file: string
  args: string[]
  distro?: string // wsl only
}

const CACHE_TTL_MS = 30_000
let cache: ShellSpec[] | null = null
let cacheAt = 0
let inFlight: Promise<ShellSpec[]> | null = null

// Marker WinBridge substitutes with the pane's detection token at
// create time. The token lands in a /tmp marker file inside the distro,
// which is what lets the WSL detection pass map Linux processes back to
// a specific pane (a WSL pane is just wsl.exe from the Windows side).
export const WSL_TOKEN_PLACEHOLDER = '__RELAY_PANE_TOKEN__'

function fileExists(p: string): boolean {
  try { return fs.existsSync(p) } catch { return false }
}

function execFileText(file: string, args: string[], timeoutMs = 5000): Promise<Buffer | null> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'buffer', windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

async function whereFirst(binary: string): Promise<string | null> {
  const out = await execFileText('where.exe', [binary])
  if (!out) return null
  const first = out.toString('utf-8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0]
  return first || null
}

function systemRoot(): string {
  return process.env.SystemRoot || 'C:\\Windows'
}

async function findPwsh(): Promise<string | null> {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
  ]
  for (const c of candidates) if (fileExists(c)) return c
  return whereFirst('pwsh')
}

function windowsPowershellPath(): string {
  return path.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function cmdPath(): string {
  return process.env.ComSpec || path.join(systemRoot(), 'System32', 'cmd.exe')
}

// Git Bash lives in <gitroot>\bin\bash.exe. Hunt order: registry
// (HKLM machine-wide, HKCU user installs), conventional paths
// (Program Files, per-user, scoop), then derive from `where git`
// (<gitroot>\cmd\git.exe or <gitroot>\mingw64\bin\git.exe).
async function findGitBash(): Promise<string | null> {
  for (const hive of ['HKLM', 'HKCU']) {
    const out = await execFileText('reg.exe', ['query', `${hive}\\SOFTWARE\\GitForWindows`, '/v', 'InstallPath'])
    if (out) {
      const m = out.toString('utf-8').match(/InstallPath\s+REG_SZ\s+(.+)/)
      if (m) {
        const bash = path.join(m[1].trim(), 'bin', 'bash.exe')
        if (fileExists(bash)) return bash
      }
    }
  }

  const home = process.env.USERPROFILE || ''
  const conventional = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Git', 'bin', 'bash.exe'),
    home ? path.join(home, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe') : '',
  ].filter(Boolean)
  for (const c of conventional) if (fileExists(c)) return c

  const git = await whereFirst('git')
  if (git) {
    // <root>\cmd\git.exe or <root>\mingw64\bin\git.exe → <root>\bin\bash.exe
    for (const up of [1, 2]) {
      let root = path.dirname(git)
      for (let i = 0; i < up; i++) root = path.dirname(root)
      const bash = path.join(root, 'bin', 'bash.exe')
      if (fileExists(bash)) return bash
    }
  }
  return null
}

// `wsl.exe -l -q` prints one distro per line — in UTF-16LE. Decoding it
// as UTF-8 yields NUL-interleaved garbage, so decode explicitly.
// Docker Desktop's plumbing distros aren't user shells; filter them.
async function listWslDistros(): Promise<string[]> {
  const out = await execFileText('wsl.exe', ['-l', '-q'])
  if (!out) return []
  return out.toString('utf16le')
    .split(/\r?\n/)
    .map(s => s.replace(/\0/g, '').trim())
    .filter(Boolean)
    .filter(name => !/^docker-desktop/i.test(name))
}

async function discover(): Promise<ShellSpec[]> {
  const shells: ShellSpec[] = []

  const pwsh = await findPwsh()
  if (pwsh) {
    shells.push({ id: 'pwsh', name: 'PowerShell', kind: 'powershell', file: pwsh, args: ['-NoLogo'] })
  }

  const winPs = windowsPowershellPath()
  if (fileExists(winPs)) {
    shells.push({ id: 'powershell', name: pwsh ? 'Windows PowerShell' : 'PowerShell', kind: 'powershell', file: winPs, args: ['-NoLogo'] })
  }

  const cmd = cmdPath()
  if (fileExists(cmd)) {
    shells.push({ id: 'cmd', name: 'Command Prompt', kind: 'cmd', file: cmd, args: [] })
  }

  const gitBash = await findGitBash()
  if (gitBash) {
    shells.push({ id: 'git-bash', name: 'Git Bash', kind: 'gitbash', file: gitBash, args: ['--login', '-i'] })
  }

  for (const distro of await listWslDistros()) {
    shells.push({
      id: `wsl:${distro}`,
      name: `WSL (${distro})`,
      kind: 'wsl',
      file: path.join(systemRoot(), 'System32', 'wsl.exe'),
      distro,
      // The marker file maps this pane's processes back to it during the
      // WSL detection pass. exec replaces sh with the user's login shell
      // so the pane behaves like a normal WSL terminal.
      args: [
        '-d', distro, '--cd', '~', '-e', 'sh', '-c',
        `echo $$ > /tmp/.claude-relay-pane-${WSL_TOKEN_PLACEHOLDER}; exec \${SHELL:-bash} -l`
      ]
    })
  }

  return shells
}

export async function getShellSpecs(): Promise<ShellSpec[]> {
  const now = Date.now()
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache
  if (!inFlight) {
    inFlight = discover()
      .then(specs => {
        cache = specs
        cacheAt = Date.now()
        return specs
      })
      .finally(() => { inFlight = null })
  }
  return inFlight
}

// Optional user override at the repo root (gitignored, same philosophy
// as agents.local.json): { "defaultShell": "git-bash" }
function configuredDefaultShell(): string | null {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'relay.local.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    return typeof parsed?.defaultShell === 'string' ? parsed.defaultShell : null
  } catch {
    return null
  }
}

export async function getDefaultShell(): Promise<ShellSpec | null> {
  const specs = await getShellSpecs()
  if (specs.length === 0) return null
  const configured = configuredDefaultShell()
  if (configured) {
    const match = specs.find(s => s.id === configured)
    if (match) return match
    console.error(`relay.local.json: defaultShell "${configured}" not found; using fallback`)
  }
  return specs.find(s => s.id === 'pwsh') || specs.find(s => s.id === 'powershell') || specs[0]
}

export async function getShellSpec(id: string): Promise<ShellSpec | null> {
  const specs = await getShellSpecs()
  return specs.find(s => s.id === id) || null
}

export async function getWindowsShellsForClient(): Promise<ClientShell[]> {
  const specs = await getShellSpecs()
  const def = await getDefaultShell()
  return specs.map(s => ({ id: s.id, name: s.name, isDefault: s.id === def?.id }))
}
