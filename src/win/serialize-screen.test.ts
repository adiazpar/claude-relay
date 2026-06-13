// Run: npx tsx src/win/serialize-screen.test.ts
//
// Verifies serializeScreen() emits tmux capture-pane-style flat text+SGR:
// blank gaps are REAL spaces (not ESC[NC cursor jumps), styling is SGR
// only, and no cursor-motion / erase escapes leak into the output. This
// is the Windows analogue of `tmux capture-pane -e -p` and feeds the same
// web renderer the POSIX path uses.
import xtermHeadless from '@xterm/headless'
import { serializeScreen } from './serialize-screen.js'

const { Terminal } = xtermHeadless

let failures = 0
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ok   ${name}`) }
  else { failures++; console.log(`FAIL   ${name}${detail !== undefined ? '  =>  ' + detail : ''}`) }
}
const stripSgr = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
function noCursorEscapes(s: string): boolean {
  // Every CSI must be an SGR (final byte 'm'); any other final letter is a
  // cursor-move / erase op the web renderer can't paint.
  const csi = /\x1b\[[0-9;?]*([A-Za-z])/g
  let m: RegExpExecArray | null
  while ((m = csi.exec(s))) { if (m[1] !== 'm') return false }
  return true
}
function render(input: string, cols = 40, rows = 10): Promise<string> {
  return new Promise(resolve => {
    const term = new Terminal({ cols, rows, allowProposedApi: true })
    term.write(input, () => resolve(serializeScreen(term)))
  })
}
const line0 = (s: string): string => s.split('\n')[0]

async function main(): Promise<void> {
  // 1. Cursor-forward (the actual bug) becomes real spaces.
  const cuf = await render('A\x1b[3CB')
  assert('CUF -> real spaces', line0(cuf) === 'A   B', JSON.stringify(line0(cuf)))
  assert('no cursor escapes leak (CUF)', noCursorEscapes(cuf))

  // 2. Truecolor styling preserved AND the space at a style boundary survives
  //    (the exact failure in the screenshot: "claude-relay project").
  const colored = await render('\x1b[38;2;177;185;249mclaude-relay\x1b[0m project')
  assert('space survives style boundary', stripSgr(line0(colored)) === 'claude-relay project', JSON.stringify(stripSgr(line0(colored))))
  assert('truecolor fg emitted', line0(colored).includes('\x1b[0;38;2;177;185;249m'), JSON.stringify(line0(colored)))
  assert('reset then literal space', line0(colored).includes('\x1b[0m project'), JSON.stringify(line0(colored)))
  assert('no cursor escapes leak (color)', noCursorEscapes(colored))

  // 3. Trailing blank cells trimmed (like serialize/tmux).
  assert('trailing blanks trimmed', line0(await render('hi')) === 'hi')

  // 4. Wide char / emoji kept once; the width-0 spacer cell adds no phantom space.
  const wide = await render('a\u{1F44B}b')
  assert('wide char kept once', stripSgr(line0(wide)) === 'a\u{1F44B}b', JSON.stringify(stripSgr(line0(wide))))

  // 5. Bold + 16-color fg re-encoded as attrs + palette.
  const bold = await render('\x1b[1;31mX\x1b[0m')
  assert('bold+palette text', stripSgr(line0(bold)) === 'X')
  assert('bold + red palette encoded', line0(bold).includes('\x1b[0;1;38;5;1m'), JSON.stringify(line0(bold)))

  // 6. Soft-wrapped rows are joined into one logical line, so the web
  //    client word-wraps the whole line at spaces instead of showing the
  //    terminal's mid-word break at the right edge (the screenshot bug).
  const wrapped = await render('abcdefghijklmno', 10, 6)
  assert('wrapped rows joined', line0(wrapped) === 'abcdefghijklmno', JSON.stringify(line0(wrapped)))

  // 7. A space sitting on the wrap boundary is preserved across the join.
  const wrapSpace = await render('abcdefghi jklmno', 10, 6)
  assert('wrap-boundary space preserved', line0(wrapSpace) === 'abcdefghi jklmno', JSON.stringify(line0(wrapSpace)))

  // 8. A genuine hard newline still starts a new line (not joined).
  const hard = await render('aaa\r\nbbb', 10, 6)
  assert('hard newline not joined', hard.split('\n')[0] === 'aaa' && hard.split('\n')[1] === 'bbb', JSON.stringify(hard.split('\n').slice(0, 2)))

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
