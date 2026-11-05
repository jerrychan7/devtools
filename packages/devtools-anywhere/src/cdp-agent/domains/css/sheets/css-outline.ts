/**
 * The outline of a style sheet's text: where each rule, its prelude and block, and each
 * declaration lie, built on css-lexer.ts by the parsing algorithms of CSS Syntax Level 3 §5.5
 * (https://drafts.csswg.org/css-syntax-3/#consume-stylesheet-contents), including their error
 * recovery and CSS nesting, so the rules found line up with the ones CSSOM keeps. What the
 * algorithms leave to grammars is not checked: a rule with an invalid selector or prelude, a
 * declaration of an unknown property or with an invalid value are kept here though CSSOM drops them.
 *
 * Offsets are UTF-16 code units. Ranges are half-open, `[start, end)`.
 */
import { Tok, tokenize, type TokKind } from './css-lexer';

export interface CssDecl {
  /** `comment`: a comment in a block whose text is one declaration (a disabled property). */
  kind: 'decl' | 'comment';
  /** From the name to the end of the value, or past the `;` that ends it. */
  start: number;
  end: number;
  nameEnd: number;
  /** Leading whitespace and comments and trailing whitespace trimmed, `!important` excluded. */
  valueStart: number;
  valueEnd: number;
  important: boolean;
  /** Ended by `;`, rather than by `}`, the end of the text or the comment. */
  semicolon: boolean;
}

export interface CssRule {
  /** `nested`: a run of declarations after a nested rule (CSSNestedDeclarations). */
  kind: 'qualified' | 'at' | 'nested';
  start: number;
  end: number;
  /** At-rules: the name without `@`, as written. */
  name: string;
  /** The selector or at-rule prelude, trimmed of whitespace and comments. */
  preludeStart: number;
  preludeEnd: number;
  /** From `{` to past `}` (or the end of the text); -1 without a block. */
  blockStart: number;
  blockEnd: number;
  /** False when the text ends before the block's `}`. */
  closed: boolean;
  /**
   * The declarations before the first nested rule (all of them, for `nested`). Group rules in
   * style rules (`a { @media x { color: red } }`) have none: theirs are in `nested` rules.
   */
  decls: CssDecl[];
  /** Nested rules, and the runs of declarations between and after them, in order. */
  rules: CssRule[];
}

const closer = (k: TokKind): TokKind | undefined =>
  k === Tok.LBrace
    ? Tok.RBrace
    : k === Tok.LBracket
      ? Tok.RBracket
      : k === Tok.LParen || k === Tok.Func
        ? Tok.RParen
        : undefined;
const trivia = (k: TokKind) => k === Tok.Ws || k === Tok.Comment;

/** The top-level rules of a style sheet's text (§5.4.1 "parse a stylesheet"). */
export function outline(text: string): CssRule[] {
  return parse(text, false).rules;
}

/**
 * The declaration a comment from `start` to `end` holds, as DevTools shows disabled properties:
 * the comment's text is one declaration, its `;` optional, and whitespace.
 */
function commented(text: string, start: number, end: number): CssDecl | null {
  const from = start + 2;
  const inner = text.slice(from, text.endsWith('*/', end) && end - start >= 4 ? end - 2 : end);
  const { decls, rules } = parse(inner, true);
  const d = decls[0];
  if (!d || decls.length > 1 || rules.length || inner.slice(0, d.start).trim() || inner.slice(d.end).trim())
    return null;
  return {
    kind: 'comment',
    start: d.start + from,
    end: d.end + from,
    nameEnd: d.nameEnd + from,
    valueStart: d.valueStart + from,
    valueEnd: d.valueEnd + from,
    important: d.important,
    semicolon: d.semicolon,
  };
}

