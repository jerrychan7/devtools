/**
 * The outline of css-outline.ts, made by the WebAssembly module css-lexer-wasm.ts loads, where it
 * compiled: the text is lexed and outlined in the module (wasm-gen/outline.ts), and only the two
 * tables are copied out into a `CssOutline`, the same one, field for field, as css-outline.ts makes.
 *
 * css-outline.ts makes it instead for a short text, where WebAssembly does not compile (a CSP
 * without `wasm-unsafe-eval`), and when the module fails on a text: out of memory, or a call stack
 * overflow from blocks nested thousands deep, where css-outline.ts may overflow too.
 */
import { CssOutline, outline as outlineTs } from './css-outline';
import { copyIn, type Exports, OWN_INSTANCE_LENGTH, ownInstance, wasmExports } from './css-lexer-wasm';

/** Int32 fields per rule and per declaration (css-outline.ts). */
const RW = 12;
const DW = 6;

/** Texts shorter than this are outlined by css-outline.ts: about where the two take as long (bench/README.md). */
export const WASM_OUTLINE_MIN_LENGTH = 16;

/** The rules of a style sheet's text, as css-outline.ts's `outline` finds them. */
export function outline(text: string): CssOutline {
  const len = text.length;
  if (len < WASM_OUTLINE_MIN_LENGTH) return outlineTs(text);
  const w = wasmExports();
  if (!w) return outlineTs(text);
  try {
    // A large text in an instance of its own, as `tokenize` does (css-lexer-wasm.ts).
    return outlineWasm(len >= OWN_INSTANCE_LENGTH ? ownInstance() : w, text);
  } catch {
    // Memory that cannot grow (RangeError, or the module's trap), or the call stack.
    return outlineTs(text);
  }
}

/** Outlines `text` with the module whatever its length. Exported for the tests and benchmarks. */
export function outlineWasm(w: Exports, text: string): CssOutline {
  const at = copyIn(w, text);
  const rules = w.run(at.len, at.narrow ? 0 : 1, at.kindsAt, at.startsAt, 0);
  const buf = w.m.buffer;
  const rb = w.rb();
  const db = w.db();
  const decls = w.dc();
  const o = new CssOutline(0, 0);
  o.rules = new Int32Array(buf.slice(rb, rb + rules * RW * 4));
  o.decls = new Int32Array(buf.slice(db, db + decls * DW * 4));
  o.ruleCount = rules;
  o.declCount = decls;
  return o;
}
