import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tok, tokenize, type TokKind } from './css-lexer.ts';

const names = Object.fromEntries(Object.entries(Tok).map(([k, v]) => [v, k])) as Record<TokKind, string>;

/** `kind:text` of each token. */
function toks(text: string): string[] {
  const { kinds, starts } = tokenize(text);
  assert.equal(starts.length, kinds.length + 1);
  assert.equal(starts[starts.length - 1], text.length);
  return Array.from(kinds, (k, i) => `${names[k as TokKind]}:${text.slice(starts[i], starts[i + 1])}`);
}

test('comments, including one the text ends in', () => {
  assert.deepEqual(toks('a/* x */b'), ['Ident:a', 'Comment:/* x */', 'Ident:b']);
  assert.deepEqual(toks('a/* x'), ['Ident:a', 'Comment:/* x']);
  assert.deepEqual(toks('/**/'), ['Comment:/**/']);
  assert.deepEqual(toks('/*/ a */'), ['Comment:/*/ a */']);
});

test('strings: escapes, escaped newlines, unclosed, bad', () => {
  assert.deepEqual(toks(`"a\\"b"x`), ['Str:"a\\"b"', 'Ident:x']);
  assert.deepEqual(toks(`'a"b'`), [`Str:'a"b'`]);
  assert.deepEqual(toks('"a\\\nb"'), ['Str:"a\\\nb"']);
  assert.deepEqual(toks('"a\\\r\nb"'), ['Str:"a\\\r\nb"']);
  assert.deepEqual(toks('"a\nb'), ['BadStr:"a', 'Ws:\n', 'Ident:b']);
  assert.deepEqual(toks('"a\r\n;'), ['BadStr:"a', 'Ws:\r\n', 'Semi:;']);
  assert.deepEqual(toks('"a\fb'), ['BadStr:"a', 'Ws:\f', 'Ident:b']);
  assert.deepEqual(toks('"abc'), ['Str:"abc']);
  assert.deepEqual(toks('"abc\\'), ['Str:"abc\\']);
  assert.deepEqual(toks('"}{;"'), ['Str:"}{;"']);
});

test('escapes in names', () => {
  assert.deepEqual(toks('\\31 a{'), ['Ident:\\31 a', 'LBrace:{']);
  assert.deepEqual(toks('\\31\r\na'), ['Ident:\\31\r\na']);
  assert.deepEqual(toks('a\\{b'), ['Ident:a\\{b']);
  assert.deepEqual(toks('\\\n'), ['Delim:\\', 'Ws:\n']);
  assert.deepEqual(toks('#\\;x;'), ['Hash:#\\;x', 'Semi:;']);
  assert.deepEqual(toks('@\\7b x'), ['At:@\\7b x']);
  assert.deepEqual(toks('--x'), ['Ident:--x']);
  assert.deepEqual(toks('-\\-'), ['Ident:-\\-']);
  assert.deepEqual(toks('a\\'), ['Ident:a\\']);
});

test('url(): unquoted, quoted, bad, unclosed', () => {
  assert.deepEqual(toks('url(a;b})x'), ['Url:url(a;b})', 'Ident:x']);
  assert.deepEqual(toks('URL(  a  )'), ['Url:URL(  a  )']);
  assert.deepEqual(toks('url( "a;" )'), ['Func:url(', 'Ws: ', 'Str:"a;"', 'Ws: ', 'RParen:)']);
  assert.deepEqual(toks("url('a')"), ['Func:url(', "Str:'a'", 'RParen:)']);
  assert.deepEqual(toks('url(a b) c'), ['BadUrl:url(a b)', 'Ws: ', 'Ident:c']);
  assert.deepEqual(toks('url(a"b;}) c'), ['BadUrl:url(a"b;})', 'Ws: ', 'Ident:c']);
  assert.deepEqual(toks('url(a\\)b)'), ['Url:url(a\\)b)']);
  assert.deepEqual(toks('url(a\\\n) x)'), ['BadUrl:url(a\\\n)', 'Ws: ', 'Ident:x', 'RParen:)']);
  assert.deepEqual(toks('url(a{'), ['Url:url(a{']);
  assert.deepEqual(toks('url(\x01)'), ['BadUrl:url(\x01)']);
  // `1url(` is a dimension then `(`, not a url().
  assert.deepEqual(toks('1url(a"b)'), ['Num:1url', 'LParen:(', 'Ident:a', 'Str:"b)']);
  assert.deepEqual(toks('#url(a'), ['Hash:#url', 'LParen:(', 'Ident:a']);
  assert.deepEqual(toks('src(a b)'), ['Func:src(', 'Ident:a', 'Ws: ', 'Ident:b', 'RParen:)']);
  // The name is compared with its escapes decoded, as Chromium's ConsumeIdentLikeToken does.
  assert.deepEqual(toks('\\75rl(a;b{c})'), ['Url:\\75rl(a;b{c})']);
  assert.deepEqual(toks('u\\rl(a;b)x'), ['Url:u\\rl(a;b)', 'Ident:x']);
  assert.deepEqual(toks('\\55 RL(a)'), ['Url:\\55 RL(a)']);
  assert.deepEqual(toks('\\000075rl(;)'), ['Url:\\000075rl(;)']);
  assert.deepEqual(toks('u\\72l( "a" )'), ['Func:u\\72l(', 'Ws: ', 'Str:"a"', 'Ws: ', 'RParen:)']);
  assert.deepEqual(toks('\\75 rlx(a;'), ['Func:\\75 rlx(', 'Ident:a', 'Semi:;']);
  assert.deepEqual(toks('urls(a;'), ['Func:urls(', 'Ident:a', 'Semi:;']);
});

