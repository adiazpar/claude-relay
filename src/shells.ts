import path from 'path'

// Shell registry for new panes. On macOS/Linux tmux always launches the
// user's default shell, so the registry is a single fixed entry and the
// client never shows a picker. On Windows each pane spawns an explicit
// shell (PowerShell/cmd/Git Bash/WSL distro) — discovery lives in
// win/shells.ts and this module just dispatches.

export interface ClientShell {
  id: string
  name: string
  isDefault: boolean
}

export async function getShellsForClient(): Promise<ClientShell[]> {
  if (process.platform === 'win32') {
    const { getWindowsShellsForClient } = await import('./win/shells.js')
    return getWindowsShellsForClient()
  }
  const shellName = path.basename(process.env.SHELL || 'shell')
  return [{ id: 'default', name: shellName, isDefault: true }]
}
