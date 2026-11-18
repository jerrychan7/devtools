import type { Protocol } from 'devtools-protocol';

const V8_FRAME = /^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/;
const GECKO_FRAME = /^(.*?)@(.*?):(\d+):(\d+)$/;

/**
 * Parses an `Error().stack` string into CDP call frames (0-based lines and columns).
 * `skip` drops that many frames from the top, e.g. the console wrapper itself. `scriptIdOf` gives the id
 * of the script at a frame's URL: {@link stackOf} looks it up in core/scripts.ts.
 */
export function parseStack(
  stack: string | undefined,
  scriptIdOf: (url: string) => string,
  skip = 0
): Protocol.Runtime.CallFrame[] {
  if (!stack) return [];
  const frames: Protocol.Runtime.CallFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = V8_FRAME.exec(line) || GECKO_FRAME.exec(line.trim());
    if (!m) continue;
    const raw = m[2] ?? '';
    // Code run by eval has no URL in CDP: V8 writes `eval at f (url:1:2), <anonymous>`,
    // Firefox `url line 2 > eval`.
    const url = /^eval at |> eval$|> Function$/.test(raw) ? '' : raw;
    frames.push({
      // V8 names constructors without `new`, Firefox marks async frames with `async*`, and
      // Safari names top-level code `global code`: CDP gives the bare name, or none.
      functionName: (m[1] || '').replace(/^(?:async |new |async\*)/, '').replace(/^global code$/, ''),
      // Never '': the frontend asserts that a location has a script id.
      scriptId: scriptIdOf(url),
      url,
      lineNumber: Number(m[3]) - 1,
      columnNumber: Number(m[4]) - 1,
    });
  }
  return frames.slice(skip);
}