test('punctuation, brackets, !important, at-keywords', () => {
  assert.deepEqual(toks('a:b!important;'), ['Ident:a', 'Colon::', 'Ident:b', 'Delim:!', 'Ident:important', 'Semi:;']);
  assert.deepEqual(toks('([{}]),'), [
    'LParen:(',
    'LBracket:[',
    'LBrace:{',
    'RBrace:}',
    'RBracket:]',
    'RParen:)',
    'Comma:,',
  ]);
  assert.deepEqual(toks('@media'), ['At:@media']);
  assert.deepEqual(toks('@-x'), ['At:@-x']);
  assert.deepEqual(toks('@ x'), ['Delim:@', 'Ws: ', 'Ident:x']);
  assert.deepEqual(toks('@1'), ['Delim:@', 'Num:1']);
  assert.deepEqual(toks('&>'), ['Delim:&', 'Delim:>']);
});

test('numbers, CDO, CDC', () => {
  assert.deepEqual(toks('1.5e-3px'), ['Num:1.5e-3px']);
  assert.deepEqual(toks('-.5%'), ['Num:-.5%']);
  assert.deepEqual(toks('+1 -a'), ['Num:+1', 'Ws: ', 'Ident:-a']);
  assert.deepEqual(toks('1e'), ['Num:1e']);
  assert.deepEqual(toks('1.'), ['Num:1', 'Delim:.']);
  assert.deepEqual(toks('<!-- -->'), ['Cdo:<!--', 'Ws: ', 'Cdc:-->']);
  assert.deepEqual(toks('--->'), ['Ident:---', 'Delim:>']);
  assert.deepEqual(toks('<!-'), ['Delim:<', 'Delim:!', 'Delim:-']);
});

test('whitespace runs and every newline', () => {
  assert.deepEqual(toks(' \t\r\n\f\ra'), ['Ws: \t\r\n\f\r', 'Ident:a']);
  assert.deepEqual(toks(''), []);
});

test('names past ASCII, and what `-`, `#`, `+`, `.` and `\\` fall back to', () => {
  assert.deepEqual(toks('é{'), ['Ident:é', 'LBrace:{']);
  assert.deepEqual(toks('a\u{1f600}b('), ['Func:a\u{1f600}b(']);
  assert.deepEqual(toks('#é'), ['Hash:#é']);
  assert.deepEqual(toks('-.a'), ['Delim:-', 'Delim:.', 'Ident:a']);
  assert.deepEqual(toks('-.5'), ['Num:-.5']);
  assert.deepEqual(toks('-\\\n'), ['Delim:-', 'Delim:\\', 'Ws:\n']);
  assert.deepEqual(toks('- a'), ['Delim:-', 'Ws: ', 'Ident:a']);
  assert.deepEqual(toks('-'), ['Delim:-']);
  assert.deepEqual(toks('-é'), ['Ident:-é']);
  assert.deepEqual(toks('# a'), ['Delim:#', 'Ws: ', 'Ident:a']);
  assert.deepEqual(toks('#'), ['Delim:#']);
  assert.deepEqual(toks('#-'), ['Hash:#-']);
  assert.deepEqual(toks('+a'), ['Delim:+', 'Ident:a']);
  assert.deepEqual(toks('+.5'), ['Num:+.5']);
  assert.deepEqual(toks('.a'), ['Delim:.', 'Ident:a']);
  // A backslash the text ends in is a valid escape (§4.3.8), as in Chromium.
  assert.deepEqual(toks('\\'), ['Ident:\\']);
  assert.deepEqual(toks('1-'), ['Num:1', 'Delim:-']);
  assert.deepEqual(toks('1-a'), ['Num:1-a']);
  assert.deepEqual(toks('1e+'), ['Num:1e', 'Delim:+']);
});

