import type { Protocol } from 'devtools-protocol'

const V8_FRAME = /^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/
const GECKO_FRAME = /^(.*?)@(.*?):(\d+):(\d+)$/

/**
 * Parses an `Error().stack` string into CDP call frames (0-based lines and columns).
 * `skip` drops that many frames from the top, e.g. the console wrapper itself.
 */
export function parseStack(stack: string | undefined, skip = 0): Protocol.Runtime.CallFrame[] {
  if (!stack) return []
  const frames: Protocol.Runtime.CallFrame[] = []
  for (const line of stack.split('\n')) {
    const m = V8_FRAME.exec(line) || GECKO_FRAME.exec(line.trim())
    if (!m) continue
    frames.push({
      functionName: (m[1] || '').replace(/^async /, ''),
      scriptId: '',
      url: m[2],
      lineNumber: Number(m[3]) - 1,
      columnNumber: Number(m[4]) - 1,
    })
  }
  return frames.slice(skip)
}
