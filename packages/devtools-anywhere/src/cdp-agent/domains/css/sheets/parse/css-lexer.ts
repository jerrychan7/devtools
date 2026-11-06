/**
 * A CSS tokenizer after CSS Syntax Level 3 §4 (https://drafts.csswg.org/css-syntax-3/#tokenization),
 * cut down to what finding the edges of rules and declarations needs: token kinds and offsets, no
 * values. Offsets are UTF-16 code units in the original text; the newlines of §3.3 (CR LF, CR and
 * FF) are handled while scanning, not in a copy.
 *
 * Tokens are contiguous: token `i` covers `starts[i]` to `starts[i + 1]`, and `starts` ends with
 * the text's length.
 *
 * Where this differs from the specification:
 * - Comments, which §4.3.2 consumes and drops, are kept as tokens, so a caller can find disabled
 *   declarations in them.
 * - Numbers, percentages and dimensions are one kind, `Num`, and no token carries a value.
 * - NUL is not replaced by U+FFFD (§3.3): it is a delim token here, where the specification makes
 *   it the start of an ident. Style sheets do not hold NUL in practice.
 * - The result is the same as the specification's for everything else, but some checks are
 *   arranged to read each code unit about once rather than to mirror the algorithm step by step:
 *   a consumer leaves the code unit it stopped at in `nx` for the next token instead of having it
 *   read again; the "starts a number" (§4.3.10), CDC and "starts an ident sequence" (§4.3.9)
 *   checks for `-` are folded into one look at the next two code units; and an ident or number
 *   starts from the code unit the main loop has already read. Each place says so where it does it.
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
  kinds: Uint8Array & { readonly [i: number]: TokKind };
  /** One more than `kinds`: the last entry is the end of the text. */
  starts: Uint32Array;
}