/**
 * §4 followed step by step, with the lexer's departures (comments kept, NUL a delim): what each
 * shortcut of css-lexer.ts is checked against.
 */
function reference(text: string): number[][] {
  const len = text.length;
  const at = (q: number) => (q < len ? text.charCodeAt(q) : -1);
  const isNl = (c: number) => c === 10 || c === 13 || c === 12;
  const isWs = (c: number) => c === 32 || c === 9 || isNl(c);
  const isDigit = (c: number) => c >= 48 && c <= 57;
  const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
  const isStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
  const isName = (c: number) => isStart(c) || isDigit(c) || c === 45;
  const isNonPrintable = (c: number) => (c >= 0 && c <= 8) || c === 11 || (c >= 14 && c <= 31) || c === 127;
  /** One code point of the preprocessed text: CR LF is one newline. */
  const one = (q: number) => (at(q) === 13 && at(q + 1) === 10 ? q + 2 : q + 1);
  const validEscape = (q: number) => at(q) === 92 && !isNl(at(q + 1));
  const identStart = (q: number) =>
    at(q) === 45 ? isStart(at(q + 1)) || at(q + 1) === 45 || validEscape(q + 1) : isStart(at(q)) || validEscape(q);
  const numberStart = (q: number) => {
    if (at(q) === 43 || at(q) === 45) q++;
    return isDigit(at(q)) || (at(q) === 46 && isDigit(at(q + 1)));
  };
  let p = 0;
  /** §4.3.7 with `p` past the backslash; returns the code point. */
  const escape = (): number => {
    if (at(p) === -1) return 0xfffd;
    if (!isHex(at(p))) return text.codePointAt(p++) ?? 0;
    let hex = '';
    while (hex.length < 6 && isHex(at(p))) hex += text[p++];
    if (isWs(at(p))) p = one(p);
    return parseInt(hex, 16);
  };
  const name = (): string => {
    let out = '';
    for (;;) {
      if (isName(at(p))) out += text[p++];
      else if (validEscape(p)) {
        p++;
        out += String.fromCodePoint(Math.min(escape(), 0x10ffff));
      } else return out;
    }
  };
  const badUrl = () => {
    while (at(p) !== -1) {
      if (at(p) === 41) return void p++;
      if (validEscape(p)) {
        p++;
        escape();
      } else p++;
    }
  };
  const url = (): number => {
    while (isWs(at(p))) p++;
    for (;;) {
      const c = at(p);
      if (c === 41) return (p++, Tok.Url);
      if (c === -1) return Tok.Url;
      if (isWs(c)) {
        while (isWs(at(p))) p++;
        if (at(p) === 41 || at(p) === -1) return (at(p) === 41 && p++, Tok.Url);
        return (badUrl(), Tok.BadUrl);
      }
      if (c === 34 || c === 39 || c === 40 || isNonPrintable(c) || (c === 92 && !validEscape(p))) {
        return (badUrl(), Tok.BadUrl);
      }
      p++;
      if (c === 92) escape();
    }
  };
  const identLike = (): number => {
    const n = name();
    if (at(p) !== 40) return Tok.Ident;
    p++;
    if (!/^url$/i.test(n)) return Tok.Func;
    while (isWs(at(p)) && isWs(at(p + 1))) p++;
    const q = isWs(at(p)) ? p + 1 : p;
    return at(q) === 34 || at(q) === 39 ? Tok.Func : url();
  };
  const numeric = (): number => {
    if (at(p) === 43 || at(p) === 45) p++;
    while (isDigit(at(p))) p++;
    if (at(p) === 46 && isDigit(at(p + 1))) for (p++; isDigit(at(p));) p++;
    if (at(p) === 69 || at(p) === 101) {
      const s = at(p + 1) === 43 || at(p + 1) === 45 ? 2 : 1;
      if (isDigit(at(p + s))) for (p += s; isDigit(at(p));) p++;
    }
    if (identStart(p)) name();
    else if (at(p) === 37) p++;
    return Tok.Num;
  };
  const string = (quote: number): number => {
    p++;
    for (;;) {
      const c = at(p);
      if (c === quote) return (p++, Tok.Str);
      if (c === -1) return Tok.Str;
      if (isNl(c)) return Tok.BadStr;
      p++;
      if (c === 92 && at(p) !== -1) {
        if (isNl(at(p))) p = one(p);
        else escape();
      }
    }
  };
  const kinds: number[] = [];
  const starts: number[] = [];
  const singles: Record<number, number> = {
    40: Tok.LParen,
    41: Tok.RParen,
    44: Tok.Comma,
    58: Tok.Colon,
    59: Tok.Semi,
    91: Tok.LBracket,
    93: Tok.RBracket,
    123: Tok.LBrace,
    125: Tok.RBrace,
  };
  while (p < len) {
    starts.push(p);
    const c = at(p);
    let k: number;
    if (c === 47 && at(p + 1) === 42) {
      const e = text.indexOf('*/', p + 2);
      p = e < 0 ? len : e + 2;
      k = Tok.Comment;
    } else if (isWs(c)) {
      while (isWs(at(p))) p++;
      k = Tok.Ws;
    } else if (c === 34 || c === 39) k = string(c);
    else if (c === 35) {
      p++;
      if (isName(at(p)) || validEscape(p)) {
        name();
        k = Tok.Hash;
      } else k = Tok.Delim;
    } else if ((c === 43 || c === 45 || c === 46) && numberStart(p)) k = numeric();
    else if (c === 45 && at(p + 1) === 45 && at(p + 2) === 62) {
      p += 3;
      k = Tok.Cdc;
    } else if (c === 45 && identStart(p)) k = identLike();
    else if (c === 60 && text.startsWith('!--', p + 1)) {
      p += 4;
      k = Tok.Cdo;
    } else if (c === 64 && identStart(p + 1)) {
      p++;
      name();
      k = Tok.At;
    } else if (c === 92 && validEscape(p)) k = identLike();
    else if (isDigit(c)) k = numeric();
    else if (isStart(c)) k = identLike();
    else {
      p++;
      k = singles[c] ?? Tok.Delim;
    }
    kinds.push(k);
  }
  starts.push(len);
  return [kinds, starts];
}

