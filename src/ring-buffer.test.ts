// Run: npx tsx src/ring-buffer.test.ts
//
// The terminal-output ring buffer: bounded history of VT output chunks,
// replayed into a freshly-attached xterm.js terminal for scrollback. It evicts
// WHOLE chunks from the head (never splits one) so a multi-byte/escape sequence
// is never cut mid-stream.
import { RingBuffer } from './ring-buffer.js'

let fails = 0
const ok = (n: string, c: boolean, d?: string) => {
  console.log((c ? '  ok   ' : 'FAIL   ') + n + (c || d === undefined ? '' : '  => ' + d))
  if (!c) fails++
}

// accumulates chunks in order
const r = new RingBuffer(20)
r.push('abc'); r.push('def')
ok('replay concatenates chunks', r.replay() === 'abcdef', JSON.stringify(r.replay()))

// evicts WHOLE chunks from the head when over cap (never splits a chunk)
const r2 = new RingBuffer(10)
r2.push('aaaaa'); r2.push('bbbbb'); r2.push('ccccc') // 15 > 10 -> drop 'aaaaa'
ok('whole-chunk eviction', r2.replay() === 'bbbbbccccc', JSON.stringify(r2.replay()))

// a single chunk larger than cap is kept whole (last chunk always survives)
const r3 = new RingBuffer(4)
r3.push('xx'); r3.push('yyyyyy')
ok('oversize last chunk kept whole', r3.replay() === 'yyyyyy', JSON.stringify(r3.replay()))

// clear empties it
const r4 = new RingBuffer(10); r4.push('zz'); r4.clear()
ok('clear empties', r4.replay() === '', JSON.stringify(r4.replay()))

// empty / falsy pushes are ignored
const r5 = new RingBuffer(10); r5.push(''); r5.push('q')
ok('empty push ignored', r5.replay() === 'q', JSON.stringify(r5.replay()))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
