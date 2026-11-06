/**
 * The CSS lexer of ../css-lexer.ts written again as a WebAssembly module, step for step: each
 * function below is the closure of the same name there, and the main loop is `tokenize`'s.
 * Assembled with outline.ts into one module by build.ts: `node build.ts` writes ../css-wasm-bytes.ts,
 * and css-lexer-wasm.test.ts fails until it is run again after a change here.
 *
 * Memory, in bytes:
 * - FLAGS (0): a byte of character class bits per UTF-16 code unit;
 * - DISPATCH (64 KiB): per code unit, the case of the main loop's switch, or 32 + the token kind
 *   of a single-character token;
 * - IN (128 KiB): the text, as UTF-16 (`lex16`) or, when it is all ASCII, one byte per code unit
 *   (`lex8`), followed by 4 code units of 0 that stand for `charCodeAt`'s NaN past the end: 0 is
 *   in no class the lexer tests past the end;
 * - then the `kinds` and `starts` arrays, where the caller says.
 */
import { Tok } from '../css-lexer.ts';
import * as A from './assembler.ts';
import {
  add,
  and,
  block,
  br,
  brIf,
  brTable,
  eq,
  eqz,
  geS,
  geU,
  i32,
  if_,
  loop,
  ltU,
  ne,
  or,
  ret,
  sub,
} from './assembler.ts';

export const FLAGS = 0;
export const DISPATCH = 0x10000;
export const IN = 0x20000;
/** Code units of 0 after the text. */
export const PAD = 4;

const F = { Ws: 1, Digit: 2, Hex: 4, NameStart: 8, Name: 16, Newline: 32, NonPrintable: 64 } as const;
const C = { Other: 0, Ws: 1, Quote: 2, Digit: 3, NameStart: 4, Plus: 5, Dot: 6, Minus: 7 } as const;

function tables(): { flags: number[]; dispatch: number[] } {
  const flags: number[] = [];
  const dispatch: number[] = [];
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
  const special: Record<number, number> = { 43: 5, 46: 6, 45: 7, 92: 8, 47: 9, 64: 10, 35: 11, 60: 12 };
  for (let c = 0; c < 128; c++) {
    const nl = c === 10 || c === 13 || c === 12;
    const ws = c === 32 || c === 9 || nl;
    const digit = c >= 48 && c <= 57;
    const hex = digit || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
    const start = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    const nonPrintable = c <= 8 || c === 11 || (c >= 14 && c <= 31) || c === 127;
    flags.push(
      (ws ? F.Ws : 0) |
        (digit ? F.Digit : 0) |
        (hex ? F.Hex : 0) |
        (start ? F.NameStart : 0) |
        (start || digit || c === 45 ? F.Name : 0) |
        (nl ? F.Newline : 0) |
        (nonPrintable ? F.NonPrintable : 0)
    );
    dispatch.push(
      ws
        ? C.Ws
        : c === 34 || c === 39
          ? C.Quote
          : digit
            ? C.Digit
            : start
              ? C.NameStart
              : (special[c] ?? 32 + (singles[c] ?? Tok.Delim))
    );
  }
  return { flags, dispatch };
}

/**
 * Adds the lexer's globals, tables and functions to `m` (build.ts assembles them with the
 * outline's). `lex8` and `lex16` take the text's length, where to write the kinds and the starts,
 * and the offset to start at, so that a text copied anywhere past IN is lexed in place (a comment's,
 * outline.ts); its offsets are counted from IN, as is the length.
 */
