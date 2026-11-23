/**
 * Rewrites of CSS text found by its tokens (css-lexer.ts): the declarations of a block, the calls of
 * named functions, and the queries of a media query list. Comments and strings are read as CSS reads
 * them, and blocks match by their tokens. A declaration's property, a function's name and the words of a
 * media query are compared decoded (`decodeEscapes`), as CSS compares them: `e\nv(` is a call of `env()`.
 * What a hook does not change comes back byte for byte.
 */
import { Tok, tokenize, type TokKind, type Tokens } from '../../css/sheets/parse/css-lexer';

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
      if (hex === undefined) return char ?? '\uFFFD';
      const code = parseInt(hex, 16);
      const valid = code !== 0 && (code < 0xd800 || code > 0xdfff) && code <= 0x10ffff;
      return valid ? String.fromCodePoint(code) : '\uFFFD';
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

/** A declaration of a block: where its name and its value are in the block's text. */
interface Span {
  nameStart: number;
  nameEnd: number;
  /** The value: the text after the colon, without the whitespace and comments around it. Empty for none. */
  valueStart: number;
  valueEnd: number;
}

/**
 * The declarations of `block`, a declaration list (a style attribute, or a CSSStyleDeclaration's cssText,
 * without braces), split at its top-level semicolons: not those in a block, a function, a string, a comment
 * or an escape. A part that does not start with a name and a colon is no declaration.
 */
function spansOf(block: string): Span[] {
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
  const spans: Span[] = [];
  /** The declaration made of the tokens from `from` up to `end`. */
  const declaration = (from: number, end: number) => {
    const nameAt = skip(from, end);
    if (nameAt >= end || kind(nameAt) !== Tok.Ident) return;
    const colonAt = skip(nameAt + 1, end);
    if (colonAt >= end || kind(colonAt) !== Tok.Colon) return;
    const valueAt = skip(colonAt + 1, end);
    let valueEnd = end;
    while (valueEnd > valueAt && insignificant(kind(valueEnd - 1))) valueEnd--;
    // No value: an empty one, where the colon ends.
    const empty = valueAt >= valueEnd;
    spans.push({
      nameStart: at(nameAt),
      nameEnd: at(nameAt + 1),
      valueStart: empty ? at(colonAt + 1) : at(valueAt),
      valueEnd: empty ? at(colonAt + 1) : at(valueEnd),
    });
  };
  let from = 0;
  for (const i of outside(kinds, closing)) {
    if (kind(i) === Tok.Semi) {
      declaration(from, i);
      from = i + 1;
    }
  }
  declaration(from, n);
  return spans;
}

/** A property's name as CSS compares it: decoded, and ASCII-lowercased unless it is a custom property's (`--x`). */
function propertyOf(raw: string): string {
  const name = decodeEscapes(raw);
  return name.startsWith('--') ? name : asciiLower(name);
}

/** A declaration of a block, as written. */
export interface Declaration {
  /** The property (decoded, ASCII-lowercased, except custom properties, `--x`). */
  name: string;
  /** The declaration's text, from its name to the end of its value. */
  text: string;
  /** The text after the colon, without the whitespace and comments around it (`!important` included); empty for none. */
  value: string;
}

/**
 * The declarations of `block`, a declaration list, in order: each top-level `name: value`, one with no value
 * included (the browser writes the longhands of a pending shorthand so). A semicolon or a comment mark in a
 * string, a comment or a block is not one of the list's.
 */
export function splitDeclarations(block: string): Declaration[] {
  return spansOf(block).map(span => ({
    name: propertyOf(block.slice(span.nameStart, span.nameEnd)),
    text: block.slice(span.nameStart, span.valueEnd),
    value: block.slice(span.valueStart, span.valueEnd),
  }));
}

/**
 * `block`, a declaration list as the CSSOM serializes it, without its last semicolon where that one is not the
 * list's own. The browser writes a custom property's value (or a value with a var()) as it was written, and a
 * semicolon after it: where the value leaves a function, a block or a string open, the text parsed again takes that
 * semicolon into the value.
 */
export function withoutTakenSemicolon(block: string): string {
  if (!block.endsWith(';')) return block;
  const { kinds } = tokenize(block);
  let last = -1;
  for (const i of outside(kinds, closingIndices(kinds))) last = i;
  return last === kinds.length - 1 && kinds[last] === Tok.Semi ? block : block.slice(0, -1);
}

/**
 * A declaration's value as written, split into the value and its priority: `!important` in any case, with the
 * whitespace and comments before it and inside it (empty for none).
 */
