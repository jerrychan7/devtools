/**
 * Rewrites of CSS text found by its tokens (css-lexer.ts): the declarations of a block, the calls of
 * named functions, and the queries of a media query list. Comments and strings are read as CSS reads
 * them, and blocks match by their tokens. A declaration's property and a function's name are compared as
 * written, escapes included; the words of a media query are compared decoded (`decodeEscapes`). What a
 * hook does not change comes back byte for byte.
 */
import { Tok, tokenize, type TokKind, type Tokens } from '../css/sheets/parse/css-lexer';

/**
 * Gets a declaration's property and its value (`red !important` as written), and returns the new
 * value, or null to keep the declaration as it is.
 */
export type DeclarationHook = (property: string, value: string) => string | null;

/**
 * Gets a function's name (lowercase), its arguments (the text between its parentheses) and its whole
 * text (`name(…)`), and returns what to put in its place, or null to keep it.
 */
export type FunctionHook = (name: string, args: string, whole: string) => string | null;

/** `text` with its ASCII letters lowercased: CSS compares names so, and other letters are left alone. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, letters => letters.toLowerCase());
}

/**
 * `text`, an identifier as written, with its escapes decoded as CSS Syntax decodes them (§4.3.7): a
 * backslash and one to six hex digits are the code point they name, with one whitespace after them as
 * part of the escape (CR LF is one); zero, a surrogate or a code point past U+10FFFF is U+FFFD. A
 * backslash before any other character is that character, and one at the end of the text is U+FFFD.
 * Meant for identifier tokens, where a backslash always starts a valid escape.
 */
export function decodeEscapes(text: string): string {
  if (!text.includes('\\')) return text;
  return text.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|([\s\S])|$)/g,
    (_escape: string, hex: string | undefined, char: string | undefined) => {
      if (hex === undefined) return char ?? '�';
      const code = parseInt(hex, 16);
      const valid = code !== 0 && (code < 0xd800 || code > 0xdfff) && code <= 0x10ffff;
      return valid ? String.fromCodePoint(code) : '�';
    }
  );
}

/** The kinds of token that open a block, by the kind of the token that closes it. */
const CLOSING = new Map<TokKind, TokKind>([
  [Tok.Func, Tok.RParen],
  [Tok.LParen, Tok.RParen],
  [Tok.LBracket, Tok.RBracket],
  [Tok.LBrace, Tok.RBrace],
]);

/** Whitespace and comments: the tokens that surround a value without being part of it. */
const insignificant = (kind: TokKind) => kind === Tok.Ws || kind === Tok.Comment;

/**
 * For each token that opens a block, the index of the token that closes it, or -1 when none does. As
 * in CSS, a closing token closes only the block it matches: one inside a block of another kind is a
 * token of that block.
 */
function closingIndices(kinds: Tokens['kinds']): Int32Array {
  const closing = new Int32Array(kinds.length).fill(-1);
  const open: { at: number; closer: TokKind }[] = [];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i] ?? Tok.Eof;
    const closer = CLOSING.get(kind);
    if (closer !== undefined) {
      open.push({ at: i, closer });
      continue;
    }
    const top = open[open.length - 1];
    if (top && top.closer === kind) {
      open.pop();
      closing[top.at] = i;
    }
  }
  return closing;
}

/**
 * The indices, in order, of the tokens outside every block. A block's tokens are skipped, and a block
 * that is not closed hides the tokens after it.
 */
function* outside(kinds: Tokens['kinds'], closing: Int32Array): Generator<number> {
  for (let i = 0; i < kinds.length; i++) {
    if (!CLOSING.has(kinds[i] ?? Tok.Eof)) {
      yield i;
      continue;
    }
    const end = closing[i] ?? -1;
    if (end < 0) return;
    i = end;
  }
}

/**
 * Rewrites the values of the declarations of `block`, a declaration list (a style attribute, or a
 * CSSStyleDeclaration's cssText, without braces). Each top-level `name: value` is passed to `hook`
 * with its name (ASCII-lowercased, except custom properties, `--x`) and its value: the text after the
 * colon, without the whitespace and comments around it, `!important` included. A returned string
 * replaces that value. Declarations are split at top-level semicolons. A part with no name and colon,
 * or with no value (only whitespace and comments), is malformed and left alone, and so is everything
 * else in the block.
 */
