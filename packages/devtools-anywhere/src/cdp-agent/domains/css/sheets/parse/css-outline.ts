/**
 * The outline of a style sheet's text: where each rule, its prelude and block, and each
 * declaration lie, built on css-lexer.ts by the parsing algorithms of CSS Syntax Level 3 §5.5
 * (https://drafts.csswg.org/css-syntax-3/#consume-stylesheet-contents), including their error
 * recovery and CSS nesting, so the rules found line up with the ones CSSOM keeps. What the
 * algorithms leave to grammars is not checked: a rule with an invalid selector or prelude, a
 * declaration of an unknown property or with an invalid value are kept here though CSSOM drops them.
 *
 * Offsets are UTF-16 code units. Ranges are half-open, `[start, end)`.
 *
 * The outline is two tables of fixed-width records in typed arrays, one of rules and one of
 * declarations: a sheet of 60,000 rules is a few arrays rather than hundreds of thousands of
 * objects, which the garbage collector would trace for as long as the sheet's text is kept. A rule
 * or a declaration is the index of its record, read through the methods of `CssOutline`.
 *
 * Rules are recorded in the order they start (pre-order), from rule 0, `ROOT`: the style sheet
 * (the block, for a comment's text), whose children are the top-level rules. A rule links to its
 * first child and to its next sibling. Its own declarations are a run of the declaration table:
 * they are all recorded before any rule in it is parsed. An at-rule's name is not cut out of the
 * text: its record has where it ends.
 */
import { Tok, tokenize, type TokKind } from './css-lexer-wasm';

const R_FLAGS = 0;
const R_START = 1;
const R_END = 2;
/** At-rules: the end of the name; it starts past `@`. */
const R_NAME_END = 3;
const R_PRELUDE_START = 4;
const R_PRELUDE_END = 5;
const R_BLOCK_START = 6;
const R_BLOCK_END = 7;
/** The first of the rule's own declarations, and how many. */
const R_DECLS = 8;
const R_DECL_COUNT = 9;
/** The first child and the next sibling, or -1. */
const R_CHILD = 10;
const R_NEXT = 11;
/** Int32 fields per rule. */
const RW = 12;

const D_FLAGS = 0;
const D_START = 1;
const D_END = 2;
const D_NAME_END = 3;
const D_VALUE_START = 4;
const D_VALUE_END = 5;
/** Int32 fields per declaration. */
const DW = 6;

/** A rule's flags: its kind in the low bits, and whether its block is unclosed. */
const KIND_MASK = 3;
const UNCLOSED = 4;
const QUALIFIED = 0;
const AT = 1;
const NESTED = 2;
/** A declaration's flags. */
const COMMENT = 1;
const IMPORTANT = 2;
const SEMICOLON = 4;

/** `nested`: a run of declarations after a nested rule (CSSNestedDeclarations). */
export type RuleKind = 'qualified' | 'at' | 'nested';
const KINDS: readonly RuleKind[] = ['qualified', 'at', 'nested'];

/** The root rule: the style sheet, whose children are the top-level rules. */
export const ROOT = 0;

const grown = (a: Int32Array, need: number): Int32Array => {
  if (need <= a.length) return a;
  const b = new Int32Array(Math.max(need, a.length * 2));
  b.set(a);
  return b;
};
const bump = (a: Int32Array, i: number, delta: number) => {
  a[i] = (a[i] as number) + delta;
};

/** The rules and declarations of a text, by index (see above). */
export class CssOutline {
  rules: Int32Array;
  decls: Int32Array;
  ruleCount = 0;
  declCount = 0;
  /** Rules no longer reachable, left behind by `graft`. */
  dead = 0;

  constructor(rules: number, decls: number) {
    this.rules = new Int32Array(rules * RW);
    this.decls = new Int32Array(decls * DW);
  }

  private r(r: number, field: number): number {
    return this.rules[r * RW + field] as number;
  }
  private d(d: number, field: number): number {
    return this.decls[d * DW + field] as number;
  }

  // Rules.

