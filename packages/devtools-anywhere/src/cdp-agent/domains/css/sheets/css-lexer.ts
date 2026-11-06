/**
 * A CSS tokenizer after CSS Syntax Level 3 §4 (https://drafts.csswg.org/css-syntax-3/#tokenization),
 * cut down to what finding the edges of rules and declarations needs: token kinds and offsets, no
 * values. Offsets are UTF-16 code units in the original text; the preprocessing of §3.3 (CR LF, CR
 * and FF as newlines, NUL) is applied while scanning, not to a copy. Comments, which the
 * specification drops, are kept as tokens so a caller can find disabled declarations in them.
 *
 * Tokens are contiguous: token `i` covers `starts[i]` to `starts[i + 1]`, and `starts` ends with
 * the text's length.
 */

/** Token kinds. Numbers and percentages are folded into `Num`, as are dimensions. */
export const Tok = {
  Ws: 0,
  Comment: 1,
  Str: 2,
  BadStr: 3,
  Url: 4,
  BadUrl: 5,
  At: 6,
  Ident: 7,
  Func: 8,
  Hash: 9,
  Num: 10,
  Delim: 11,
  Colon: 12,
  Semi: 13,
  Comma: 14,
  LBracket: 15,
  RBracket: 16,
  LParen: 17,
  RParen: 18,
  LBrace: 19,
  RBrace: 20,
  Cdo: 21,
  Cdc: 22,
  /** Returned past the last token. */
  Eof: 23,
} as const;
export type TokKind = (typeof Tok)[keyof typeof Tok];

export interface Tokens {
  kinds: TokKind[];
  /** One more than `kinds`: the last entry is the end of the text. */
  starts: number[];
}

const isNewline = (c: number) => c === 10 || c === 13 || c === 12;
const isWs = (c: number) => c === 32 || c === 9 || isNewline(c);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
const isName = (c: number) => isNameStart(c) || isDigit(c) || c === 45;
const isNonPrintable = (c: number) => c <= 8 || c === 11 || (c >= 14 && c <= 31) || c === 127;

/** Character classes of ASCII code points, for dispatching on a token's first character. */
const C = {
  Other: 0,
  Ws: 1,
  Quote: 2,
  Digit: 3,
  NameStart: 4,
  Plus: 5,
  Dot: 6,
  Minus: 7,
  Backslash: 8,
  Slash: 9,
  At: 10,
  Hash: 11,
  Lt: 12,
} as const;
const charClass = new Uint8Array(128);
for (let c = 0; c < 128; c++)
  charClass[c] = isWs(c)
    ? C.Ws
    : c === 34 || c === 39
      ? C.Quote
      : isDigit(c)
        ? C.Digit
        : isNameStart(c)
          ? C.NameStart
          : ((
              {
                43: C.Plus,
                46: C.Dot,
                45: C.Minus,
                92: C.Backslash,
                47: C.Slash,
                64: C.At,
                35: C.Hash,
                60: C.Lt,
              } as Record<number, number>
            )[c] ?? C.Other);

/** The kinds of single-character tokens by code point, `Delim` for the rest of ASCII. */
const single = new Uint8Array(128).fill(Tok.Delim);
single[40] = Tok.LParen;
single[41] = Tok.RParen;
single[44] = Tok.Comma;
single[58] = Tok.Colon;
single[59] = Tok.Semi;
single[91] = Tok.LBracket;
single[93] = Tok.RBracket;
single[123] = Tok.LBrace;
single[125] = Tok.RBrace;