export function mapDeclarations(block: string, hook: DeclarationHook): string {
  const { kinds, starts } = tokenize(block);
  const n = kinds.length;
  const closing = closingIndices(kinds);
  const kind = (i: number) => kinds[i] ?? Tok.Eof;
  const at = (i: number) => starts[i] ?? block.length;
  /** The first token from `i` before `end` that is not whitespace or a comment, or `end`. */
  const skip = (i: number, end: number) => {
    let j = i;
    while (j < end && insignificant(kind(j))) j++;
    return j;
  };
  let out = '';
  let kept = 0;
  /** Rewrites the declaration made of the tokens from `from` up to `end`. */
  const declaration = (from: number, end: number) => {
    const nameAt = skip(from, end);
    if (nameAt >= end || kind(nameAt) !== Tok.Ident) return;
    const colonAt = skip(nameAt + 1, end);
    if (colonAt >= end || kind(colonAt) !== Tok.Colon) return;
    const valueAt = skip(colonAt + 1, end);
    let valueEnd = end;
    while (valueEnd > valueAt && insignificant(kind(valueEnd - 1))) valueEnd--;
    if (valueAt >= valueEnd) return;
    const raw = block.slice(at(nameAt), at(nameAt + 1));
    const property = raw.startsWith('--') ? raw : asciiLower(raw);
    const value = hook(property, block.slice(at(valueAt), at(valueEnd)));
    if (value === null) return;
    out += block.slice(kept, at(valueAt)) + value;
    kept = at(valueEnd);
  };
  let from = 0;
  for (const i of outside(kinds, closing)) {
    if (kind(i) === Tok.Semi) {
      declaration(from, i);
      from = i + 1;
    }
  }
  declaration(from, n);
  return out + block.slice(kept);
}

/**
 * Rewrites the calls of the functions in `text` whose name is one of `names` (compared ASCII-case-
 * insensitively, with escapes as written). Each call found is passed to `hook`, and a returned string
 * replaces its whole text. A call the hook replaces is not searched; any other call is, so a matching
 * call inside the arguments of another call is found. A call that is not closed runs to the end.
 */
export function mapFunctions(text: string, names: readonly string[], hook: FunctionHook): string {
  const wanted = new Set(names.map(asciiLower));
  const { kinds, starts } = tokenize(text);
  const n = kinds.length;
  const closing = closingIndices(kinds);
  const at = (i: number) => starts[i] ?? text.length;
  let out = '';
  for (let i = 0; i < n; i++) {
    if ((kinds[i] ?? Tok.Eof) === Tok.Func) {
      // The token is `name(`: the name is what comes before its last character.
      const name = asciiLower(text.slice(at(i), at(i + 1) - 1));
      if (wanted.has(name)) {
        // A call that is not closed ends with the text: its closing token is the end of the tokens.
        const end = closing[i] ?? -1;
        const stop = end < 0 ? n : end;
        const replacement = hook(name, text.slice(at(i + 1), at(stop)), text.slice(at(i), at(stop + 1)));
        if (replacement !== null) {
          out += replacement;
          i = stop;
          continue;
        }
      }
    }
    out += text.slice(at(i), at(i + 1));
  }
  return out;
}

/**
 * Splits a media query list at its top-level commas: not those in parentheses or another block, in a
 * function, a string, a comment or an escape. The parts are returned as written, spaces included.
 */
export function splitMediaQueries(text: string): string[] {
  const { kinds, starts } = tokenize(text);
  const closing = closingIndices(kinds);
  const parts: string[] = [];
  let from = 0;
  for (const i of outside(kinds, closing)) {
    if (kinds[i] === Tok.Comma) {
      parts.push(text.slice(from, starts[i] ?? text.length));
      from = starts[i + 1] ?? text.length;
    }
  }
  parts.push(text.slice(from));
  return parts;
}
