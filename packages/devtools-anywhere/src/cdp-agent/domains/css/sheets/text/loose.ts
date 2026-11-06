// Selectors loosened for pairing a sheet's text with its CSSOM rules (pair.ts): what the CSSOM
// writes otherwise than the text (whitespace, `::before` for `:before`, quoted attribute values,
// escapes) is written the same on both sides, so that a selector need not be parsed in a sheet of
// its own to be told the same as its rule's selectorText. What is not covered here still pairs,
// through that sheet. loose.test.ts holds the cases, measured in Chrome.
import { Tok, tokenize } from '../parse/css-lexer';

const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isNewline = (c: number) => c === 10 || c === 13 || c === 12;

/**
 * The code points `s` from `from` to `to` stands for, its escapes consumed as CSS Syntax §4.3.7
 * does; in a string, an escaped newline is dropped.
 */
function unescape(s: string, from: number, to: number): string {
  let out = '';
  for (let i = from; i < to;) {
    const c = s.charCodeAt(i);
    if (c !== 92 || i + 1 >= to) {
      // A backslash at the end of the text stands for U+FFFD.
      out += c === 92 ? '�' : s[i];
      i++;
      continue;
    }
    const n = s.charCodeAt(i + 1);
    if (isNewline(n)) {
      i += n === 13 && s.charCodeAt(i + 2) === 10 ? 3 : 2;
      continue;
    }
    if (!isHex(n)) {
      const cp = s.codePointAt(i + 1) as number;
      out += String.fromCodePoint(cp);
      i += cp > 0xffff ? 3 : 2;
      continue;
    }
    let j = i + 1;
    while (j < to && j < i + 7 && isHex(s.charCodeAt(j))) j++;
    const cp = parseInt(s.slice(i + 1, j), 16);
    out += String.fromCodePoint(cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp);
    // One whitespace after the hex digits ends the escape (CR LF as one).
    const w = s.charCodeAt(j);
    if (j < to && (w === 32 || w === 9 || isNewline(w))) j += w === 13 && s.charCodeAt(j + 1) === 10 ? 2 : 1;
    i = j;
  }
  return out;
}

const isControl = (c: number) => (c >= 1 && c <= 31) || c === 127;

/**
 * CSSOM §2.1 "serialize an identifier". `end` follows each hex escape: a space, as the CSSOM
 * writes it, or NUL (which nothing serialized holds), for a space of the text not to be taken for
 * one ending an escape (`.\31  a` is not `.\31 a`).
 */
export function serializeIdent(id: string, end = ' '): string {
  if (id === '-') return '\\-';
  let out = '';
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    if (c === 0) out += '�';
    else if (isControl(c) || (digit && (i === 0 || (i === 1 && id.charCodeAt(0) === 45))))
      out += `\\${c.toString(16)}${end}`;
    else if (c >= 128 || digit || c === 45 || c === 95 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) out += id[i];
    else out += `\\${id[i]}`;
  }
  return out;
}

/** CSSOM §2.1 "serialize a string"; `end` as for `serializeIdent`. */
export function serializeString(s: string, end = ' '): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) out += '�';
    else if (isControl(c)) out += `\\${c.toString(16)}${end}`;
    else if (c === 34 || c === 92) out += `\\${s[i]}`;
    else out += s[i];
  }
  return `${out}"`;
}

const lower = (s: string) => s.replace(/[A-Z]+/g, m => m.toLowerCase());

/**
 * `s` with its escapes written as the CSSOM serializes them (Chrome 157, measured): identifiers,
 * the names of hashes and at-keywords through "serialize an identifier", strings and an
 * attribute selector's value written as an identifier through "serialize a string". Pseudo-class
 * and pseudo-element names (`:\48 over`, `:\4e ot(`) are lowercased, and An+B in `:nth-*()` is
 * written as the CSSOM does (`2\6E + 1` and `odd` are `2n+1`). Comments are dropped.
 *
 * Left as they are, and paired through a sheet of their own: escapes in url() (no selector holds
 * one), in a number's unit out of `:nth-*()`, and a type selector's case (`\44 IV` is `div`).
 *
 * With `compact`, for comparing only: escapes end with NUL (`serializeIdent`), and whitespace is
 * kept as one space.
 */