const isNewline = (c: number) => c === 10 || c === 13 || c === 12;
const isWs = (c: number) => c === 32 || c === 9 || isNewline(c);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
/** Name code points (§4.2) of ASCII; every code point from 128 is one. */
const nameChar = new Uint8Array(128);
for (let c = 0; c < 128; c++) nameChar[c] = +(isNameStart(c) || isDigit(c) || c === 45);
const isName = (c: number) => (c < 128 ? nameChar[c] === 1 : c >= 128);
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
  // `text.charCodeAt` is written out at every call, not wrapped: V8 inlines the built-in only
  // when it sees it called on a string. It is NaN past the end, so no predicate matches there.
  const len = text.length;
  let p = 0;
  /**
   * The code unit at `p` when the consumer that stopped there has read it already, else -1: the
   * main loop and `identLike` take it from here rather than read it again.
   */
  let nx = -1;
  // §4.3.8 – §4.3.10
  const validEscape = (q: number) => text.charCodeAt(q) === 92 && !isNewline(text.charCodeAt(q + 1));
  const identStart = (q: number) => {
    const c = text.charCodeAt(q);
    if (c === 45) return isNameStart(text.charCodeAt(q + 1)) || text.charCodeAt(q + 1) === 45 || validEscape(q + 1);
    return isNameStart(c) || validEscape(q);
  };
  const numberStart = (q: number) => {
    let c = text.charCodeAt(q);
    if (c === 43 || c === 45) c = text.charCodeAt(++q);
    return isDigit(c) || (c === 46 && isDigit(text.charCodeAt(q + 1)));
  };
  /** §4.3.7, with `p` just past the backslash. */
  const escape = () => {
    if (!isHex(text.charCodeAt(p))) {
      if (p < len) p++;
      return;
    }
    for (let n = 0; n < 6 && isHex(text.charCodeAt(p)); n++) p++;
    if (text.charCodeAt(p) === 13 && text.charCodeAt(p + 1) === 10) p += 2;
    else if (isWs(text.charCodeAt(p))) p++;
  };
  /** §4.3.12, leaving the code unit it stopped at in `nx`. */
  const name = () => {
    for (;;) {
      const c = text.charCodeAt(p);
      if (isName(c)) p++;
      else if (c === 92 && !isNewline(text.charCodeAt(p + 1))) {
        p++;
        escape();
      } else {
        nx = c;
        return;
      }
    }
  };
  /** §4.3.14 */
  const badUrl = () => {
    while (p < len) {
      if (text.charCodeAt(p) === 41) {
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
      const c = text.charCodeAt(p);
      if (p >= len) return Tok.Url;
      if (c === 41) {
        p++;
        return Tok.Url;
      }
      if (isWs(c)) {
        while (isWs(text.charCodeAt(p))) p++;
        if (p >= len) return Tok.Url;
        if (text.charCodeAt(p) === 41) {
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
  /** §4.3.4, for the token from `s`, with `p` past what of its name the caller has checked. */
  const identLike = (s: number): TokKind => {
    name();
    if (nx !== 40) return Tok.Ident;
    nx = -1;
    p++;
    // `url(`, in any case, compared code unit by code unit: no string is made for each function.
    const url3 =
      p - s === 4 &&
      (text.charCodeAt(s) | 32) === 117 &&
      (text.charCodeAt(s + 1) | 32) === 114 &&
      (text.charCodeAt(s + 2) | 32) === 108;
    if (!url3) return Tok.Func;
    while (isWs(text.charCodeAt(p)) && isWs(text.charCodeAt(p + 1))) p++;
    const q = isWs(text.charCodeAt(p)) ? p + 1 : p;
    if (text.charCodeAt(q) === 34 || text.charCodeAt(q) === 39) return Tok.Func;
    while (isWs(text.charCodeAt(p))) p++;
    return url();
  };
  /** §4.3.5, with `p` just past the opening quote. */
  const string = (quote: number): TokKind => {
    for (;;) {
      const c = text.charCodeAt(p);
      if (p >= len) return Tok.Str;
      if (c === quote) {
        p++;
        return Tok.Str;
      }
      if (isNewline(c)) return Tok.BadStr;
      p++;
      if (c === 92 && p < len) {
        if (text.charCodeAt(p) === 13 && text.charCodeAt(p + 1) === 10) p += 2;
        else if (isNewline(text.charCodeAt(p))) p++;
        else escape();
      }
    }
  };
  /** §4.3.3, with `p` at the start of the number and `c` the code unit there. */
  const numeric = (c: number) => {
    if (c === 43 || c === 45) c = text.charCodeAt(++p);
    while (isDigit(c)) c = text.charCodeAt(++p);
    if (c === 46 && isDigit(text.charCodeAt(p + 1))) {
      p += 2;
      c = text.charCodeAt(p);
      while (isDigit(c)) c = text.charCodeAt(++p);
    }
    if (c === 69 || c === 101) {
      const d = text.charCodeAt(p + 1);
      const s = d === 43 || d === 45 ? 2 : 1;
      if (isDigit(text.charCodeAt(p + s))) {
        p += s;
        c = text.charCodeAt(p);
        while (isDigit(c)) c = text.charCodeAt(++p);
      }
    }
    if (c === 45) {
      const d = text.charCodeAt(p + 1);
      if (isNameStart(d) || d === 45 || (d === 92 && !isNewline(text.charCodeAt(p + 2)))) name();
      else nx = c;
    } else if (isNameStart(c) || (c === 92 && !isNewline(text.charCodeAt(p + 1)))) name();
    else if (c === 37) p++;
    else nx = c;
  };
  // Every token is at least one code unit long, so `len` tokens is the most there can be.
  const kinds = new Uint8Array(len);
  const starts = new Uint32Array(len + 1);
  let n = 0;
  while (p < len) {
    const s = p;
    // The code unit the last consumer stopped at, if it read it, rather than reading it again.
    const c = nx >= 0 ? nx : text.charCodeAt(p);
    nx = -1;
    let k: TokKind;
    switch (c < 128 ? charClass[c] : C.NameStart) {
      case C.Ws:
        {
          let w = text.charCodeAt(++p);
          while (isWs(w)) w = text.charCodeAt(++p);
          nx = w;
        }
        k = Tok.Ws;
        break;
      case C.Quote:
        p++;
        k = string(c);
        break;
      case C.Digit:
        // Unlike §4.3.3, which reads the first code unit again, it starts from `c`.
        numeric(c);
        k = Tok.Num;
        break;
      case C.NameStart:
        // `c` is a name code point already read: the name goes on after it, not from it again.
        p++;
        k = identLike(s);
        break;
      case C.Plus:
      case C.Dot:
        if (numberStart(p)) {
          numeric(c);
          k = Tok.Num;
        } else {
          p++;
          k = Tok.Delim;
        }
        break;
      case C.Minus: {
        // §4.1 tries, in order, "starts a number" (§4.3.10), CDC and "starts an ident sequence"
        // (§4.3.9), each reading the code units after `-` again; one look at them here decides the
        // same, and the ident or number goes on past what was checked.
        const d = text.charCodeAt(p + 1);
        if (isDigit(d)) {
          p++;
          numeric(d);
          k = Tok.Num;
        } else if (d === 46) {
          const e = text.charCodeAt(p + 2);
          if (isDigit(e)) {
            p++;
            numeric(d);
            k = Tok.Num;
          } else {
            p++;
            nx = d;
            k = Tok.Delim;
          }
        } else if (d === 45) {
          const e = text.charCodeAt(p + 2);
          if (e === 62) {
            p += 3;
            k = Tok.Cdc;
          } else {
            // `--` starts an ident whatever follows; both are name code points.
            p += 2;
            k = identLike(s);
          }
        } else if (isNameStart(d)) {
          p += 2;
          k = identLike(s);
        } else if (d === 92 && !isNewline(text.charCodeAt(p + 2))) {
          p++;
          k = identLike(s);
        } else {
          p++;
          nx = d;
          k = Tok.Delim;
        }
        break;
      }
      case C.Backslash:
        if (validEscape(p)) k = identLike(s);
        else {
          p++;
          k = Tok.Delim;
        }
        break;
      case C.Slash:
        if (text.charCodeAt(p + 1) === 42) {
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
        if (isName(text.charCodeAt(p)) || validEscape(p)) {
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
    kinds[n] = k;
    starts[n++] = s;
  }
  starts[n] = len;
  return { kinds: kinds.slice(0, n) as Tokens['kinds'], starts: starts.slice(0, n + 1) };
}