  kind(r: number): RuleKind {
    return KINDS[this.r(r, R_FLAGS) & KIND_MASK] as RuleKind;
  }
  start(r: number): number {
    return this.r(r, R_START);
  }
  end(r: number): number {
    return this.r(r, R_END);
  }
  /** At-rules: the name without `@`, as written (a string made when asked); '' for others. */
  name(text: string, r: number): string {
    return this.kind(r) === 'at' ? text.slice(this.start(r) + 1, this.r(r, R_NAME_END)) : '';
  }
  /** The selector or at-rule prelude, trimmed of whitespace and comments. */
  preludeStart(r: number): number {
    return this.r(r, R_PRELUDE_START);
  }
  preludeEnd(r: number): number {
    return this.r(r, R_PRELUDE_END);
  }
  /** From `{` to past `}` (or the end of the text); -1 without a block. */
  blockStart(r: number): number {
    return this.r(r, R_BLOCK_START);
  }
  blockEnd(r: number): number {
    return this.r(r, R_BLOCK_END);
  }
  /** False when the text ends before the block's `}`. */
  closed(r: number): boolean {
    return !(this.r(r, R_FLAGS) & UNCLOSED);
  }
  /**
   * The first of the declarations before the first nested rule (all of them, for `nested`), which
   * follow each other (`declCountOf`). Group rules in style rules (`a { @media x { color: red } }`)
   * have none: theirs are in `nested` rules.
   */
  firstDecl(r: number): number {
    return this.r(r, R_DECLS);
  }
  declCountOf(r: number): number {
    return this.r(r, R_DECL_COUNT);
  }
  /** The last of the rule's own declarations, or -1. */
  lastDecl(r: number): number {
    const n = this.declCountOf(r);
    return n ? this.firstDecl(r) + n - 1 : -1;
  }
  /** The first of the nested rules and the runs of declarations between and after them; -1 for none. */
  firstChild(r: number): number {
    return this.r(r, R_CHILD);
  }
  /** The rule after `r` in its parent, or -1. */
  next(r: number): number {
    return this.r(r, R_NEXT);
  }

  // Declarations.

  /** A comment in a block whose text is one declaration (a disabled property). */
  commented(d: number): boolean {
    return !!(this.d(d, D_FLAGS) & COMMENT);
  }
  /** From the name to the end of the value, or past the `;` that ends it. */
  declStart(d: number): number {
    return this.d(d, D_START);
  }
  declEnd(d: number): number {
    return this.d(d, D_END);
  }
  nameEnd(d: number): number {
    return this.d(d, D_NAME_END);
  }
  /** Leading whitespace and comments and trailing whitespace trimmed, `!important` excluded. */
  valueStart(d: number): number {
    return this.d(d, D_VALUE_START);
  }
  valueEnd(d: number): number {
    return this.d(d, D_VALUE_END);
  }
  important(d: number): boolean {
    return !!(this.d(d, D_FLAGS) & IMPORTANT);
  }
  /** Ended by `;`, rather than by `}`, the end of the text or the comment. */
  semicolon(d: number): boolean {
    return !!(this.d(d, D_FLAGS) & SEMICOLON);
  }

  // Building and moving.

  /** A new rule of `kind` (`QUALIFIED`…) at `start`, empty, without a block. */
  addRule(kind: number, start: number): number {
    const r = this.ruleCount++;
    const a = (this.rules = grown(this.rules, this.ruleCount * RW));
    const at = r * RW;
    a[at + R_FLAGS] = kind;
    a[at + R_START] = a[at + R_END] = a[at + R_NAME_END] = start;
    a[at + R_PRELUDE_START] = a[at + R_PRELUDE_END] = start;
    a[at + R_BLOCK_START] = a[at + R_BLOCK_END] = -1;
    a[at + R_DECLS] = this.declCount;
    a[at + R_DECL_COUNT] = 0;
    a[at + R_CHILD] = a[at + R_NEXT] = -1;
    return r;
  }
  /** Sets field `field` (`R_…`) of rule `r`. */
  set(r: number, field: number, value: number): void {
    this.rules[r * RW + field] = value;
  }
  /** Appends a declaration to `r`'s own, which must be the last recorded. */
  addDecl(r: number, flags: number, start: number, end: number, nameEnd: number, valueStart: number, valueEnd: number) {
    const d = this.declCount++;
    const a = (this.decls = grown(this.decls, this.declCount * DW));
    const at = d * DW;
    a[at + D_FLAGS] = flags;
    a[at + D_START] = start;
    a[at + D_END] = end;
    a[at + D_NAME_END] = nameEnd;
    a[at + D_VALUE_START] = valueStart;
    a[at + D_VALUE_END] = valueEnd;
    bump(this.rules, r * RW + R_DECL_COUNT, 1);
  }
  /** Forgets rule `r` and all recorded since: one parsed but not kept, with what is in it. */
  dropFrom(r: number): void {
    this.declCount = this.firstDecl(r);
    this.ruleCount = r;
  }
  /** Cuts the tables to what they hold, when much bigger. */
  trim(): this {
    const rules = this.ruleCount * RW;
    const decls = this.declCount * DW;
    if (this.rules.length > rules + (rules >> 3) + RW) this.rules = this.rules.slice(0, rules);
    if (this.decls.length > decls + (decls >> 3) + DW) this.decls = this.decls.slice(0, decls);
    return this;
  }