export function lexerInto(m: A.Module): void {
  const { get, set, call } = m;
  // Shared by the functions, as the closures share them in css-lexer.ts.
  m.global('len');
  m.global('nx'); // -1, or the code unit at `p` already read
  m.global('k'); // the kind a consumer returns along with `p`

  const t = tables();
  m.segment(FLAGS, t.flags);
  m.segment(DISPATCH, t.dispatch);
  m.declare('init', [], 0);
  m.start = 'init';
  m.define('init', () => [
    A.fill(i32(FLAGS + 128), i32(F.NameStart | F.Name), i32(0x10000 - 128)),
    A.fill(i32(DISPATCH + 128), i32(C.NameStart), i32(0x10000 - 128)),
  ]);

  for (const w of [16, 8] as const) {
    const fn = (s: string) => s + w;
    /** The code unit at `q`: `text.charCodeAt(q)`. */
    const at = (q: A.Code) => (w === 16 ? A.load16(A.shl(q, i32(1)), IN) : A.load8(q, IN));
    /** 1 if `c` is in the class, else 0: tested with `and`, so not left as the flag's bit. */
    const has = (c: A.Code, flag: number) => ne(and(A.load8(c, FLAGS), i32(flag)), i32(0));
    const not = (c: A.Code, flag: number) => eqz(has(c, flag));
    const inc = (v: string, by = 1) => set(v, add(get(v), i32(by)));
    const atEnd = (q: string) => geU(get(q), get('len'));
    /** `text.charCodeAt(q) === 92 && !isNewline(text.charCodeAt(q + 1))` */
    const validEscape = (q: A.Code) => and(eq(at(q), i32(92)), not(at(add(q, i32(1))), F.Newline));
    /** `while (pred(text.charCodeAt(p))) p++` */
    const skip = (v: string, flag: number) =>
      loop('skip', () => [if_(has(at(get(v)), flag), () => [inc(v), br('skip')])]);

    m.declare(fn('escape'), ['p'], 1, ['n']);
    m.declare(fn('name'), ['p'], 1, ['c']);
    m.declare(fn('badUrl'), ['p'], 1, ['c']);
    m.declare(fn('identLike'), ['s', 'p'], 1, ['c', 'q']);
    m.declare(fn('string'), ['p', 'quote'], 1, ['c', 'd']);
    m.declare(fn('numeric'), ['p', 'c'], 1, ['d', 's']);
    m.declare(fn('lex'), ['length', 'kinds', 'starts', 'from'], 1, ['p', 's', 'c', 'n', 'd', 'e', 'q']);

    m.define(fn('escape'), () => [
      if_(not(at(get('p')), F.Hex), () => [if_(ltU(get('p'), get('len')), () => [inc('p')]), ret(get('p'))]),
      set('n', i32(0)),
      loop('hex', () => [
        if_(and(ltU(get('n'), i32(6)), has(at(get('p')), F.Hex)), () => [inc('p'), inc('n'), br('hex')]),
      ]),
      if_(
        and(eq(at(get('p')), i32(13)), eq(at(add(get('p'), i32(1))), i32(10))),
        () => [inc('p', 2)],
        () => [if_(has(at(get('p')), F.Ws), () => [inc('p')])]
      ),
      get('p'),
    ]);

    m.define(fn('name'), () => [
      loop('name', () => [
        set('c', at(get('p'))),
        if_(has(get('c'), F.Name), () => [inc('p'), br('name')]),
        if_(and(eq(get('c'), i32(92)), not(at(add(get('p'), i32(1))), F.Newline)), () => [
          set('p', call(fn('escape'), add(get('p'), i32(1)))),
          br('name'),
        ]),
      ]),
      set('nx', get('c')),
      get('p'),
    ]);

    m.define(fn('badUrl'), () => [
      loop('bad', () => [
        if_(atEnd('p'), () => [ret(get('p'))]),
        if_(eq(at(get('p')), i32(41)), () => [ret(add(get('p'), i32(1)))]),
        if_(
          validEscape(get('p')),
          () => [set('p', call(fn('escape'), add(get('p'), i32(1))))],
          () => [inc('p')]
        ),
        br('bad'),
      ]),
      get('p'),
    ]);

    const toBadUrl = () => [set('k', i32(Tok.BadUrl)), ret(call(fn('badUrl'), get('p')))];
    m.define(fn('identLike'), () => [
      set('p', call(fn('name'), get('p'))),
      set('k', i32(Tok.Ident)),
      if_(ne(get('nx'), i32(40)), () => [ret(get('p'))]),
      set('nx', i32(-1)),
      inc('p'),
      // `url(` in any case, else a function.
      set('k', i32(Tok.Func)),
      if_(ne(sub(get('p'), get('s')), i32(4)), () => [ret(get('p'))]),
      if_(ne(or(at(get('s')), i32(32)), i32(117)), () => [ret(get('p'))]),
      if_(ne(or(at(add(get('s'), i32(1))), i32(32)), i32(114)), () => [ret(get('p'))]),
      if_(ne(or(at(add(get('s'), i32(2))), i32(32)), i32(108)), () => [ret(get('p'))]),
      loop('ws2', () => [
        if_(and(has(at(get('p')), F.Ws), has(at(add(get('p'), i32(1))), F.Ws)), () => [inc('p'), br('ws2')]),
      ]),
      set('q', add(get('p'), has(at(get('p')), F.Ws))),
      set('c', at(get('q'))),
      if_(or(eq(get('c'), i32(34)), eq(get('c'), i32(39))), () => [ret(get('p'))]),
      skip('p', F.Ws),
      // §4.3.6
      set('k', i32(Tok.Url)),
      loop('url', () => [
        if_(atEnd('p'), () => [ret(get('p'))]),
        set('c', at(get('p'))),
        if_(eq(get('c'), i32(41)), () => [ret(add(get('p'), i32(1)))]),
        if_(has(get('c'), F.Ws), () => [
          skip('p', F.Ws),
          if_(atEnd('p'), () => [ret(get('p'))]),
          if_(eq(at(get('p')), i32(41)), () => [ret(add(get('p'), i32(1)))]),
          ...toBadUrl(),
        ]),
        if_(
          or(
            or(eq(get('c'), i32(34)), eq(get('c'), i32(39))),
            or(eq(get('c'), i32(40)), has(get('c'), F.NonPrintable))
          ),
          toBadUrl
        ),
        if_(
          eq(get('c'), i32(92)),
          () => [
            if_(has(at(add(get('p'), i32(1))), F.Newline), toBadUrl),
            set('p', call(fn('escape'), add(get('p'), i32(1)))),
          ],
          () => [inc('p')]
        ),
        br('url'),
      ]),
      get('p'),
    ]);

    m.define(fn('string'), () => [
      set('k', i32(Tok.Str)),
      loop('str', () => [
        if_(atEnd('p'), () => [ret(get('p'))]),
        set('c', at(get('p'))),
        if_(eq(get('c'), get('quote')), () => [ret(add(get('p'), i32(1)))]),
        if_(has(get('c'), F.Newline), () => [set('k', i32(Tok.BadStr)), ret(get('p'))]),
        inc('p'),
        if_(and(eq(get('c'), i32(92)), ltU(get('p'), get('len'))), () => [
          set('d', at(get('p'))),
          if_(
            and(eq(get('d'), i32(13)), eq(at(add(get('p'), i32(1))), i32(10))),
            () => [inc('p', 2)],
            () => [
              if_(
                has(get('d'), F.Newline),
                () => [inc('p')],
                () => [set('p', call(fn('escape'), get('p')))]
              ),
            ]
          ),
        ]),
        br('str'),
      ]),
      get('p'),
    ]);

    const digits = () =>
      loop('digits', () => [if_(has(get('c'), F.Digit), () => [inc('p'), set('c', at(get('p'))), br('digits')])]);
    m.define(fn('numeric'), () => [
      if_(or(eq(get('c'), i32(43)), eq(get('c'), i32(45))), () => [inc('p'), set('c', at(get('p')))]),
      digits(),
      if_(and(eq(get('c'), i32(46)), has(at(add(get('p'), i32(1))), F.Digit)), () => [
        inc('p', 2),
        set('c', at(get('p'))),
        digits(),
      ]),
      if_(or(eq(get('c'), i32(69)), eq(get('c'), i32(101))), () => [
        set('d', at(add(get('p'), i32(1)))),
        set('s', add(i32(1), or(eq(get('d'), i32(43)), eq(get('d'), i32(45))))),
        if_(has(at(add(get('p'), get('s'))), F.Digit), () => [
          set('p', add(get('p'), get('s'))),
          set('c', at(get('p'))),
          digits(),
        ]),
      ]),
      if_(
        eq(get('c'), i32(45)),
        () => [
          set('d', at(add(get('p'), i32(1)))),
          if_(
            or(
              or(has(get('d'), F.NameStart), eq(get('d'), i32(45))),
              and(eq(get('d'), i32(92)), not(at(add(get('p'), i32(2))), F.Newline))
            ),
            () => [set('p', call(fn('name'), get('p')))],
            () => [set('nx', get('c'))]
          ),
        ],
        () => [
          if_(
            or(has(get('c'), F.NameStart), and(eq(get('c'), i32(92)), not(at(add(get('p'), i32(1))), F.Newline))),
            () => [set('p', call(fn('name'), get('p')))],
            () => [
              if_(
                eq(get('c'), i32(37)),
                () => [inc('p')],
                () => [set('nx', get('c'))]
              ),
            ]
          ),
        ]
      ),
      get('p'),
    ]);

    const tok = (kind: number) => [set('k', i32(kind)), br('emit')];
    /** identLike(s), which leaves its kind in the global `k`. */
    const identLikeG = () => [set('p', call(fn('identLike'), get('s'), get('p'))), br('emit')];
    const delim = () => [inc('p'), ...tok(Tok.Delim)];
    m.define(fn('lex'), () => [
      set('len', get('length')),
      set('nx', i32(-1)),
      set('p', get('from')),
      set('n', i32(0)),
      loop('main', () => [
        block('done', () => [
          brIf('done', geU(get('p'), get('len'))),
          set('s', get('p')),
          // The code unit the last consumer stopped at, if it read it, rather than reading it again.
          set('c', A.select(get('nx'), at(get('p')), geS(get('nx'), i32(0)))),
          set('nx', i32(-1)),
          block('emit', () => [
            block('other', () => [
              block('lt', () => [
                block('hash', () => [
                  block('at', () => [
                    block('slash', () => [
                      block('backslash', () => [
                        block('minus', () => [
                          block('dot', () => [
                            block('plus', () => [
                              block('nameStart', () => [
                                block('digit', () => [
                                  block('quote', () => [
                                    block('ws', () => [
                                      brTable(
                                        A.load8(get('c'), DISPATCH),
                                        [
                                          'other',
                                          'ws',
                                          'quote',
                                          'digit',
                                          'nameStart',
                                          'plus',
                                          'dot',
                                          'minus',
                                          'backslash',
                                          'slash',
                                          'at',
                                          'hash',
                                          'lt',
                                        ],
                                        'other'
                                      ),
                                    ]),
                                    // ws
                                    inc('p'),
                                    skip('p', F.Ws),
                                    set('nx', at(get('p'))),
                                    ...tok(Tok.Ws),
                                  ]),
                                  // quote
                                  set('p', call(fn('string'), add(get('p'), i32(1)), get('c'))),
                                  br('emit'),
                                ]),
                                // digit
                                set('p', call(fn('numeric'), get('p'), get('c'))),
                                ...tok(Tok.Num),
                              ]),
                              // nameStart
                              inc('p'),
                              ...identLikeG(),
                            ]),
                            // plus: falls into dot
                          ]),
                          // plus, dot: numberStart(p)
                          set('q', get('p')),
                          set('d', get('c')),
                          if_(or(eq(get('d'), i32(43)), eq(get('d'), i32(45))), () => [
                            inc('q'),
                            set('d', at(get('q'))),
                          ]),
                          if_(
                            or(
                              has(get('d'), F.Digit),
                              and(eq(get('d'), i32(46)), has(at(add(get('q'), i32(1))), F.Digit))
                            ),
                            () => [set('p', call(fn('numeric'), get('p'), get('c'))), ...tok(Tok.Num)]
                          ),
                          ...delim(),
                        ]),
                        // minus
                        set('d', at(add(get('p'), i32(1)))),
                        if_(has(get('d'), F.Digit), () => [
                          set('p', call(fn('numeric'), add(get('p'), i32(1)), get('d'))),
                          ...tok(Tok.Num),
                        ]),
                        if_(eq(get('d'), i32(46)), () => [
                          inc('p'),
                          if_(has(at(add(get('p'), i32(1))), F.Digit), () => [
                            set('p', call(fn('numeric'), get('p'), get('d'))),
                            ...tok(Tok.Num),
                          ]),
                          set('nx', get('d')),
                          ...tok(Tok.Delim),
                        ]),
                        if_(eq(get('d'), i32(45)), () => [
                          if_(eq(at(add(get('p'), i32(2))), i32(62)), () => [inc('p', 3), ...tok(Tok.Cdc)]),
                          inc('p', 2),
                          ...identLikeG(),
                        ]),
                        if_(has(get('d'), F.NameStart), () => [inc('p', 2), ...identLikeG()]),
                        if_(and(eq(get('d'), i32(92)), not(at(add(get('p'), i32(2))), F.Newline)), () => [
                          inc('p'),
                          ...identLikeG(),
                        ]),
                        inc('p'),
                        set('nx', get('d')),
                        ...tok(Tok.Delim),
                      ]),
                      // backslash
                      if_(not(at(add(get('p'), i32(1))), F.Newline), () => identLikeG()),
                      ...delim(),
                    ]),
                    // slash
                    if_(eq(at(add(get('p'), i32(1))), i32(42)), () => [
                      set('q', add(get('p'), i32(2))),
                      loop('comment', () => [
                        if_(geU(get('q'), get('len')), () => [set('p', get('len')), ...tok(Tok.Comment)]),
                        if_(and(eq(at(get('q')), i32(42)), eq(at(add(get('q'), i32(1))), i32(47))), () => [
                          set('p', add(get('q'), i32(2))),
                          ...tok(Tok.Comment),
                        ]),
                        inc('q'),
                        br('comment'),
                      ]),
                    ]),
                    ...delim(),
                  ]),
                  // at: identStart(p + 1)
                  inc('p'),
                  set('c', at(get('p'))),
                  set('d', at(add(get('p'), i32(1)))),
                  if_(
                    eq(get('c'), i32(45)),
                    () => [
                      set(
                        'e',
                        or(
                          or(has(get('d'), F.NameStart), eq(get('d'), i32(45))),
                          and(eq(get('d'), i32(92)), not(at(add(get('p'), i32(2))), F.Newline))
                        )
                      ),
                    ],
                    () => [
                      set('e', or(has(get('c'), F.NameStart), and(eq(get('c'), i32(92)), not(get('d'), F.Newline)))),
                    ]
                  ),
                  if_(get('e'), () => [set('p', call(fn('name'), get('p'))), ...tok(Tok.At)]),
                  ...tok(Tok.Delim),
                ]),
                // hash
                inc('p'),
                if_(or(has(at(get('p')), F.Name), validEscape(get('p'))), () => [
                  set('p', call(fn('name'), get('p'))),
                  ...tok(Tok.Hash),
                ]),
                ...tok(Tok.Delim),
              ]),
              // lt
              if_(
                and(
                  and(eq(at(add(get('p'), i32(1))), i32(33)), eq(at(add(get('p'), i32(2))), i32(45))),
                  eq(at(add(get('p'), i32(3))), i32(45))
                ),
                () => [inc('p', 4), ...tok(Tok.Cdo)]
              ),
              ...delim(),
            ]),
            // other: a single-character token
            inc('p'),
            set('k', sub(A.load8(get('c'), DISPATCH), i32(32))),
          ]),
          A.store8(add(get('kinds'), get('n')), get('k')),
          A.store32(add(get('starts'), A.shl(get('n'), i32(2))), get('s')),
          inc('n'),
          br('main'),
        ]),
      ]),
      A.store32(add(get('starts'), A.shl(get('n'), i32(2))), get('len')),
      get('n'),
    ]);
  }
}
