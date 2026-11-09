// What the CSS domain reads from a paired SheetSource: ranges in lines and columns, the spans of
// a rule's selectors and style, and a rule's style as written in the text.
import { Tok, tokenize } from '../parse/css-lexer-wasm';
import { type CssOutline, ROOT } from '../parse/css-outline';
import { outline } from '../parse/css-outline-wasm';
import { lineStarts, offsetAt, positionAt } from './text-lines';
import type { Protocol } from 'devtools-protocol';
import { type CSSStyle, type Written, styleOf } from '../../style';
import type { SheetSource } from './pair';
import { reportedComment } from './commented';

/** A range of the text, in lines and columns. */
export function rangeOf(source: SheetSource, start: number, end: number): Protocol.CSS.SourceRange {
  const a = positionAt(source.lines, start);
  const b = positionAt(source.lines, end);
  return { startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column };
}

/** The offsets of a range, or null when it is outside the text. */
export function offsetsOf(source: SheetSource, range: Protocol.CSS.SourceRange): [number, number] | null {
  const start = offsetAt(source.lines, range.startLine, range.startColumn);
  const end = offsetAt(source.lines, range.endLine, range.endColumn);
  return start < 0 || end < start || end > source.text.length ? null : [start, end];
}

/**
 * The selectors of a prelude as Chrome gives their ranges: each from its first character to the
 * comma after it (white space and comments before it included), the last one to the `{`.
 */
export function selectorSpans(source: SheetSource, node: number): [number, number][] {
  const { text, outline: o } = source;
  const from = o.preludeStart(node);
  const prelude = text.slice(from, o.preludeEnd(node));
  const { kinds, starts } = tokenize(prelude);
  const spans: [number, number][] = [];
  let start = -1;
  let depth = 0;
  kinds.forEach((k, i) => {
    const at = starts[i] ?? 0;
    if (k === Tok.LParen || k === Tok.Func || k === Tok.LBracket || k === Tok.LBrace) depth++;
    else if (k === Tok.RParen || k === Tok.RBracket || k === Tok.RBrace) depth--;
    if (k === Tok.Comma && depth === 0) {
      spans.push([from + Math.max(start, 0), from + at]);
      start = -1;
    } else if (start < 0 && k !== Tok.Ws && k !== Tok.Comment) start = at;
  });
  // Like Chrome, with the comments ending it (to the `{`), without the white space, even that of
  // an escape (`.k\31 `).
  let end = o.blockStart(node) >= 0 ? o.blockStart(node) : o.preludeEnd(node);
  while (end > from && /[ \t\n\r\f]/.test(text[end - 1] ?? '')) end--;
  spans.push([from + Math.max(start, 0), end]);
  return spans.map(([s, e]) => [Math.min(s, e), e]);
}

/**
 * The text of a selector as Chrome gives it: what is in its range without comments, trimmed of
 * CSS white space (U+2028 and others JavaScript trims are characters of a selector). Like Chrome,
 * a comment is anything from `/*` to `*\/`, in a string too.
 */
export function selectorText(range: string): string {
  return range.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
}

/**
 * Where the declarations of a rule are, as Chrome's style range: from past `{` to before `}`, or
 * to the first nested rule; for nested declarations, from the first to the last of them.
 */
export function styleSpan(source: SheetSource, node: number): [number, number] {
  const { text, outline: o } = source;
  const last = o.lastDecl(node);
  if (o.kind(node) === 'nested') {
    if (last < 0 || o.semicolon(last) || o.commented(last)) return [o.start(node), o.end(node)];
    // A last declaration without `;` runs to the `}`.
    let end = o.end(node);
    while (end < text.length && /\s/.test(text[end] ?? '')) end++;
    return [o.start(node), text[end] === '}' || end >= text.length ? end : o.end(node)];
  }
  // Like Chrome, after the `{` of a nested rule with no selector first in the block (`a {{`).
  const first = o.firstChild(node);
  const start =
    first >= 0 && o.kind(first) === 'qualified' && o.preludeStart(first) === o.preludeEnd(first) && last < 0
      ? o.blockStart(first) + 1
      : o.blockStart(node) + 1;
  // Declarations before nested rules end with the last of them.
  const end =
    first >= 0 && last >= 0 ? declSpan(text, o, last)[1] : o.closed(node) ? o.blockEnd(node) - 1 : o.blockEnd(node);
  return [Math.min(start, end), Math.max(end, Math.min(start, text.length))];
}

/** Where declaration `d` is: one in a comment is the whole comment. */
function declSpan(text: string, o: CssOutline, d: number): [number, number] {
  if (!o.commented(d)) return [o.declStart(d), o.declEnd(d)];
  const close = text.indexOf('*/', o.declEnd(d));
  return [text.lastIndexOf('/*', o.declStart(d)), close < 0 ? text.length : close + 2];
}