export function reescape(s: string, compact = false): string {
  const { kinds, starts } = tokenize(s);
  const end = compact ? '\0' : ' ';
  let out = '';
  let afterEquals = false;
  let afterColon = false;
  let brackets = 0;
  // The depth of parentheses of an `:nth-*(` (0: none), whose whitespace is dropped.
  let parens = 0;
  let nth = 0;
  let nthStart = false;
  let nthOf = false;
  for (let t = 0; t < kinds.length; t++) {
    const kind = kinds[t] as number;
    const a = starts[t] as number;
    const b = starts[t + 1] as number;
    if (kind === Tok.Comment) continue;
    if (kind === Tok.Ws) {
      // In An+B, whitespace tells nothing (`2n + 1` is `2n+1`); compared only.
      if (!compact) out += s.slice(a, b);
      else if (!nth || nthOf) out += ' ';
      continue;
    }
    const raw = s.slice(a, b);
    if (kind === Tok.Ident) {
      const id = unescape(s, a, b);
      if (afterEquals && brackets) out += serializeString(id, end);
      else if (afterColon) out += serializeIdent(lower(id), end);
      else if (nth && !nthOf) {
        const l = lower(id);
        if (l === 'of') nthOf = true;
        out +=
          l === 'odd' ? '2n+1' : l === 'even' ? '2n' : l === 'of' ? (compact ? ' of ' : 'of') : serializeIdent(l, end);
      } else out += serializeIdent(id, end);
    } else if (kind === Tok.Str)
      out += serializeString(unescape(s, a + 1, s.charCodeAt(b - 1) === s.charCodeAt(a) && b - a > 1 ? b - 1 : b), end);
    else if (kind === Tok.Func) {
      const name = unescape(s, a, b - 1);
      out += `${afterColon ? serializeIdent(lower(name), end) : serializeIdent(name, end)}(`;
      parens++;
      if (afterColon && !nth && lower(name).startsWith('nth-')) {
        nth = parens;
        nthStart = true;
      }
    } else if (raw.includes('\\') && (kind === Tok.At || kind === Tok.Hash))
      out += raw[0] + serializeIdent(unescape(s, a + 1, b), end);
    else if (kind === Tok.Num && nth && !nthOf) {
      const n = lower(unescape(s, a, b));
      out += nthStart && n[0] === '+' ? n.slice(1) : n;
    } else {
      if (kind === Tok.LBracket) brackets++;
      else if (kind === Tok.RBracket && brackets) brackets--;
      else if (kind === Tok.LParen) parens++;
      else if (kind === Tok.RParen && parens) {
        if (parens === nth) {
          nth = 0;
          nthOf = false;
        }
        parens--;
      }
      out += raw;
    }
    nthStart = false;
    afterEquals = kind === Tok.Delim && raw === '=';
    afterColon = kind === Tok.Colon;
  }
  return out;
}

/** An at-rule's name as written (without `@`), its escapes consumed. */
export const atName = (name: string) => (name.includes('\\') ? unescape(name, 0, name.length) : name);

/**
 * Strings, which `CSSOM_WRITES` leaves as they are; a legacy pseudo-element, written with one
 * colon (not escaped, nor the second of two); an attribute selector's value written as an
 * identifier, with its modifier.
 */
const CSSOM_WRITES =
  /("(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*')|(?<![:\\]):(before|after|first-line|first-letter)(?![\w\\-])|\[\s*([-\w]+)\s*([~|^$*]?=)\s*(-?[_a-zA-Z][-\w]*)\s*(?:\s([iIsS]))?\s*\]/g;

/**
 * A selector as the CSSOM writes it back, where that is easily told: legacy pseudo-elements with
 * two colons (`::before` for `:before`), attribute values quoted (`[type="file"]`).
 */
const asCssomWrites = (s: string) =>
  !s.includes(':') && !s.includes('[')
    ? s
    : s.replace(CSSOM_WRITES, (all, str, pseudo, name, op, value, flag) =>
        str !== undefined
          ? all
          : pseudo !== undefined
            ? `::${(pseudo as string).toLowerCase()}`
            : `[${name}${op}"${value}"${flag ? ` ${(flag as string).toLowerCase()}` : ''}]`
      );

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
/** Code units whitespace after which tells nothing: `>`, `+`, `~`, `,`, `(`, `[`, `=`. */
const BEFORE = new Uint8Array(128);
/** And before which: `>`, `+`, `~`, `,`, `)`, `]`, `=`; `|^$*` when `=` follows. */
const AFTER = new Uint8Array(128);
for (const c of '>+~,([=') BEFORE[c.charCodeAt(0)] = 1;
for (const c of '>+~,)]=') AFTER[c.charCodeAt(0)] = 1;
for (const c of '|^$*') AFTER[c.charCodeAt(0)] = 2;

/**
 * Without the whitespace that tells nothing (Chrome writes `a > b`, `a, b`, `:is(a, b)`,
 * `[x="y"]`): around combinators other than the descendant one, commas and an attribute
 * selector's operator, inside parentheses and brackets, at the ends; strings kept as they are.
 * What is left is one space: a descendant combinator (`a b`, `:is(a) b`, `a [x]`, `a *`), not to
 * be dropped. One pass over the code units: regular expressions took about twice the time.
 */
function spaces(s: string): string {
  let out = '';
  let from = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 39) {
      // A string, kept as it is.
      for (i++; i < n && s.charCodeAt(i) !== c; i++) if (s.charCodeAt(i) === 92) i++;
      continue;
    }
    if (!isSpace(c)) continue;
    let j = i + 1;
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    out += s.slice(from, i);
    from = j;
    const prev = out.charCodeAt(out.length - 1);
    const next = s.charCodeAt(j);
    const kind = next < 128 ? AFTER[next] : 0;
    if (out && j < n && !(prev < 128 && BEFORE[prev]) && !(kind === 1 || (kind === 2 && s.charCodeAt(j + 1) === 61)))
      out += ' ';
    i = j - 1;
  }
  return from ? out + s.slice(from) : s;
}

/** The `&` a selector of a list starts with, before a combinator (`& a`, `& > a`) or alone. */
const LEADING_NEST = /(^|,)&(?: |(?=[>+~,])|$)/g;

/**
 * Without comments and the whitespace that tells nothing (`spaces`), and the `&` each selector of
 * a list may start with: the CSSOM adds one to every relative selector (`a, img` in a style rule
 * is `& a, & img`, `> a` is `& > a`). What the CSSOM writes otherwise and `asCssomWrites` or, for
 * a text with a backslash, `reescape` tells is written as the CSSOM does.
 */
export function loose(s: string): string {
  const t = spaces(asCssomWrites(s.includes('\\') ? reescape(s, true) : s.includes('/*') ? stripComments(s) : s));
  return t.includes('&') ? t.replace(LEADING_NEST, '$1') : t;
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?(\*\/|$)/g, '');