test('the same tokens as §4 followed step by step, for every code unit in many places', () => {
  const check = (text: string) => {
    const { kinds, starts } = tokenize(text);
    assert.deepEqual([[...kinds], [...starts]], reference(text), JSON.stringify(text));
  };
  // Every code unit past ASCII is a name code point alike: a few of them stand for the rest.
  const units = [
    ...Array.from({ length: 128 }, (_, c) => String.fromCharCode(c)),
    'é',
    '\u2028',
    '\ud800',
    '\udc00',
    '\ufffd',
    '\uffff',
  ];
  const before = [
    '',
    'a',
    '1',
    '-',
    '--',
    '+',
    '.',
    '-.',
    '#',
    '@',
    '@-',
    '\\',
    'u\\72l(',
    'url(',
    'url( ',
    '"',
    '<!-',
    '/*',
    '1e',
    '1e-',
  ];
  const after = ['', 'x', '1', '(', ')', ' ', '-', '>', '\\', '\n', '"'];
  for (const b of before) for (const u of units) for (const a of after) check(b + u + a);
  // Every three of the code units the lexer branches on.
  const some = [
    ' ',
    '\n',
    '\r',
    '\f',
    '"',
    "'",
    '#',
    '(',
    ')',
    '+',
    '-',
    '.',
    '/',
    '*',
    '<',
    '!',
    '@',
    '\\',
    '1',
    'e',
    'E',
    '%',
    'u',
    'r',
    'l',
    'é',
    '\0',
    ';',
    '{',
    '>',
    '7',
    '5',
  ];
  for (const x of some)
    for (const y of some)
      for (const z of some) {
        check(x + y + z);
        check(`url(${x}${y}${z}`);
      }
});