/** Tokenizes `text`. */
export function tokenize(text: string): Tokens {
  const len = text.length;
  const at = (p: number) => text.charCodeAt(p); // NaN past the end: no predicate matches
  let p = 0;
  // §4.3.8 – §4.3.10
  const validEscape = (q: number) => at(q) === 92 && !isNewline(at(q + 1));
  const identStart = (q: number) => {
    const c = at(q);
    if (c === 45) return isNameStart(at(q + 1)) || at(q + 1) === 45 || validEscape(q + 1);
    return isNameStart(c) || validEscape(q);
  };
  const numberStart = (q: number) => {
    let c = at(q);
    if (c === 43 || c === 45) c = at(++q);
    return isDigit(c) || (c === 46 && isDigit(at(q + 1)));
  };
  /** §4.3.7, with `p` just past the backslash. */
  const escape = () => {
    if (!isHex(at(p))) {
      if (p < len) p++;
      return;
    }
    for (let n = 0; n < 6 && isHex(at(p)); n++) p++;
    if (at(p) === 13 && at(p + 1) === 10) p += 2;
    else if (isWs(at(p))) p++;
  };
  /** §4.3.12 */
  const name = () => {
    for (;;) {
      if (isName(at(p))) p++;
      else if (validEscape(p)) {
        p++;
        escape();
      } else return;
    }
  };
  /** §4.3.14 */
  const badUrl = () => {
    while (p < len) {
      if (at(p) === 41) {
        p++;
        return;
      }
      if (validEscape(p)) {
        p++;
        escape();
      } else p++;
    }
  };
  /** §4.3.6, with `p` just past `url(` and its leading whitespace. */
  const url = (): TokKind => {
    for (;;) {
      const c = at(p);
      if (p >= len) return Tok.Url;
      if (c === 41) {
        p++;
        return Tok.Url;
      }
      if (isWs(c)) {
        while (isWs(at(p))) p++;
        if (p >= len) return Tok.Url;
        if (at(p) === 41) {
          p++;
          return Tok.Url;
        }
        badUrl();
        return Tok.BadUrl;
      }
      if (c === 34 || c === 39 || c === 40 || isNonPrintable(c)) {
        badUrl();
        return Tok.BadUrl;
      }
      if (c === 92) {
        if (!validEscape(p)) {
          badUrl();
          return Tok.BadUrl;
        }
        p++;
        escape();
      } else p++;
    }
  };
  /** §4.3.4, with `p` at the start of the name. */
  const identLike = (): TokKind => {
    const s = p;
    name();
    if (at(p) !== 40) return Tok.Ident;
    p++;
    if (p - s !== 4 || text.slice(s, s + 3).toLowerCase() !== 'url') return Tok.Func;
    while (isWs(at(p)) && isWs(at(p + 1))) p++;
    const q = isWs(at(p)) ? p + 1 : p;
    if (at(q) === 34 || at(q) === 39) return Tok.Func;
    while (isWs(at(p))) p++;
    return url();
  };
  /** §4.3.5, with `p` just past the opening quote. */
  const string = (quote: number): TokKind => {
    for (;;) {
      const c = at(p);
      if (p >= len) return Tok.Str;
      if (c === quote) {
        p++;
        return Tok.Str;
      }
      if (isNewline(c)) return Tok.BadStr;
      p++;
      if (c === 92 && p < len) {
        if (at(p) === 13 && at(p + 1) === 10) p += 2;
        else if (isNewline(at(p))) p++;
        else escape();
      }
    }
  };
  /** §4.3.3, with `p` at the start of the number. */
  const numeric = () => {
    if (at(p) === 43 || at(p) === 45) p++;
    while (isDigit(at(p))) p++;
    if (at(p) === 46 && isDigit(at(p + 1))) for (p++; isDigit(at(p));) p++;
    const e = at(p);
    if (e === 69 || e === 101) {
      const s = at(p + 1) === 43 || at(p + 1) === 45 ? 2 : 1;
      if (isDigit(at(p + s))) for (p += s; isDigit(at(p));) p++;
    }
    if (identStart(p)) name();
    else if (at(p) === 37) p++;
  };
  const kinds: TokKind[] = [];
  const starts: number[] = [];
  while (p < len) {
    const s = p;
    const c = at(p);
    let k: TokKind;
    switch (c < 128 ? charClass[c] : C.NameStart) {
      case C.Ws:
        while (isWs(at(++p)));
        k = Tok.Ws;
        break;
      case C.Quote:
        p++;
        k = string(c);
        break;
      case C.Digit:
        numeric();
        k = Tok.Num;
        break;
      case C.NameStart:
        k = identLike();
        break;
      case C.Plus:
      case C.Dot:
        if (numberStart(p)) {
          numeric();
          k = Tok.Num;
        } else {
          p++;
          k = Tok.Delim;
        }
        break;
      case C.Minus:
        if (numberStart(p)) {
          numeric();
          k = Tok.Num;
        } else if (at(p + 1) === 45 && at(p + 2) === 62) {
          p += 3;
          k = Tok.Cdc;
        } else if (identStart(p)) k = identLike();
        else {
          p++;
          k = Tok.Delim;
        }
        break;
      case C.Backslash:
        if (validEscape(p)) k = identLike();
        else {
          p++;
          k = Tok.Delim;
        }
        break;
      case C.Slash:
        if (at(p + 1) === 42) {
          const e = text.indexOf('*/', p + 2);
          p = e < 0 ? len : e + 2;
          k = Tok.Comment;
        } else {
          p++;
          k = Tok.Delim;
        }
        break;
      case C.At:
        p++;
        if (identStart(p)) {
          name();
          k = Tok.At;
        } else k = Tok.Delim;
        break;
      case C.Hash:
        p++;
        if (isName(at(p)) || validEscape(p)) {
          name();
          k = Tok.Hash;
        } else k = Tok.Delim;
        break;
      case C.Lt:
        if (text.startsWith('!--', p + 1)) {
          p += 4;
          k = Tok.Cdo;
        } else {
          p++;
          k = Tok.Delim;
        }
        break;
      default:
        p++;
        k = single[c] as TokKind; // c < 128: higher code points start names
    }
    kinds.push(k);
    starts.push(s);
  }
  starts.push(len);
  return { kinds, starts };
}