/** The style of a rule as written in the text. */
export function sourceStyle(
  styleSheetId: string,
  decl: CSSStyleDeclaration,
  source: SheetSource,
  node: number
): CSSStyle {
  const [from, to] = styleSpan(source, node);
  const written = writtenOf(source.text, source.outline, node, to, (s, e) => rangeOf(source, s, e));
  return styleOf(styleSheetId, decl, written, source.text.slice(from, to), rangeOf(source, from, to));
}

/**
 * A style as `text` writes it (a style attribute, or a style's text set by setStyleTexts), its
 * text starting at `line` and `column`: each declaration with its text and range as written, the
 * commented-out ones Chrome reports, as in a sheet's rule.
 */
export function textStyle(
  styleSheetId: string,
  decl: CSSStyleDeclaration,
  text: string,
  line: number,
  column: number
): CSSStyle {
  return styleOf(styleSheetId, decl, textWritten(text, line, column), text, textRange(text, line, column));
}

/** The range of `text` starting at `line` and `column`. */
export function textRange(text: string, line: number, column: number): Protocol.CSS.SourceRange {
  const end = at(lineStarts(text), text.length, line, column);
  return { startLine: line, startColumn: column, endLine: end.line, endColumn: end.column };
}

/** Offset `offset` of a text starting at `line` and `column`, its lines starting at `starts`. */
function at(starts: readonly number[], offset: number, line: number, column: number) {
  const p = positionAt(starts, offset);
  return p.line === 0 ? { line, column: column + p.column } : { line: line + p.line, column: p.column };
}

/**
 * The last text read by `textWritten`, and what it gave: a style is asked for again and again.
 * The answer depends on the text and start alone: whether a comment is reported also depends on
 * CSS.supports(), but on the one the probe took (commented.ts), which stays the same.
 */
let lastWritten: { text: string; line: number; column: number; written: readonly Written[] } | undefined;

/**
 * The declarations `text` writes, as `textStyle` reports them; kept for the next call, so not to
 * be changed (styleOf() copies what it reports). Like Chrome, the text is a list of declarations
 * with no rule around it and none in it (`textParts`), each declaration read as in a sheet's rule.
 */
export function textWritten(text: string, line: number, column: number): readonly Written[] {
  if (lastWritten?.text === text && lastWritten.line === line && lastWritten.column === column)
    return lastWritten.written;
  const starts = lineStarts(text);
  const written: Written[] = [];
  for (const [from, to] of textParts(text)) {
    // The part alone in a rule, from the start of the line after its `{`, its braces masked
    // (`maskBraces`), of the same length: the text is read from the part as written.
    const head = '*{\n';
    const part = text.slice(from, to);
    const o = outline(head + maskBraces(part));
    const node = o.firstChild(ROOT);
    if (node < 0) continue;
    const range = (start: number, end: number): Protocol.CSS.SourceRange => {
      const a = at(starts, from + start - head.length, line, column);
      const b = at(starts, from + end - head.length, line, column);
      return { startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column };
    };
    written.push(...writtenOf(head + part, o, node, head.length + part.length, range));
  }
  lastWritten = { text, line, column, written };
  return written;
}

/** The token closing a block each opening one starts. */
const CLOSER: Partial<Record<number, number>> = {
  [Tok.LParen]: Tok.RParen,
  [Tok.Func]: Tok.RParen,
  [Tok.LBracket]: Tok.RBracket,
  [Tok.LBrace]: Tok.RBrace,
};
const isCloser = (k: number) => k === Tok.RParen || k === Tok.RBracket || k === Tok.RBrace;

/**
 * The parts of a style attribute's text that may be declarations, as Blink reads it (measured in
 * Chrome 157): its comments between declarations, and each declaration, from a name and its `:` to
 * its `;`, or to a `{` (the block and what follows to the next `;` dropped), except that a custom
 * property's value may hold blocks (`--x: a {b}`). An at-rule is skipped to its `;` or the end of
 * its block; anything else to the next `;`. A block ends only at the token closing it, as in CSS
 * Syntax: `}` closes no `(`, and one closing no block is a token like any other. A custom property
 * with such a token is no declaration (`--x: ( } )`), as its value would not parse.
 */
