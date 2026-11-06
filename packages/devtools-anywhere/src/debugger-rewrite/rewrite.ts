// The Service Worker's rewrite of `debugger` statements in the scripts it serves (see
// service-worker.ts), built into the worker: no DOM code.
import { debuggerStatementSites } from '../cdp-agent/core/lexer';
import { type Plan, type RewriteCache, hashBytes } from './cache';

/**
 * `debugger` (8 characters) becomes a call of the probe's hook (keep the name in sync with the
 * probe), a statement of its own whatever follows on the next line. When the next token is a `;`
 * (past comments and line breaks), the call takes no other one: `if (a) debugger; else …` must stay one statement.
 */
export const DEBUGGER_CALL = '_$dbg();';
export const DEBUGGER_CALL_BEFORE_SEMICOLON = '_$dbg() ';

/** The response's charset label, UTF-8 by default. */
export function charsetOf(type: string): string {
  return /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1]?.toLowerCase() ?? 'utf-8';
}

/** Single-byte charsets with no-break space at 0xA0, like the lexer takes it. */
const SINGLE_BYTE = /^(?:windows-125\d|iso-8859-\d+|iso8859-\d+|latin1|iso-latin-1|l1|cp125\d|us-ascii|ascii)$/;

/**
 * The script as text, and the byte offset of each of its characters; undefined for an encoding
 * this cannot map back to bytes (UTF-16, Shift_JIS and the other multi-byte ones), or a UTF-8
 * script that is not valid UTF-8. A BOM decides the encoding first, as it does for the page.
 */
function decodeScript(
  bytes: Uint8Array,
  charset: string
): { text: string; byteOffset: (index: number) => number } | undefined {
  const utf16Bom = (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe);
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (utf16Bom) return undefined;
  if (utf8Bom || charset === 'utf-8' || charset === 'utf8' || charset === 'unicode-1-1-utf-8') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return undefined;
    }
    const offsets = new Uint32Array(text.length + 1);
    let at = 0;
    for (let i = 0; i < text.length; i++) {
      offsets[i] = at;
      const code = text.charCodeAt(i);
      // A surrogate pair is 4 bytes, counted on its first half.
      if (code < 0x80) at += 1;
      else if (code < 0x800) at += 2;
      else if (code >= 0xd800 && code < 0xdc00) at += 4;
      else if (code >= 0xdc00 && code < 0xe000) at += 0;
      else at += 3;
    }
    offsets[text.length] = at;
    return { text, byteOffset: index => offsets[index] ?? at };
  }
  // One character per byte: the offsets are the byte offsets. Decoded in its own charset, since
  // the letters differ (0xD7 is `Ч` in windows-1251, `×` in latin1); a label this browser does
  // not know is left alone.
  if (!SINGLE_BYTE.test(charset)) return undefined;
  try {
    return { text: new TextDecoder(charset).decode(bytes), byteOffset: index => index };
  } catch {
    return undefined;
  }
}

/** Where the script's `debugger` statements are, in its bytes (see `Plan`); empty when it cannot be decoded. */
export function planOf(bytes: Uint8Array, charset: string): Plan {
  const decoded = decodeScript(bytes, charset);
  if (!decoded) return [];
  const { text, byteOffset } = decoded;
  const plan: number[] = [];
  if (!text.includes('debugger')) return plan;
  for (const { start: offset, semicolon } of debuggerStatementSites(text)) {
    // An escaped keyword is not valid code: only the plain one is replaced.
    if (text.startsWith('debugger', offset)) plan.push(byteOffset(offset) * 2 + (semicolon ? 1 : 0));
  }
  return plan;
}

/** Each site of `plan` is the ASCII `debugger` in `bytes`. */
function fits(bytes: Uint8Array, plan: Plan): boolean {
  for (const site of plan) {
    const at = Math.floor(site / 2);
    for (let i = 0; i < 8; i++) if (bytes[at + i] !== 'debugger'.charCodeAt(i)) return false;
  }
  return true;
}

/** Writes the calls of `plan` over the `debugger` keywords, in place. */
function apply(bytes: Uint8Array, plan: Plan) {
  for (const site of plan) {
    const call = site & 1 ? DEBUGGER_CALL_BEFORE_SEMICOLON : DEBUGGER_CALL;
    const at = Math.floor(site / 2);
    for (let i = 0; i < call.length; i++) bytes[at + i] = call.charCodeAt(i);
  }
}

export interface RewriteOptions {
  /** Plans of the scripts seen before; none to always lex. */
  cache?: RewriteCache | undefined;
  /** The script's URL, which the cache keeps one plan for. */
  url?: string;
  /** Keeps the worker alive for the cache's write after the response went out. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Replaces the `debugger` statements of a JavaScript response with `DEBUGGER_CALL`, in place in
 * its bytes: the replacement is ASCII of the same length, so every other byte stays as it is. A
 * response with nothing to replace is returned as it is.
 *
 * With a cache, a script seen before (same URL, bytes and charset) is not decoded or lexed again:
 * its plan is looked up by the hash of its bytes. Only full 200 responses are remembered; the
 * cache's write is passed to `waitUntil`, so that the response does not wait for it.
 *
 * Scripts are lexed as classic ones, which only differ from modules in taking `<!--` (and `-->`
 * at the start of a line) as comments. The request does not tell the two apart (a classic script
 * with `crossorigin` is a CORS request too), and classic is the safer guess: in a module `<!--`
 * is near impossible (`a <!--b`, a comparison with a negated decrement), while a classic script
 * read as a module would have its HTML-like comments lexed as code.
 */
export async function rewriteDebugger(
  response: Response,
  { cache, url, waitUntil = () => {} }: RewriteOptions = {}
): Promise<Response> {
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !response.body || !/javascript|ecmascript/i.test(type)) return response;
  // Read from a copy, so the original goes to the page untouched when nothing is replaced.
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  const charset = charsetOf(type);
  let plan: Plan | undefined;
  if (cache && url && response.status === 200) {
    const hash = await hashBytes(bytes);
    plan = await cache.get(url, hash, charset);
    // A plan that does not point at \`debugger\` keywords (a broken record) is a miss, and replaced.
    if (plan && !fits(bytes, plan)) plan = undefined;
    if (!plan) {
      plan = planOf(bytes, charset);
      const persist = !/(?:^|,)\s*no-store\b/i.test(response.headers.get('cache-control') || '');
      waitUntil(cache.set(url, hash, charset, plan, persist));
    }
  } else plan = planOf(bytes, charset);
  if (plan.length === 0) return response;
  apply(bytes, plan);
  const headers = new Headers(response.headers);
  // The body is already decoded, and its length is now that of the bytes.
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
}