  /** Moves rule `r`, its declarations and the rules in it by `delta`. */
  shift(r: number, delta: number): void {
    const a = this.rules;
    const at = r * RW;
    bump(a, at + R_START, delta);
    bump(a, at + R_END, delta);
    bump(a, at + R_NAME_END, delta);
    bump(a, at + R_PRELUDE_START, delta);
    bump(a, at + R_PRELUDE_END, delta);
    if ((a[at + R_BLOCK_START] as number) >= 0) {
      bump(a, at + R_BLOCK_START, delta);
      bump(a, at + R_BLOCK_END, delta);
    }
    const d = this.decls;
    for (let i = this.firstDecl(r) * DW, e = i + this.declCountOf(r) * DW; i < e; i += DW) {
      bump(d, i + D_START, delta);
      bump(d, i + D_END, delta);
      bump(d, i + D_NAME_END, delta);
      bump(d, i + D_VALUE_START, delta);
      bump(d, i + D_VALUE_END, delta);
    }
    for (let c = this.firstChild(r); c >= 0; c = this.next(c)) this.shift(c, delta);
  }

  /** How many rules `r` is, with those in it. */
  size(r: number): number {
    let n = 1;
    for (let c = this.firstChild(r); c >= 0; c = this.next(c)) n += this.size(c);
    return n;
  }

  /**
   * Copies top-level rule `r` of `from` and the top-level rules after it, with what is in them, to
   * the end of this outline, moved by `delta`, and returns the copy of `r`: the copies link to each
   * other as siblings, the last to none. Nothing links to them: the caller refers to them in place
   * of the rules they replace, whose records are left where they are, unreachable (and counted in
   * `dead` by the caller).
   */
  graft(from: CssOutline, r: number, delta: number): number {
    // In pre-order, the last top-level rules and those in them are the last records, from `r` on;
    // and so are their declarations.
    const firstDecl = from.firstDecl(r);
    const rules = from.ruleCount - r;
    const decls = from.declCount - firstDecl;
    const base = this.ruleCount - r;
    const dbase = this.declCount - firstDecl;
    this.rules = grown(this.rules, (this.ruleCount + rules) * RW);
    this.decls = grown(this.decls, (this.declCount + decls) * DW);
    this.rules.set(from.rules.subarray(r * RW, from.ruleCount * RW), this.ruleCount * RW);
    this.decls.set(from.decls.subarray(firstDecl * DW, from.declCount * DW), this.declCount * DW);
    const a = this.rules;
    for (let at = this.ruleCount * RW, e = at + rules * RW; at < e; at += RW) {
      bump(a, at + R_DECLS, dbase);
      if ((a[at + R_CHILD] as number) >= 0) bump(a, at + R_CHILD, base);
      if ((a[at + R_NEXT] as number) >= 0) bump(a, at + R_NEXT, base);
    }
    this.ruleCount += rules;
    this.declCount += decls;
    const copy = r + base;
    for (let c = copy; c >= 0; c = this.next(c)) this.shift(c, delta);
    return copy;
  }
}

/**
 * Whether the ident token `text.slice(at, end)` starts with two `-` once escapes are decoded, as
 * a custom property's name does: `--x`, but also `\2d-x` or `\-\-x`, which Chrome takes for one.
 */