function textParts(text: string): [number, number][] {
  const { kinds, starts } = tokenize(text);
  const n = kinds.length;
  const end = (i: number) => starts[i + 1] ?? text.length;
  const parts: [number, number][] = [];
  /** Past the token closing the block opened at `i`, or the end. */
  const skipBlock = (i: number) => {
    const open: number[] = [];
    for (; i < n; i++) {
      const k = kinds[i] ?? Tok.Eof;
      const closer = CLOSER[k];
      if (closer !== undefined) open.push(closer);
      else if (k === open[open.length - 1]) {
        open.pop();
        if (!open.length) return i + 1;
      }
    }
    return n;
  };
  /** The first token from `i` that `stop` accepts, not in a block, or the end. */
  const scan = (i: number, stop: (k: number) => boolean) => {
    while (i < n) {
      const k = kinds[i] ?? Tok.Eof;
      if (stop(k)) return i;
      i = CLOSER[k] !== undefined ? skipBlock(i) : i + 1;
    }
    return n;
  };
  /** Whether tokens `from` to `to` hold one closing no block they hold. */
  const unmatched = (from: number, to: number) => {
    const open: number[] = [];
    for (let i = from; i < to; i++) {
      const k = kinds[i] ?? Tok.Eof;
      const closer = CLOSER[k];
      if (closer !== undefined) open.push(closer);
      else if (isCloser(k) && open.pop() !== k) return true;
    }
    return false;
  };
  let i = 0;
  while (i < n) {
    const k = kinds[i];
    if (k === Tok.Ws || k === Tok.Semi) i++;
    else if (k === Tok.Comment) {
      parts.push([starts[i] ?? 0, end(i)]);
      i++;
    } else if (k === Tok.At) {
      // To its `;`, or past its block.
      const stop = scan(i + 1, k => k === Tok.Semi || k === Tok.LBrace);
      i = kinds[stop] === Tok.LBrace ? skipBlock(stop) : stop + 1;
    } else if (k === Tok.Ident && kinds[colonAfter(kinds, i + 1)] === Tok.Colon) {
      const custom = text.startsWith('--', starts[i] ?? 0);
      const stop = scan(i + 1, k => k === Tok.Semi || (k === Tok.LBrace && !custom));
      if (kinds[stop] === Tok.LBrace) {
        parts.push([starts[i] ?? 0, starts[stop] ?? text.length]);
        i = scan(stop, k => k === Tok.Semi) + 1;
      } else {
        if (!custom || !unmatched(i + 1, stop)) parts.push([starts[i] ?? 0, stop < n ? end(stop) : text.length]);
        i = stop + 1;
      }
    } else i = scan(i, k => k === Tok.Semi) + 1;
  }
  return parts;
}

/**
 * The index of the first token from `i` that is no white space or comment. Chrome keeps a comment
 * before the `:` in the name (`color /*x*\/ : red` names `color /*x*\/`), the outline does not:
 * both would change to follow it.
 */
function colonAfter(kinds: ArrayLike<number>, i: number): number {
  while (kinds[i] === Tok.Ws || kinds[i] === Tok.Comment) i++;
  return i;
}

/**
 * `part` with its `{` made `(` and the `}` closing each made `)`, as the outline reads blocks of
 * neither, and a `}` closing no block (`color: f( }`, `color: red } x`) made a `%`, which closes
 * nothing either.
 */
function maskBraces(part: string): string {
  const { kinds, starts } = tokenize(part);
  const masks: [number, string][] = [];
  const open: number[] = [];
  kinds.forEach((k, i) => {
    const closer = CLOSER[k];
    if (closer !== undefined) {
      open.push(closer);
      if (k === Tok.LBrace) masks.push([starts[i] ?? 0, '(']);
    } else if (isCloser(k)) {
      const matches = open[open.length - 1] === k;
      if (matches) open.pop();
      if (k === Tok.RBrace) masks.push([starts[i] ?? 0, matches ? ')' : '%']);
    }
  });
  if (!masks.length) return part;
  const pieces: string[] = [];
  let last = 0;
  for (const [at, c] of masks) {
    pieces.push(part.slice(last, at), c);
    last = at + 1;
  }
  pieces.push(part.slice(last));
  return pieces.join('');
}

/** The declarations of `node`, its style ending at `to`, with the ranges `range` gives. */
function writtenOf(
  text: string,
  o: CssOutline,
  node: number,
  to: number,
  range: (start: number, end: number) => Protocol.CSS.SourceRange
): Written[] {
  const last = o.lastDecl(node);
  const written: Written[] = [];
  for (let d = o.firstDecl(node); d <= last; d++) {
    const comment = o.commented(d);
    const dStart = o.declStart(d);
    if (comment && !reportedComment(text.slice(dStart, o.nameEnd(d)), text.slice(o.valueStart(d), o.valueEnd(d))))
      continue;
    const [start, span] = declSpan(text, o, d);
    const semicolon = o.semicolon(d);
    const valueStart = o.valueStart(d);
    const valueEnd = o.valueEnd(d);
    // The last declaration without `;` runs to the `}`.
    const end = !comment && !semicolon && d === last ? Math.max(span, to) : span;
    // Like Chrome, the value with `!important` as written.
    let until = semicolon ? o.declEnd(d) - 1 : o.declEnd(d);
    while (until > valueEnd && /\s/.test(text[until - 1] ?? '')) until--;
    written.push({
      name: text.slice(dStart, o.nameEnd(d)),
      value: text.slice(valueStart, valueEnd),
      shown: text.slice(valueStart, o.important(d) ? until : valueEnd),
      // Like Chrome, a commented-out declaration is not important.
      important: o.important(d) && !comment,
      disabled: comment,
      text: text.slice(start, end),
      range: range(start, end),
    });
  }
  return written;
}
