import { SessionBridge } from './bridge.js'

// Platform dispatch. Dynamic imports keep each platform's backend (and
// its dependencies — node-pty types, tmux assumptions) out of the other
// platform's module graph.
let instance: SessionBridge
if (process.platform === 'win32') {
  const { WinBridge } = await import('./win/bridge.js')
  instance = new WinBridge()
} else {
  const { TmuxBridge } = await import('./tmux-bridge.js')
  instance = new TmuxBridge()
}

export const bridge = instance