export function dashed(text: string, at: number, end: number): boolean {
  let p = at;
  for (let n = 0; n < 2; n++) {
    if (p >= end) return false;
    const c = text.charCodeAt(p++);
    if (c === 45) continue;
    if (c !== 92 || p >= end) return false;
    let v = 0;
    let h = 0;
    for (; h < 6 && p < end; h++, p++) {
      const d = text.charCodeAt(p);
      const x = d >= 48 && d <= 57 ? d - 48 : (d | 32) >= 97 && (d | 32) <= 102 ? (d | 32) - 87 : -1;
      if (x < 0) break;
      v = v * 16 + x;
    }
    if (!h) {
      if (text.charCodeAt(p++) !== 45) return false;
      continue;
    }
    if (v !== 45) return false;
    // One whitespace after the digits is part of the escape (CR LF as one).
    const w = text.charCodeAt(p);
    if (p < end && (w === 32 || w === 9 || w === 10 || w === 12 || w === 13))
      p += w === 13 && text.charCodeAt(p + 1) === 10 ? 2 : 1;
  }
  return true;
}

/** The top-level rules of `o`, in order. */
export function topRules(o: CssOutline): number[] {
  const list: number[] = [];
  for (let r = o.firstChild(ROOT); r >= 0; r = o.next(r)) list.push(r);
  return list;
}

/** A declaration as an object (`outlineTree`). */
export interface CssDecl {
  kind: 'decl' | 'comment';
  start: number;
  end: number;
  nameEnd: number;
  valueStart: number;
  valueEnd: number;
  important: boolean;
  semicolon: boolean;
}

/** A rule as an object (`outlineTree`), with what `CssOutline` tells of it. */
export interface CssRule {
  kind: RuleKind;
  start: number;
  end: number;
  name: string;
  preludeStart: number;
  preludeEnd: number;
  blockStart: number;
  blockEnd: number;
  closed: boolean;
  decls: CssDecl[];
  rules: CssRule[];
}

/**
 * Rule `r` of `o` and what is in it as objects. For tests and debugging only: the agent reads the
 * tables, and makes no such object.
 */
export function ruleObject(text: string, o: CssOutline, r: number): CssRule {
  const decls: CssDecl[] = [];
  for (let d = o.firstDecl(r), e = d + o.declCountOf(r); d < e; d++)
    decls.push({
      kind: o.commented(d) ? 'comment' : 'decl',
      start: o.declStart(d),
      end: o.declEnd(d),
      nameEnd: o.nameEnd(d),
      valueStart: o.valueStart(d),
      valueEnd: o.valueEnd(d),
      important: o.important(d),
      semicolon: o.semicolon(d),
    });
  const rules: CssRule[] = [];
  for (let c = o.firstChild(r); c >= 0; c = o.next(c)) rules.push(ruleObject(text, o, c));
  return {
    kind: o.kind(r),
    start: o.start(r),
    end: o.end(r),
    name: o.name(text, r),
    preludeStart: o.preludeStart(r),
    preludeEnd: o.preludeEnd(r),
    blockStart: o.blockStart(r),
    blockEnd: o.blockEnd(r),
    closed: o.closed(r),
    decls,
    rules,
  };
}

