/**
 * The CSS lexer of css-lexer.ts, run as WebAssembly where the page lets it compile, and as the
 * TypeScript lexer elsewhere: same tokens, same result (wasm-gen/lexer.ts). The module also
 * outlines (css-outline-wasm.ts); `tokenize` asks it to lex only.
 *
 * The text is copied into the module's memory: one byte per code unit with `TextEncoder.encodeInto`
 * when it is all ASCII, else code unit by code unit. Short texts stay with the TypeScript lexer,
 * which is faster for them than the copies and the call are.
 */
import { tokenize as tokenizeTs, type Tokens } from './css-lexer';
import { CSS_WASM } from './css-wasm-bytes';

export { Tok, type TokKind, type Tokens } from './css-lexer';

/** Where the text starts in the module's memory (wasm-gen/lexer.ts). */
const IN = 0x20000;
/** Code units of 0 the module expects after the text. */
const PAD = 4;
/** Code units `copyIn` encodes as bytes at a time (16 KB: a few microseconds of encodeInto). */
const CHUNK = 0x4000;
/** Texts shorter than this go to the TypeScript lexer: about where the two take as long (bench/README.md). */
export const WASM_MIN_LENGTH = 64;

/** `run`'s flag to lex only, returning the number of tokens (wasm-gen/outline.ts). */
export const LEX_ONLY = 1;

export interface Exports {
  m: WebAssembly.Memory;
  /**
   * Lexes the text `copyIn` put in, as UTF-16 when `wide`; with LEX_ONLY, returns the number of
   * tokens, else outlines them and returns the number of rules (css-outline-wasm.ts).
   */
  run(length: number, wide: number, kinds: number, starts: number, flags: number): number;
  /** Where the outline's rule and declaration tables are, and how many declarations. */
  rb(): number;
  db(): number;
  dc(): number;
}

/** The module's exports; null once compiling it has failed, as under a CSP without `wasm-unsafe-eval`. */
let wasm: Exports | null | undefined;
/** The compiled module, for an instance of a large text's own. */
let compiled: WebAssembly.Module | undefined;
let encoder: TextEncoder | undefined;

/**
 * Texts of this many code units or more (5 Mi) are lexed or outlined by an instance of their own,
 * dropped after: a module's memory grows to fit the longest text (7 bytes per code unit to lex,
 * about 11 to outline) and never shrinks, so the shared instance keeps at most what a text under
 * this takes, about 35 MB to lex and 60 MB to outline, for the page's life. Each such text pays
 * for an instance (its memory and tables set up) and nothing else.
 */
export const OWN_INSTANCE_LENGTH = 5 * 1024 * 1024;

function load(): Exports | null {
  try {
    const bin = atob(CSS_WASM);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // Synchronous, as `tokenize` is: the module is far under the main thread's size limit.
    compiled = new WebAssembly.Module(bytes);
    return instantiate(compiled);
  } catch {
    return null;
  }
}

const instantiate = (module: WebAssembly.Module) => new WebAssembly.Instance(module).exports as unknown as Exports;

/** Whether `tokenize` uses WebAssembly for a long enough text; compiles the module the first time. */
export function wasmAvailable(): boolean {
  if (wasm === undefined) wasm = typeof WebAssembly === 'object' ? load() : null;
  return wasm !== null;
}

/** Tokenizes `text`, as css-lexer.ts's `tokenize` does. */
export function tokenize(text: string): Tokens {
  const len = text.length;
  if (len < WASM_MIN_LENGTH || !wasmAvailable()) return tokenizeTs(text);
  try {
    // A large text in an instance of its own.
    return tokenizeWasm(len >= OWN_INSTANCE_LENGTH ? ownInstance() : (wasm as Exports), text);
  } catch {
    // Out of memory for another instance or for the text: the TypeScript lexer needs neither.
    return tokenizeTs(text);
  }
}

/** A new instance of the module, for a large text; throws where there is no memory for it. */
export const ownInstance = (): Exports => instantiate(compiled as WebAssembly.Module);

/** Tokenizes `text` with the module whatever its length. Exported for the tests and benchmarks. */
export function tokenizeWasm(w: Exports, text: string): Tokens {
  const at = copyIn(w, text);
  return copyOut(w, at, lex(w, at));
}

/** Where `copyIn` put the text and where the module is to write its tokens. */
export interface Layout {
  len: number;
  /** One byte per code unit, else UTF-16. */
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
  // Past the kinds and a byte more, which the outline sets to Eof after the last token.
  const startsAt = (kindsAt + len + 4) & ~3;
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
export const lex = (w: Exports, at: Layout): number =>
  w.run(at.len, at.narrow ? 0 : 1, at.kindsAt, at.startsAt, LEX_ONLY);

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
