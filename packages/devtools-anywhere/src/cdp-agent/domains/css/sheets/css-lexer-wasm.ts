/**
 * The CSS lexer of css-lexer.ts, run as WebAssembly where the page lets it compile, and as the
 * TypeScript lexer elsewhere: same tokens, same result (wasm-gen/lexer.ts).
 *
 * The text is copied into the module's memory: one byte per code unit with `TextEncoder.encodeInto`
 * when it is all ASCII, else code unit by code unit. Short texts stay with the TypeScript lexer,
 * which is faster for them than the copies and the call are.
 */
import { tokenize as tokenizeTs, type Tokens } from './css-lexer';
import { LEXER_WASM } from './css-lexer-wasm-bytes';

export { Tok, type TokKind, type Tokens } from './css-lexer';

/** Where the text starts in the module's memory (wasm-gen/lexer.ts). */
const IN = 0x20000;
/** Code units of 0 the module expects after the text. */
const PAD = 4;
/** Code units `copyIn` encodes as bytes at a time (16 KB: a few microseconds of encodeInto). */
const CHUNK = 0x4000;
/** Texts shorter than this go to the TypeScript lexer: about where the two take as long (bench/README.md). */
export const WASM_MIN_LENGTH = 64;

export interface Exports {
  m: WebAssembly.Memory;
  lex16(length: number, kinds: number, starts: number): number;
  lex8(length: number, kinds: number, starts: number): number;
}

/** The module's exports; null once compiling it has failed, as under a CSP without `wasm-unsafe-eval`. */
let wasm: Exports | null | undefined;
let encoder: TextEncoder | undefined;

function load(): Exports | null {
  try {
    const bin = atob(LEXER_WASM);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // Synchronous, as `tokenize` is: the module is far under the main thread's size limit.
    return new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as unknown as Exports;
  } catch {
    return null;
  }
}

/** Whether `tokenize` uses WebAssembly for a long enough text; compiles the module the first time. */
export function wasmAvailable(): boolean {
  if (wasm === undefined) wasm = typeof WebAssembly === 'object' ? load() : null;
  return wasm !== null;
}

/** Tokenizes `text`, as css-lexer.ts's `tokenize` does. */
export function tokenize(text: string): Tokens {
  const len = text.length;
  if (len < WASM_MIN_LENGTH || !wasmAvailable()) return tokenizeTs(text);
  return tokenizeWasm(wasm as Exports, text);
}

/** Tokenizes `text` with the module whatever its length. Exported for the tests and benchmarks. */
export function tokenizeWasm(w: Exports, text: string): Tokens {
  const at = copyIn(w, text);
  return copyOut(w, at, lex(w, at));
}

/** Where `copyIn` put the text and where the module is to write its tokens. */
export interface Layout {
  len: number;
  /** One byte per code unit (`lex8`), else UTF-16 (`lex16`). */
  narrow: boolean;
  kindsAt: number;
  startsAt: number;
}

/**
 * Copies `text` into the module's memory, as bytes when it is all ASCII, unless `wide`. The
 * stages are exported apart for the benchmarks, to time each.
 */
export function copyIn(w: Exports, text: string, wide = false): Layout {
  const len = text.length;
  // Room for the text as UTF-16; as bytes it takes half of that.
  const kindsAt = IN + 2 * (len + PAD);
  const startsAt = (kindsAt + len + 3) & ~3;
  const need = startsAt + 4 * (len + 1);
  const have = w.m.buffer.byteLength;
  if (need > have) w.m.grow(Math.ceil((need - have) / 0x10000));
  const buf = w.m.buffer;
  const u16 = new Uint16Array(buf, IN, len + PAD);
  // The code units before `from` are in place as UTF-16.
  let from = 0;
  if (!wide) {
    const u8 = new Uint8Array(buf, IN, len + PAD);
    encoder ??= new TextEncoder();
    // In chunks, so that a code unit past ASCII stops the bytes after one chunk at most, not after
    // encoding the whole text in vain.
    let at = 0;
    for (; at < len; at += CHUNK) {
      const end = Math.min(at + CHUNK, len);
      const { read, written } = encoder.encodeInto(
        at === 0 && end === len ? text : text.slice(at, end),
        u8.subarray(at, end)
      );
      if (read !== end - at || written !== end - at) break;
    }
    if (at >= len) {
      u8.fill(0, len);
      return { len, narrow: true, kindsAt, startsAt };
    }
    // The chunks before are ASCII: widened in place, from the last code unit (whose two bytes lie
    // at or past its byte) down, so that no byte is overwritten before it is read.
    for (let i = at - 1; i >= 0; i--) u16[i] = u8[i] as number;
    from = at;
  }
  for (let i = from; i < len; i++) u16[i] = text.charCodeAt(i);
  u16.fill(0, len);
  return { len, narrow: false, kindsAt, startsAt };
}

/** Runs the module on the text `copyIn` put in; returns the number of tokens. */
export const lex = (w: Exports, at: Layout): number => (at.narrow ? w.lex8 : w.lex16)(at.len, at.kindsAt, at.startsAt);

/** Copies the `n` tokens out of the module's memory. */
export function copyOut(w: Exports, at: Layout, n: number): Tokens {
  const buf = w.m.buffer;
  return {
    kinds: new Uint8Array(buf.slice(at.kindsAt, at.kindsAt + n)) as Tokens['kinds'],
    starts: new Uint32Array(buf.slice(at.startsAt, at.startsAt + 4 * (n + 1))),
  };
}

/** The module's exports, compiling it if need be; null where it cannot compile. */
export function wasmExports(): Exports | null {
  wasmAvailable();
  return wasm ?? null;
}