export function splitPriority(value: string): { value: string; priority: string } {
  const { kinds, starts } = tokenize(value);
  const kind = (i: number) => kinds[i] ?? Tok.Eof;
  const text = (i: number) => value.slice(starts[i] ?? 0, starts[i + 1] ?? value.length);
  /** The last token before `i` that is not whitespace or a comment, or -1. */
  const before = (i: number) => {
    let j = i - 1;
    while (j >= 0 && insignificant(kind(j))) j--;
    return j;
  };
  const word = before(kinds.length);
  const bang = before(word);
  const important =
    bang >= 0 &&
    kind(word) === Tok.Ident &&
    asciiLower(decodeEscapes(text(word))) === 'important' &&
    text(bang) === '!';
  if (!important) return { value, priority: '' };
  const end = starts[before(bang) + 1] ?? 0;
  return { value: value.slice(0, end), priority: value.slice(end) };
}

/**
 * Rewrites the values of the declarations of `block`, a declaration list (a style attribute, or a
 * CSSStyleDeclaration's cssText, without braces). Each top-level `name: value` is passed to `hook`
 * with its name (decoded and ASCII-lowercased, except custom properties, `--x`) and its value: the text
 * after the colon, without the whitespace and comments around it, `!important` included. A returned string
 * replaces that value. Declarations are split at top-level semicolons. A part with no name and colon,
 * or with no value (only whitespace and comments), is malformed and left alone, and so is everything
 * else in the block.
 */
export function mapDeclarations(block: string, hook: DeclarationHook): string {
  let out = '';
  let kept = 0;
  for (const span of spansOf(block)) {
    if (span.valueStart >= span.valueEnd) continue;
    const value = hook(
      propertyOf(block.slice(span.nameStart, span.nameEnd)),
      block.slice(span.valueStart, span.valueEnd)
    );
    if (value === null) continue;
    out += block.slice(kept, span.valueStart) + value;
    kept = span.valueEnd;
  }
  return out + block.slice(kept);
}

/**
 * Rewrites the calls of the functions in `text` whose name is one of `names` (compared decoded and ASCII-case-
 * insensitively, as CSS compares them). Each call found is passed to `hook`, and a returned string
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
      const name = asciiLower(decodeEscapes(text.slice(at(i), at(i + 1) - 1)));
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
 * Splits a list (media queries, the entries of `sizes`, the layers of a background) at its top-level commas:
 * not those in parentheses or another block, in a function, a string, a comment or an escape. The parts are
 * returned as written, spaces included.
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

/**
 * `text` without the whitespace at either end, as CSS sees whitespace: the whitespace tokens, not the
 * characters JS trims. A space that an escape takes (`x\ `) is part of its identifier and stays. So does
 * the whitespace after a bad string or a backslash, which ends that token: without it, the comma that
 * follows would be read as part of the token.
 */
export function trimWhitespace(text: string): string {
  const { kinds, starts } = tokenize(text);
  const n = kinds.length;
  let from = 0;
  while (from < n && kinds[from] === Tok.Ws) from++;
  let to = n;
  while (to > from && kinds[to - 1] === Tok.Ws) to--;
  const last = to - 1;
  const endsToken = kinds[last] === Tok.BadStr || (kinds[last] === Tok.Delim && text[starts[last] ?? 0] === '\\');
  if (to < n && to > from && endsToken) to = n;
  return text.slice(starts[from] ?? text.length, starts[to] ?? text.length);
}

/**
 * The last component value of `text` and what comes before it, as [start, end) ranges of the text, without the
 * whitespace and comments around each: the length of a `sizes` entry and its media condition. A block or a
 * function with what it holds is one component. Null where the text has no two such parts.
 */
export function splitLast(text: string): { before: [number, number]; last: [number, number] } | null {
  const { kinds, starts } = tokenize(text);
  const closing = closingIndices(kinds);
  const at = (i: number) => starts[i] ?? text.length;
  /** The top-level components that are not whitespace or comments: the token each starts and ends with. */
  const parts: [number, number][] = [];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i] ?? Tok.Eof;
    if (insignificant(kind) || kind === Tok.Eof) continue;
    // A block that is not closed runs to the end of the text.
    const closed = closing[i] ?? -1;
    const end = !CLOSING.has(kind) ? i : closed < 0 ? kinds.length - 1 : closed;
    parts.push([i, end]);
    i = end;
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  const beforeLast = parts[parts.length - 2];
  if (!first || !last || !beforeLast) return null;
  return { before: [at(first[0]), at(beforeLast[1] + 1)], last: [at(last[0]), at(last[1] + 1)] };
}
