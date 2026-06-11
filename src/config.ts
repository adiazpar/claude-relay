// Runtime configuration, parsed from argv flags.
//
// The port and session name deliberately arrive as --port / --session
// CLI arguments rather than env vars. PORT in particular is a generic
// namespace honored by nearly every Node dev server (Next.js, Vite,
// Express apps), so a PORT value leaking into any shell caused
// unrelated dev servers to collide with the relay. Argv is private to
// this process — nothing else can consume or contaminate it.

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

export const DEFAULT_PORT = 7337

const portRaw = argValue('--port') ?? String(DEFAULT_PORT)
export const PORT = Number(portRaw)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid --port: ${JSON.stringify(portRaw)}. Expected an integer 1-65535.`)
  process.exit(1)
}

export const TMUX_SESSION = argValue('--session') || 'dev'
