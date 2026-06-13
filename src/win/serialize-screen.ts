// Flatten an @xterm/headless screen buffer into capture-pane-style text:
// real characters (spaces for blank cells) plus SGR color/attribute
// escapes only - no cursor-motion, erase, alt-screen, or DEC-mode escapes.
//
// This is the Windows analogue of `tmux capture-pane -e -p`. We do NOT use
// @xterm/addon-serialize here: its serialize() emits a *replay stream* that
// optimizes runs of blank cells into ESC[NC cursor-forward jumps (plus
// cursor-home / erase / alt-screen sequences). The web client's renderer
// only understands SGR and silently drops cursor moves, so those ESC[NC
// jumps collapsed inter-word spaces ("can see you" -> "canseeyou"). Reading
// the resolved grid instead yields the same flat text+color the POSIX/tmux
// path produces, so the one shared web renderer paints both identically.
import type { Terminal, IBufferLine, IBufferCell } from '@xterm/headless'

// SGR parameter string for a cell's style (attributes, then fg, then bg),
// excluding the leading reset. '' means default/no styling. Palette and
// truecolor are emitted as 38;5;n / 38;2;r;g;b (and 48;... for bg), which
// the client's ansiToHtml already understands.
function sgrFor(c: IBufferCell): string {
  const codes: number[] = []
  if (c.isBold()) codes.push(1)
  if (c.isDim()) codes.push(2)
  if (c.isItalic()) codes.push(3)
  if (c.isUnderline()) codes.push(4)
  if (c.isInverse()) codes.push(7)
  if (c.isFgRGB()) { const v = c.getFgColor(); codes.push(38, 2, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff) }
  else if (c.isFgPalette()) codes.push(38, 5, c.getFgColor())
  if (c.isBgRGB()) { const v = c.getBgColor(); codes.push(48, 2, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff) }
  else if (c.isBgPalette()) codes.push(48, 5, c.getBgColor())
  return codes.join(';')
}

function serializeLine(line: IBufferLine, cols: number, trimTrailing = true): string {
  let out = ''
  let cur = ''            // SGR currently applied in `out` ('' = default)
  let pendingBlanks = ''  // deferred default-styled blanks
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x)
    if (!c) { pendingBlanks += ' '; continue }
    if (c.getWidth() === 0) continue // spacer cell trailing a wide char (emoji/CJK)
    const key = sgrFor(c)
    const chars = c.getChars()
    if ((chars === '' || chars === ' ') && key === '') { pendingBlanks += ' '; continue }
    // Real (or styled) content: flush the deferred blanks as default-styled
    // spaces first, then emit this cell's style transition and glyph.
    if (pendingBlanks) {
      if (cur !== '') { out += '\x1b[0m'; cur = '' }
      out += pendingBlanks
      pendingBlanks = ''
    }
    if (key !== cur) { out += key === '' ? '\x1b[0m' : `\x1b[0;${key}m`; cur = key }
    out += chars === '' ? ' ' : chars
  }
  // Trailing default blanks are dropped by default (capture-pane trims them).
  // But when this row soft-wraps into the next, keep them so a space sitting
  // on the wrap boundary survives the join.
  if (!trimTrailing && pendingBlanks) {
    if (cur !== '') { out += '\x1b[0m'; cur = '' }
    out += pendingBlanks
  }
  if (cur !== '') out += '\x1b[0m'
  return out
}

// Whole-buffer (scrollback + viewport) capture, oldest line first, joined
// with \n. `maxLines` keeps only the last N lines, matching capturePane.
//
// Soft-wrapped rows are re-joined into their logical line: xterm marks a row
// that continues an auto-wrapped line with `isWrapped`, so we append it to the
// previous output line instead of emitting a newline. That reconstructs the
// logical line and lets the web client word-wrap it at spaces - avoiding the
// terminal's mid-word break at the right edge when an app (Claude/codex/gemini)
// wrapped to a width that differs from the xterm grid.
export function serializeScreen(term: Terminal, maxLines?: number): string {
  const buf = term.buffer.active
  const total = buf.length
  const start = maxLines !== undefined ? Math.max(0, total - maxLines) : 0
  const out: string[] = []
  for (let y = start; y < total; y++) {
    const line = buf.getLine(y)
    if (!line) { out.push(''); continue }
    const next = y + 1 < total ? buf.getLine(y + 1) : null
    const rendered = serializeLine(line, term.cols, !(next && next.isWrapped))
    if (line.isWrapped && out.length > 0) out[out.length - 1] += rendered
    else out.push(rendered)
  }
  return out.join('\n')
}
