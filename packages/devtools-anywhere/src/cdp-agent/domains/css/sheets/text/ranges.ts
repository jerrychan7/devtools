// What the CSS domain reads from a paired SheetSource: ranges in lines and columns, the spans of
// a rule's selectors and style, and a rule's style as written in the text.
import { Tok, tokenize } from '../parse/css-lexer-wasm';
import type { CssOutline } from '../parse/css-outline';
import { offsetAt, positionAt } from './text-lines';
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
  const { text, outline: o } = source;
  const [from, to] = styleSpan(source, node);
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
      range: rangeOf(source, start, end),
    });
  }
  return styleOf(styleSheetId, decl, written, text.slice(from, to), rangeOf(source, from, to));
}
