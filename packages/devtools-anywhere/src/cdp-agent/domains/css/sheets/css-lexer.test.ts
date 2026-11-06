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