/** The top-level rules of `text` as objects (`ruleObject`): for tests and debugging only. */
export function outlineTree(text: string): CssRule[] {
  const o = outline(text);
  return topRules(o).map(r => ruleObject(text, o, r));
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

/** The rules of a style sheet's text (§5.4.1 "parse a stylesheet"): the top-level ones are `ROOT`'s children. */
export function outline(text: string): CssOutline {
  return parse(text, false).trim();
}

/**
 * The outlines comments are parsed into, one per depth (a comment's text may hold an unclosed
 * one): reused, as making typed arrays for each comment costs more than parsing it.
 */
const scratch: CssOutline[] = [];
let depth = 0;

/**
 * The outline of the declaration a comment from `start` to `end` holds, as DevTools shows disabled
 * properties: the comment's text is one declaration (`ROOT`'s only one, the first recorded, its
 * offsets in the comment's text from past `/*`), its `;` optional, and whitespace. The outline is
 * reused by the next comment's: what is needed of it is to be read first.
 */
function commented(text: string, start: number, end: number): CssOutline | null {
  // No declaration without a colon: most comments need no parsing.
  const colon = text.indexOf(':', start + 2);
  if (colon < 0 || colon >= end) return null;
  const inner = text.slice(start + 2, text.endsWith('*/', end) && end - start >= 4 ? end - 2 : end);
  const o = (scratch[depth] ??= new CssOutline(4, 4));
  depth++;
  try {
    parse(inner, true, o);
  } finally {
    depth--;
  }
  if (o.declCountOf(ROOT) !== 1 || o.firstChild(ROOT) >= 0) return null;
  const d = o.firstDecl(ROOT);
  return inner.slice(0, o.declStart(d)).trim() || inner.slice(o.declEnd(d)).trim() ? null : o;
}

/**
 * The rules of `text` as a style sheet, or with `inBlock`, its contents as a block's (`ROOT`'s);
 * into `into`, emptied, when given.
 */
function parse(text: string, inBlock: boolean, into?: CssOutline): CssOutline {
  const { kinds, starts } = tokenize(text);
  const n = kinds.length;
  const kind = (j: number): TokKind => kinds[j] ?? Tok.Eof;
  const pos = (j: number) => starts[j] ?? text.length;
  let i = 0;
  // About a rule every 13 tokens, a declaration every 8: grown as needed, trimmed at the end.
  const o = into ?? new CssOutline((n >> 4) + (n >> 6) + 4, (n >> 3) + 4);
  o.ruleCount = o.declCount = o.dead = 0;

  /** §5.5.9 consume a component value: past a whole block or function. */
  const value = () => {
    const c = closer(kind(i++));
    if (c === undefined) return;
    const stack = [c];
    while (i < n && stack.length) {
      const k = kind(i++);
      if (k === stack[stack.length - 1]) stack.pop();
      else {
        const inner = closer(k);
        if (inner !== undefined) stack.push(inner);
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

  /** How many style rules the block being parsed is in. */
  let inStyle = 0;
  /** §5.5.4 consume a block, with `i` at `{`, of rule `r` of kind `k`. */
  const block = (r: number, k: number) => {
    o.set(r, R_BLOCK_START, pos(i++));
    const style = k === QUALIFIED;
    // Nested group rules hold declarations only in nested declarations rules (css-nesting §3.2).
    if (style) inStyle++;
    contents(r, !style && inStyle > 0);
    if (style) inStyle--;
    if (kind(i) === Tok.RBrace) i++;
    else o.set(r, R_FLAGS, k | UNCLOSED);
    o.set(r, R_END, pos(i));
    o.set(r, R_BLOCK_END, pos(i));
  };

  /** §5.5.2 consume an at-rule, with `i` at the at-keyword. */
  const atRule = (nested: boolean): number => {
    const r = o.addRule(AT, pos(i));
    o.set(r, R_NAME_END, pos(i + 1));
    const from = ++i;
    for (;;) {
      const k = kind(i);
      if (k === Tok.Eof || k === Tok.Semi || k === Tok.LBrace || (k === Tok.RBrace && nested)) {
        const preludeEnd = trimEnd(from, i);
        let j = from;
        while (trivia(kind(j))) j++;
        o.set(r, R_PRELUDE_END, preludeEnd);
        o.set(r, R_PRELUDE_START, Math.min(pos(j), preludeEnd));
        if (k === Tok.LBrace) block(r, AT);
        else {
          if (k === Tok.Semi) i++;
          o.set(r, R_END, k === Tok.Semi ? pos(i) : preludeEnd);
        }
        return r;
      }
      value();
    }
  };

  /** §5.5.3 consume a qualified rule, with `i` at its first token; -1 for nothing. */
  const qualified = (nested: boolean): number => {
    const from = i;
    for (;;) {
      const k = kind(i);
      if (k === Tok.Eof || (nested && (k === Tok.Semi || k === Tok.RBrace))) return -1;
      if (k === Tok.LBrace) {
        // A prelude that starts like a custom property declaration (`--x: {}`) makes no rule.
        const custom = kind(from) === Tok.Ident && dashed(text, pos(from), pos(from + 1));
        let m = from + 1;
        while (trivia(kind(m))) m++;
        const r = o.addRule(QUALIFIED, pos(from));
        o.set(r, R_PRELUDE_END, trimEnd(from, i));
        block(r, QUALIFIED);
        if (!custom || kind(m) !== Tok.Colon) return r;
        // Not kept: it is the last rule recorded, with what is in it.
        o.dropFrom(r);
        return -1;
      }
      value();
    }
  };

  // The declaration `declaration` found, rather than an object for it.
  let dFlags = 0;
  let dStart = 0;
  let dEnd = 0;
  let dNameEnd = 0;
  let dValueStart = 0;
  let dValueEnd = 0;
  /** §5.5.6 consume a declaration, with `i` at its first token; false for nothing. */
  const declaration = (): boolean => {
    if (kind(i) !== Tok.Ident) return false;
    const start = pos(i);
    const nameEnd = pos(++i);
    while (trivia(kind(i))) i++;
    if (kind(i) !== Tok.Colon) return false;
    i++;
    while (trivia(kind(i))) i++;
    const from = i;
    // §5.5.6 step 7: a `{}` block in a value makes no declaration, except in a custom property's,
    // where like Chrome any `{}` blocks may sit among other tokens (`--x: {} b { c: d } e`). Any
    // other's is given up at its `{`, not past the block: a rule like `a:hover {}` is parsed again
    // from its start, and scanning on to the end of the parent's block would make a block of such
    // rules quadratic.
    const custom = dashed(text, start, nameEnd);
    let last = -1;
    let prev = -1;
    for (;;) {
      const k = kind(i);
      if (k === Tok.Eof || k === Tok.Semi || k === Tok.RBrace) break;
      if (!trivia(k)) {
        if (k === Tok.LBrace && !custom) return false;
        prev = last;
        last = i;
      }
      value();
    }
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
    dFlags = (important ? IMPORTANT : 0) | (semicolon ? SEMICOLON : 0);
    dStart = start;
    dEnd = Math.max(end, valueEnd, nameEnd);
    dNameEnd = nameEnd;
    dValueStart = Math.min(pos(from), valueEnd);
    dValueEnd = valueEnd;
    return true;
  };

  /**
   * §5.5.5 consume a block's contents, with `i` past `{`, until (not past) `}`, into rule `r`; with
   * `wrap`, declarations go to `nested` rules only. Returns the last rule in it, or -1.
   */
  const contents = (r: number, wrap: boolean): number => {
    /** Whether declarations are still `r`'s own: until the first nested rule. */
    let own = !wrap;
    let group = -1;
    let last = -1;
    const link = (child: number) => {
      if (last < 0) o.set(r, R_CHILD, child);
      else o.set(last, R_NEXT, child);
      last = child;
    };
    const add = () => {
      if (!own && group < 0) {
        group = o.addRule(NESTED, dStart);
        link(group);
      }
      o.addDecl(own ? r : group, dFlags, dStart, dEnd, dNameEnd, dValueStart, dValueEnd);
      if (group >= 0) o.set(group, R_END, dEnd);
    };
    const nest = (child: number) => {
      link(child);
      own = false;
      group = -1;
    };
    for (;;) {
      const k = kind(i);
      if (k === Tok.Eof || k === Tok.RBrace) return last;
      if (k === Tok.Comment) {
        const at = pos(i);
        const c = commented(text, at, pos(i + 1));
        if (c) {
          const d = c.firstDecl(ROOT);
          const from = at + 2;
          dFlags = COMMENT | (c.important(d) ? IMPORTANT : 0) | (c.semicolon(d) ? SEMICOLON : 0);
          dStart = c.declStart(d) + from;
          dEnd = c.declEnd(d) + from;
          dNameEnd = c.nameEnd(d) + from;
          dValueStart = c.valueStart(d) + from;
          dValueEnd = c.valueEnd(d) + from;
          add();
        }
        i++;
      } else if (k === Tok.Ws || k === Tok.Semi) i++;
      else if (k === Tok.At) nest(atRule(true));
      else {
        const mark = i;
        if (declaration()) add();
        else {
          i = mark;
          const q = qualified(true);
          if (q >= 0) nest(q);
        }
      }
    }
  };

  o.addRule(QUALIFIED, 0);
  if (inBlock) {
    const last = contents(ROOT, false);
    // A `}` with no `{` ends the contents: the text is not one block's contents.
    if (i < n) {
      const stray = o.addRule(QUALIFIED, pos(i));
      o.set(last < 0 ? ROOT : last, last < 0 ? R_CHILD : R_NEXT, stray);
    }
    return o;
  }
  // §5.5.1 consume a stylesheet's contents. A stray `}` starts a qualified rule's prelude (§5.5.3).
  let last = -1;
  while (i < n) {
    const k = kind(i);
    let r = -1;
    if (trivia(k) || k === Tok.Cdo || k === Tok.Cdc) i++;
    else if (k === Tok.At) r = atRule(false);
    else r = qualified(false);
    if (r >= 0) {
      o.set(last < 0 ? ROOT : last, last < 0 ? R_CHILD : R_NEXT, r);
      last = r;
    }
  }
  return o;
}
