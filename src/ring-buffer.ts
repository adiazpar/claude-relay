// Bounded history of VT output chunks for a single pane. Both bridges push the
// live terminal stream here; the relay replays it into a freshly-attached
// xterm.js terminal so a client that connects or switches tabs sees scrollback.
//
// Eviction is by WHOLE chunk from the head: when the byte total exceeds `cap`
// we drop oldest chunks entirely rather than slicing one, so a multi-byte UTF-8
// char or an escape sequence is never cut mid-stream. The most recent chunk is
// always retained even if it alone exceeds the cap.
export class RingBuffer {
  private chunks: string[] = []
  private size = 0

  constructor(private readonly cap: number) {}

  push(data: string): void {
    if (!data) return
    this.chunks.push(data)
    this.size += data.length
    while (this.chunks.length > 1 && this.size > this.cap) {
      this.size -= this.chunks.shift()!.length
    }
  }

  replay(): string {
    return this.chunks.join('')
  }

  clear(): void {
    this.chunks = []
    this.size = 0
  }
}