/** The rules of `text` as a style sheet, or with `inBlock`, its contents as a block's. */
function parse(text: string, inBlock: boolean): CssRule {
  const { kinds, starts } = tokenize(text);
  const n = kinds.length;
  const kind = (j: number): TokKind => kinds[j] ?? Tok.Eof;
  const pos = (j: number) => starts[j] ?? text.length;
  let i = 0;

  /** §5.5.9 consume a component value: past a whole block or function. */
  const value = () => {
    const c = closer(kind(i++));
    if (c === undefined) return;
    const stack = [c];
    while (i < n && stack.length) {
      const k = kind(i++);
      if (k === stack[stack.length - 1]) stack.pop();
      else {
        const o = closer(k);
        if (o !== undefined) stack.push(o);
      }
    }
  };
  /**
   * The end of the last token before `j`, from `from`, that is not whitespace or (unless `ws`) a
   * comment.
   */
  const trimEnd = (from: number, j: number, ws = false) => {
    while (j > from && (ws ? kind(j - 1) === Tok.Ws : trivia(kind(j - 1)))) j--;
    return pos(j);
  };
  const rule = (kind: CssRule['kind'], start: number, name = ''): CssRule => ({
    kind,
    start,
    end: start,
    name,
    preludeStart: start,
    preludeEnd: start,
    blockStart: -1,
    blockEnd: -1,
    closed: true,
    decls: [],
    rules: [],
  });

  /** How many style rules the block being parsed is in. */
  let inStyle = 0;
  /** §5.5.4 consume a block, with `i` at `{`. */
  const block = (r: CssRule) => {
    r.blockStart = pos(i++);
    const style = r.kind === 'qualified';
    // Nested group rules hold declarations only in nested declarations rules (css-nesting §3.2).
    if (style) inStyle++;
    contents(r, !style && inStyle > 0);
    if (style) inStyle--;
    if (kind(i) === Tok.RBrace) i++;
    else r.closed = false;
    r.end = r.blockEnd = pos(i);
  };

  /** §5.5.2 consume an at-rule, with `i` at the at-keyword. */
  const atRule = (nested: boolean): CssRule => {
    const start = pos(i);
    const r = rule('at', start, text.slice(start + 1, pos(i + 1)));
    const from = ++i;
    for (;;) {
      const k = kind(i);
      if (k === Tok.Eof || k === Tok.Semi || k === Tok.LBrace || (k === Tok.RBrace && nested)) {
        r.preludeEnd = trimEnd(from, i);
        let j = from;
        while (trivia(kind(j))) j++;
        r.preludeStart = Math.min(pos(j), r.preludeEnd);
        if (k === Tok.LBrace) block(r);
        else {
          if (k === Tok.Semi) i++;
          r.end = k === Tok.Semi ? pos(i) : r.preludeEnd;
        }
        return r;
      }
      value();
    }
  };

  /** §5.5.3 consume a qualified rule, with `i` at its first token; null for nothing. */
  const qualified = (nested: boolean): CssRule | null => {
    const from = i;
    for (;;) {
      const k = kind(i);
      if (k === Tok.Eof || (nested && (k === Tok.Semi || k === Tok.RBrace))) return null;
      if (k === Tok.LBrace) {
        // A prelude that starts like a custom property declaration (`--x: {}`) makes no rule.
        const custom = kind(from) === Tok.Ident && text.startsWith('--', pos(from));
        let m = from + 1;
        while (trivia(kind(m))) m++;
        const r = rule('qualified', pos(from));
        r.preludeEnd = trimEnd(from, i);
        block(r);
        return custom && kind(m) === Tok.Colon ? null : r;
      }
      value();
    }
  };

  /** §5.5.6 consume a declaration, with `i` at its first token; null for nothing. */
  const declaration = (): CssDecl | null => {
    if (kind(i) !== Tok.Ident) return null;
    const start = pos(i);
    const nameEnd = pos(++i);
    while (trivia(kind(i))) i++;
    if (kind(i) !== Tok.Colon) return null;
    i++;
    while (trivia(kind(i))) i++;
    const from = i;
    let braces = 0;
    let other = 0;
    let last = -1;
    let prev = -1;
    for (;;) {
      const k = kind(i);
      if (k === Tok.Eof || k === Tok.Semi || k === Tok.RBrace) break;
      if (!trivia(k)) {
        prev = last;
        last = i;
        if (k === Tok.LBrace) braces++;
        else other++;
      }
      value();
    }
    // §5.5.6 step 7: a `{}` block in a value makes no declaration, but for a custom property's
    // value that is the block alone.
    if (braces && (!text.startsWith('--', start) || other)) return null;
    const important =
      prev >= 0 &&
      kind(prev) === Tok.Delim &&
      text[pos(prev)] === '!' &&
      kind(last) === Tok.Ident &&
      text.slice(pos(last), pos(last + 1)).toLowerCase() === 'important';
    // Like Chrome, comments at its end are part of the value.
    const valueEnd = trimEnd(from, important ? prev : i, true);
    const semicolon = kind(i) === Tok.Semi;
    const end = semicolon ? pos(++i) : trimEnd(from, i);
    return {
      kind: 'decl',
      start,
      end: Math.max(end, valueEnd, nameEnd),
      nameEnd,
      valueStart: Math.min(pos(from), valueEnd),
      valueEnd,
      important,
      semicolon,
    };
  };

  /** §5.5.5 consume a block's contents, with `i` past `{`, until (not past) `}`. */
  const contents = (r: CssRule, wrap = false) => {
    let decls = wrap ? [] : r.decls;
    let group: CssRule | undefined;
    const add = (d: CssDecl) => {
      if (decls !== r.decls && !group) {
        group = rule('nested', d.start);
        decls = group.decls;
        r.rules.push(group);
      }
      decls.push(d);
      if (group) group.end = d.end;
    };
    const nest = (child: CssRule) => {
      r.rules.push(child);
      decls = [];
      group = undefined;
    };
    for (;;) {
      const k = kind(i);
      if (k === Tok.Eof || k === Tok.RBrace) return;
      if (k === Tok.Comment) {
        const d = commented(text, pos(i), pos(i + 1));
        if (d) add(d);
        i++;
      } else if (k === Tok.Ws || k === Tok.Semi) i++;
      else if (k === Tok.At) nest(atRule(true));
      else {
        const mark = i;
        const d = declaration();
        if (d) add(d);
        else {
          i = mark;
          const q = qualified(true);
          if (q) nest(q);
        }
      }
    }
  };

  const top = rule('qualified', 0);
  if (inBlock) {
    contents(top);
    // A `}` with no `{` ends the contents: the text is not one block's contents.
    if (i < n) top.rules.push(rule('qualified', pos(i)));
    return top;
  }
  // §5.5.1 consume a stylesheet's contents. A stray `}` starts a qualified rule's prelude (§5.5.3).
  while (i < n) {
    const k = kind(i);
    if (trivia(k) || k === Tok.Cdo || k === Tok.Cdc) i++;
    else if (k === Tok.At) top.rules.push(atRule(false));
    else {
      const q = qualified(false);
      if (q) top.rules.push(q);
    }
  }
  return top;
}
