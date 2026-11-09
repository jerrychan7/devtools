/**
 * ../css-outline.ts's `outline` written again for WebAssembly, in the module of the lexer
 * (lexer.ts; build.ts assembles the two), so that the tokens never leave the module and the rule
 * and declaration tables are written straight into its memory in CssOutline's format. Each function
 * below is the closure of the same name in css-outline.ts.
 *
 * `run` is the module's entry: it lexes the text, and with LEX_ONLY returns the number of tokens
 * there, for css-lexer-wasm.ts's `tokenize`; else it outlines the tokens and returns the number of
 * rules, whose tables `rb`, `db` and `dc` locate (../css-outline-wasm.ts).
 *
 * Memory: the lexer's tables, then, from IN, frame 0: the text (one or two bytes per code unit),
 * the token kinds, their starts, where the caller put them, then the rule table and the declaration
 * table. Positions are code units from IN. A comment that may hold a declaration is copied past
 * the current frame and parsed there as a frame of its own (css-outline.ts's scratch outlines),
 * which is dropped once read: only the innermost frame grows, so it is always the last thing in
 * memory. `value`'s stack of closers is past it too, for as long as `value` runs: brackets nested
 * however deep take memory, not the call stack. Memory that cannot grow traps (`unreachable`); so
 * does a call stack overflow, from `{` nested thousands deep: the caller then uses css-outline.ts.
 */
import { Tok } from '../css-lexer.ts';
import * as A from './assembler.ts';
import {
  add,
  and,
  block,
  br,
  brIf,
  copy,
  drop,
  eq,
  eqz,
  fill,
  geS,
  geU,
  gtS,
  gtU,
  i32,
  if_,
  leU,
  load16,
  load32,
  load8,
  loop,
  ltS,
  memGrow,
  memSize,
  mul,
  ne,
  or,
  ret,
  select,
  shl,
  shrU,
  store32,
  store8,
  sub,
  unreachable,
} from './assembler.ts';
import { IN, PAD } from './lexer.ts';

// css-outline.ts's record layout.
const RW = 12;
const DW = 6;
const R = {
  FLAGS: 0,
  START: 1,
  END: 2,
  NAME_END: 3,
  PRE_S: 4,
  PRE_E: 5,
  BLK_S: 6,
  BLK_E: 7,
  DECLS: 8,
  DCOUNT: 9,
  CHILD: 10,
  NEXT: 11,
};
const QUALIFIED = 0;
const AT = 1;
const NESTED = 2;
const UNCLOSED = 4;
const COMMENT = 1;
const IMPORTANT = 2;
const SEMICOLON = 4;

/** `run`'s flag: lex only, and return the number of tokens. */
export const LEX_ONLY = 1;

/** Adds the outline's globals and functions, and the module's exports, to `m`, which has the lexer's. */
export function outlineInto(m: A.Module): void {
  const { get, set, call } = m;
  // The frame being parsed; `wide`: 1 for two bytes per code unit.
  for (const g of ['wide', 'K', 'S', 'N', 'LEN', 'RB', 'DB', 'RC', 'DC', 'RCAP', 'DCAP', 'i', 'inStyle']) m.global(g);
  // The declaration `declaration` (or `commented`) found.
  for (const g of ['dF', 'dS', 'dE', 'dN', 'dVS', 'dVE']) m.global(g);

  const inc = (v: string, by = 1) => set(v, add(get(v), i32(by)));
  const kind = (j: A.Code) => load8(add(get('K'), j));
  const pos = (j: A.Code) => load32(add(get('S'), shl(j, i32(2))));
  const rAddr = (r: A.Code) => add(get('RB'), mul(r, i32(RW * 4)));
  const rget = (r: A.Code, f: number) => load32(rAddr(r), f * 4);
  const rset = (r: A.Code, f: number, v: A.Code) => store32(rAddr(r), v, f * 4);
  const trivia = (k: A.Code) => leU(k, i32(1)); // Ws 0, Comment 1
  const ch = (q: A.Code) => call('ch', q);
  const align4 = (a: A.Code) => and(add(a, i32(3)), i32(-4));
  const min = (a: A.Code, b: A.Code) => call('min', a, b);
  const max = (a: A.Code, b: A.Code) => call('max', a, b);
  const isK = (k: A.Code, t: number) => eq(k, i32(t));

  m.declare('ch', ['q'], 1);
  m.declare('lexW', ['len_', 'k_', 's_', 'from_'], 1);
  m.declare('min', ['a', 'b'], 1);
  m.declare('max', ['a', 'b'], 1);
  m.declare('ensure', ['end'], 0, ['have']);
  m.declare('addRule', ['kind', 'start'], 1, ['r', 'a', 'cap']);
  m.declare('addDecl', ['r'], 0, ['a']);
  m.declare('closer', ['t'], 1);
  m.declare('value', [], 0, ['c', 'base', 'sp', 'lim', 't']);
  m.declare('trimEnd', ['from', 'j', 'ws'], 1, ['t']);
  m.declare('block', ['r', 't'], 0, ['style']);
  m.declare('atRule', ['nested'], 1, ['r', 'from', 't', 'pe', 'j']);
  m.declare('qualified', ['nested'], 1, ['from', 't', 'custom', 'mm', 'r']);
  m.declare('important', ['a', 'b'], 1);
  m.declare('dashed', ['a', 'e'], 1, ['n', 'c', 'v', 'h', 'x']);
  m.declare('declaration', [], 1, [
    'start',
    'nameEnd',
    'from',
    'custom',
    'last',
    'prev',
    't',
    'imp',
    've',
    'semi',
    'end',
  ]);
  m.declare('jsWs', ['a', 'b'], 1, ['c']);
  m.declare('commented', ['start', 'end'], 1, [
    'q',
    'innerS',
    'L',
    'X',
    'o',
    'w',
    'ok',
    'last',
    'd',
    'stray',
    'sK',
    'sS',
    'sN',
    'sLEN',
    'sRB',
    'sDB',
    'sRC',
    'sDC',
    'sRCAP',
    'sDCAP',
    'sI',
    'sIn',
  ]);
  m.declare('contents', ['r', 'wrap'], 1, ['own', 'group', 'last', 't', 'mark', 'q']);
  m.declare('run', ['n0', 'wide16', 'kinds', 'starts', 'flags'], 1, ['t', 'r', 'last'], true);
  m.declare('rb', [], 1, [], true);
  m.declare('db', [], 1, [], true);
  m.declare('dc', [], 1, [], true);

  m.define('ch', () => [if_(get('wide'), () => [ret(load16(shl(get('q'), i32(1)), IN))]), load8(get('q'), IN)]);
  m.define('lexW', () => [
    if_(get('wide'), () => [ret(call('lex16', get('len_'), get('k_'), get('s_'), get('from_')))]),
    call('lex8', get('len_'), get('k_'), get('s_'), get('from_')),
  ]);
  m.define('min', () => [select(get('a'), get('b'), ltS(get('a'), get('b')))]);
  m.define('max', () => [select(get('a'), get('b'), gtS(get('a'), get('b')))]);
  m.define('ensure', () => [
    set('have', shl(memSize(), i32(16))),
    if_(gtU(get('end'), get('have')), () => [
      if_(eq(memGrow(shrU(add(sub(get('end'), get('have')), i32(0xffff)), i32(16))), i32(-1)), () => [unreachable()]),
    ]),
  ]);
  m.define('rb', () => [get('RB')]);
  m.define('db', () => [get('DB')]);
  m.define('dc', () => [get('DC')]);

  m.define('addRule', () => [
    if_(geU(get('RC'), get('RCAP')), () => [
      // Doubled, the declaration table moved up past it.
      set('cap', shl(get('RCAP'), i32(1))),
      set('a', add(get('RB'), mul(get('cap'), i32(RW * 4)))),
      call('ensure', add(get('a'), mul(get('DCAP'), i32(DW * 4)))),
      copy(get('a'), get('DB'), mul(get('DC'), i32(DW * 4))),
      set('DB', get('a')),
      set('RCAP', get('cap')),
    ]),
    set('r', get('RC')),
    inc('RC'),
    set('a', rAddr(get('r'))),
    store32(get('a'), get('kind'), R.FLAGS * 4),
    ...[R.START, R.END, R.NAME_END, R.PRE_S, R.PRE_E].map(f => store32(get('a'), get('start'), f * 4)),
    store32(get('a'), i32(-1), R.BLK_S * 4),
    store32(get('a'), i32(-1), R.BLK_E * 4),
    store32(get('a'), get('DC'), R.DECLS * 4),
    store32(get('a'), i32(0), R.DCOUNT * 4),
    store32(get('a'), i32(-1), R.CHILD * 4),
    store32(get('a'), i32(-1), R.NEXT * 4),
    get('r'),
  ]);

  m.define('addDecl', () => [
    if_(geU(get('DC'), get('DCAP')), () => [
      set('DCAP', shl(get('DCAP'), i32(1))),
      call('ensure', add(get('DB'), mul(get('DCAP'), i32(DW * 4)))),
    ]),
    set('a', add(get('DB'), mul(get('DC'), i32(DW * 4)))),
    ...(['dF', 'dS', 'dE', 'dN', 'dVS', 'dVE'] as const).map((g, f) => store32(get('a'), get(g), f * 4)),
    inc('DC'),
    rset(get('r'), R.DCOUNT, add(rget(get('r'), R.DCOUNT), i32(1))),
  ]);

  m.define('closer', () => [
    if_(isK(get('t'), Tok.LBrace), () => [ret(i32(Tok.RBrace))]),
    if_(isK(get('t'), Tok.LBracket), () => [ret(i32(Tok.RBracket))]),
    if_(or(isK(get('t'), Tok.LParen), isK(get('t'), Tok.Func)), () => [ret(i32(Tok.RParen))]),
    i32(0),
  ]);
  // §5.5.9 consume a component value: past a whole block or function. The closers awaited are a
  // stack of bytes past the frame, grown a page at a time.
  m.define('value', () => [
    set('c', call('closer', kind(get('i')))),
    inc('i'),
    if_(eqz(get('c')), () => [ret()]),
    set('base', add(get('DB'), mul(get('DCAP'), i32(DW * 4)))),
    set('sp', get('base')),
    set('lim', shl(memSize(), i32(16))),
    block('done', () => [
      loop('push', () => [
        if_(geU(get('sp'), get('lim')), () => [
          call('ensure', add(get('sp'), i32(0x10000))),
          set('lim', shl(memSize(), i32(16))),
        ]),
        store8(get('sp'), get('c')),
        inc('sp'),
        loop('scan', () => [
          brIf('done', or(geS(get('i'), get('N')), eq(get('sp'), get('base')))),
          set('t', kind(get('i'))),
          inc('i'),
          if_(eq(get('t'), load8(sub(get('sp'), i32(1)))), () => [inc('sp', -1), br('scan')]),
          set('c', call('closer', get('t'))),
          brIf('push', get('c')),
          br('scan'),
        ]),
      ]),
    ]),
  ]);

  m.define('trimEnd', () => [
    loop('t', () => [
      if_(gtS(get('j'), get('from')), () => [
        set('t', kind(sub(get('j'), i32(1)))),
        if_(select(isK(get('t'), Tok.Ws), trivia(get('t')), get('ws')), () => [inc('j', -1), br('t')]),
      ]),
    ]),
    pos(get('j')),
  ]);

  m.define('block', () => [
    rset(get('r'), R.BLK_S, pos(get('i'))),
    inc('i'),
    set('style', isK(get('t'), QUALIFIED)),
    if_(get('style'), () => [inc('inStyle')]),
    drop(call('contents', get('r'), and(eqz(get('style')), gtS(get('inStyle'), i32(0))))),
    if_(get('style'), () => [inc('inStyle', -1)]),
    if_(
      isK(kind(get('i')), Tok.RBrace),
      () => [inc('i')],
      () => [rset(get('r'), R.FLAGS, or(get('t'), i32(UNCLOSED)))]
    ),
    rset(get('r'), R.END, pos(get('i'))),
    rset(get('r'), R.BLK_E, pos(get('i'))),
  ]);

  m.define('atRule', () => [
    set('r', call('addRule', i32(AT), pos(get('i')))),
    rset(get('r'), R.NAME_END, pos(add(get('i'), i32(1)))),
    inc('i'),
    set('from', get('i')),
    loop('a', () => [
      set('t', kind(get('i'))),
      if_(
        or(
          or(isK(get('t'), Tok.Eof), isK(get('t'), Tok.Semi)),
          or(isK(get('t'), Tok.LBrace), and(isK(get('t'), Tok.RBrace), get('nested')))
        ),
        () => [
          set('pe', call('trimEnd', get('from'), get('i'), i32(0))),
          set('j', get('from')),
          loop('s', () => [if_(trivia(kind(get('j'))), () => [inc('j'), br('s')])]),
          rset(get('r'), R.PRE_E, get('pe')),
          rset(get('r'), R.PRE_S, min(pos(get('j')), get('pe'))),
          if_(
            isK(get('t'), Tok.LBrace),
            () => [call('block', get('r'), i32(AT))],
            () => [
              if_(
                isK(get('t'), Tok.Semi),
                () => [inc('i'), rset(get('r'), R.END, pos(get('i')))],
                () => [rset(get('r'), R.END, get('pe'))]
              ),
            ]
          ),
          ret(get('r')),
        ]
      ),
      call('value'),
      br('a'),
    ]),
    i32(-1),
  ]);

  m.define('qualified', () => [
    set('from', get('i')),
    loop('q', () => [
      set('t', kind(get('i'))),
      if_(
        or(isK(get('t'), Tok.Eof), and(get('nested'), or(isK(get('t'), Tok.Semi), isK(get('t'), Tok.RBrace)))),
        () => [ret(i32(-1))]
      ),
      if_(isK(get('t'), Tok.LBrace), () => [
        set('custom', i32(0)),
        if_(isK(kind(get('from')), Tok.Ident), () => [
          set('custom', call('dashed', pos(get('from')), pos(add(get('from'), i32(1))))),
        ]),
        set('mm', add(get('from'), i32(1))),
        loop('s', () => [if_(trivia(kind(get('mm'))), () => [inc('mm'), br('s')])]),
        set('r', call('addRule', i32(QUALIFIED), pos(get('from')))),
        rset(get('r'), R.PRE_E, call('trimEnd', get('from'), get('i'), i32(0))),
        call('block', get('r'), i32(QUALIFIED)),
        if_(or(eqz(get('custom')), ne(kind(get('mm')), i32(Tok.Colon))), () => [ret(get('r'))]),
        // dropFrom(r)
        set('DC', rget(get('r'), R.DECLS)),
        set('RC', get('r')),
        ret(i32(-1)),
      ]),
      call('value'),
      br('q'),
    ]),
    i32(-1),
  ]);

  // `text.slice(a, b).toLowerCase() === 'important'`
  m.define('important', () => [
    if_(ne(sub(get('b'), get('a')), i32(9)), () => [ret(i32(0))]),
    ...[...'important'].map((c, k) =>
      if_(ne(or(ch(add(get('a'), i32(k))), i32(32)), i32(c.charCodeAt(0))), () => [ret(i32(0))])
    ),
    i32(1),
  ]);

  // css-outline.ts `dashed`: whether the ident in [a, e) starts with two `-`, escapes decoded.
  m.define('dashed', () => [
    set('n', i32(0)),
    loop('d', () => [
      if_(eq(get('n'), i32(2)), () => [ret(i32(1))]),
      if_(geS(get('a'), get('e')), () => [ret(i32(0))]),
      set('c', ch(get('a'))),
      inc('a'),
      if_(eq(get('c'), i32(45)), () => [inc('n'), br('d')]),
      if_(or(ne(get('c'), i32(92)), geS(get('a'), get('e'))), () => [ret(i32(0))]),
      set('v', i32(0)),
      set('h', i32(0)),
      block('hx', () => [
        loop('hl', () => [
          brIf('hx', or(eq(get('h'), i32(6)), geS(get('a'), get('e')))),
          set('c', ch(get('a'))),
          set('x', i32(-1)),
          if_(leU(sub(get('c'), i32(48)), i32(9)), () => [set('x', sub(get('c'), i32(48)))]),
          if_(leU(sub(or(get('c'), i32(32)), i32(97)), i32(5)), () => [set('x', sub(or(get('c'), i32(32)), i32(87)))]),
          brIf('hx', ltS(get('x'), i32(0))),
          set('v', add(mul(get('v'), i32(16)), get('x'))),
          inc('h'),
          inc('a'),
          br('hl'),
        ]),
      ]),
      if_(eqz(get('h')), () => [if_(ne(ch(get('a')), i32(45)), () => [ret(i32(0))]), inc('a'), inc('n'), br('d')]),
      if_(ne(get('v'), i32(45)), () => [ret(i32(0))]),
      // One whitespace after the digits is part of the escape (CR LF as one).
      if_(ltS(get('a'), get('e')), () => [
        set('c', ch(get('a'))),
        if_(
          or(
            or(eq(get('c'), i32(32)), eq(get('c'), i32(9))),
            or(or(eq(get('c'), i32(10)), eq(get('c'), i32(12))), eq(get('c'), i32(13)))
          ),
          () => [
            inc('a'),
            if_(and(eq(get('c'), i32(13)), ltS(get('a'), get('e'))), () => [
              if_(eq(ch(get('a')), i32(10)), () => [inc('a')]),
            ]),
          ]
        ),
      ]),
      inc('n'),
      br('d'),
    ]),
    i32(0),
  ]);

  m.define('declaration', () => [
    if_(ne(kind(get('i')), i32(Tok.Ident)), () => [ret(i32(0))]),
    set('start', pos(get('i'))),
    inc('i'),
    set('nameEnd', pos(get('i'))),
    loop('s1', () => [if_(trivia(kind(get('i'))), () => [inc('i'), br('s1')])]),
    if_(ne(kind(get('i')), i32(Tok.Colon)), () => [ret(i32(0))]),
    inc('i'),
    loop('s2', () => [if_(trivia(kind(get('i'))), () => [inc('i'), br('s2')])]),
    set('from', get('i')),
    // Whether the name is a custom property's, with escapes decoded (`dashed`: `--x`, `\2d-x`):
    // any other's value is given up at its first `{`, as in css-outline.ts, not scanned on to the
    // end of the parent's block.
    set('custom', call('dashed', get('start'), get('nameEnd'))),
    set('last', i32(-1)),
    set('prev', i32(-1)),
    block('done', () => [
      loop('v', () => [
        set('t', kind(get('i'))),
        brIf('done', or(or(isK(get('t'), Tok.Eof), isK(get('t'), Tok.Semi)), isK(get('t'), Tok.RBrace))),
        if_(eqz(trivia(get('t'))), () => [
          set('prev', get('last')),
          set('last', get('i')),
          if_(and(isK(get('t'), Tok.LBrace), eqz(get('custom'))), () => [ret(i32(0))]),
        ]),
        call('value'),
        br('v'),
      ]),
    ]),
    set('imp', i32(0)),
    if_(geS(get('prev'), i32(0)), () => [
      if_(and(isK(kind(get('prev')), Tok.Delim), eq(ch(pos(get('prev'))), i32(33))), () => [
        if_(isK(kind(get('last')), Tok.Ident), () => [
          set('imp', call('important', pos(get('last')), pos(add(get('last'), i32(1))))),
        ]),
      ]),
    ]),
    set('ve', call('trimEnd', get('from'), select(get('prev'), get('i'), get('imp')), i32(1))),
    set('semi', isK(kind(get('i')), Tok.Semi)),
    if_(
      get('semi'),
      () => [inc('i'), set('end', pos(get('i')))],
      () => [set('end', call('trimEnd', get('from'), get('i'), i32(0)))]
    ),
    set('dF', or(select(i32(IMPORTANT), i32(0), get('imp')), select(i32(SEMICOLON), i32(0), get('semi')))),
    set('dS', get('start')),
    set('dE', max(max(get('end'), get('ve')), get('nameEnd'))),
    set('dN', get('nameEnd')),
    set('dVS', min(pos(get('from')), get('ve'))),
    set('dVE', get('ve')),
    i32(1),
  ]);

  // Whether `text.slice(a, b).trim()` is empty: every code unit is one String#trim removes.
  const jsSpace = (c: A.Code) =>
    or(
      or(or(and(geU(c, i32(9)), leU(c, i32(13))), eq(c, i32(32))), or(eq(c, i32(0xa0)), eq(c, i32(0x1680)))),
      or(
        or(and(geU(c, i32(0x2000)), leU(c, i32(0x200a))), or(eq(c, i32(0x2028)), eq(c, i32(0x2029)))),
        or(or(eq(c, i32(0x202f)), eq(c, i32(0x205f))), or(eq(c, i32(0x3000)), eq(c, i32(0xfeff))))
      )
    );
  m.define('jsWs', () => [
    loop('w', () => [
      if_(geS(get('a'), get('b')), () => [ret(i32(1))]),
      set('c', ch(get('a'))),
      if_(eqz(jsSpace(get('c'))), () => [ret(i32(0))]),
      inc('a'),
      br('w'),
    ]),
    i32(1),
  ]);

  const frame = ['K', 'S', 'N', 'LEN', 'RB', 'DB', 'RC', 'DC', 'RCAP', 'DCAP', 'i', 'inStyle'];
  m.define('commented', () => [
    // No declaration without a colon.
    set('q', add(get('start'), i32(2))),
    block('found', () => [
      loop('c', () => [
        if_(geS(get('q'), get('end')), () => [ret(i32(0))]),
        brIf('found', eq(ch(get('q')), i32(58))),
        inc('q'),
        br('c'),
      ]),
    ]),
    set('innerS', add(get('start'), i32(2))),
    set('L', sub(get('end'), get('innerS'))),
    if_(geS(sub(get('end'), get('start')), i32(4)), () => [
      if_(and(eq(ch(sub(get('end'), i32(2))), i32(42)), eq(ch(sub(get('end'), i32(1))), i32(47))), () => [
        inc('L', -2),
      ]),
    ]),
    ...frame.map(g => set('s' + (g === 'inStyle' ? 'In' : g === 'i' ? 'I' : g), get(g))),
    // A new frame past this one.
    set('w', add(get('wide'), i32(1))),
    set('X', align4(add(get('DB'), mul(get('DCAP'), i32(DW * 4))))),
    set('o', shrU(sub(get('X'), i32(IN)), get('wide'))),
    set('K', align4(add(get('X'), mul(add(get('L'), i32(PAD)), get('w'))))),
    set('S', align4(add(add(get('K'), get('L')), i32(4)))),
    set('RB', add(get('S'), shl(add(get('L'), i32(2)), i32(2)))),
    set('RCAP', i32(4)),
    set('DCAP', i32(4)),
    set('DB', add(get('RB'), i32(4 * RW * 4))),
    call('ensure', add(get('DB'), i32(4 * DW * 4))),
    copy(get('X'), add(i32(IN), mul(get('innerS'), get('w'))), mul(get('L'), get('w'))),
    fill(add(get('X'), mul(get('L'), get('w'))), i32(0), mul(i32(PAD), get('w'))),
    set('LEN', add(get('o'), get('L'))),
    set('N', call('lexW', get('LEN'), get('K'), get('S'), get('o'))),
    store8(add(get('K'), get('N')), i32(Tok.Eof)),
    set('RC', i32(0)),
    set('DC', i32(0)),
    set('i', i32(0)),
    set('inStyle', i32(0)),
    drop(call('addRule', i32(QUALIFIED), get('o'))),
    set('last', call('contents', i32(0), i32(0))),
    if_(ltS(get('i'), get('N')), () => [
      set('stray', call('addRule', i32(QUALIFIED), pos(get('i')))),
      if_(
        ltS(get('last'), i32(0)),
        () => [rset(i32(0), R.CHILD, get('stray'))],
        () => [rset(get('last'), R.NEXT, get('stray'))]
      ),
    ]),
    set('ok', i32(0)),
    if_(and(eq(rget(i32(0), R.DCOUNT), i32(1)), ltS(rget(i32(0), R.CHILD), i32(0))), () => [
      set('d', add(get('DB'), mul(rget(i32(0), R.DECLS), i32(DW * 4)))),
      if_(call('jsWs', get('o'), load32(get('d'), 4)), () => [
        if_(call('jsWs', load32(get('d'), 8), get('LEN')), () => [
          set('ok', i32(1)),
          set('dF', or(i32(COMMENT), and(load32(get('d'), 0), i32(IMPORTANT | SEMICOLON)))),
          ...(['dS', 'dE', 'dN', 'dVS', 'dVE'] as const).map((g, f) =>
            set(g, add(sub(load32(get('d'), (f + 1) * 4), get('o')), get('innerS')))
          ),
        ]),
      ]),
    ]),
    ...frame.map(g => set(g, get('s' + (g === 'inStyle' ? 'In' : g === 'i' ? 'I' : g)))),
    get('ok'),
  ]);

  m.define('contents', () => {
    const link = (child: A.Code) => [
      if_(
        ltS(get('last'), i32(0)),
        () => [rset(get('r'), R.CHILD, child)],
        () => [rset(get('last'), R.NEXT, child)]
      ),
      set('last', child),
    ];
    const addD = () => [
      if_(and(eqz(get('own')), ltS(get('group'), i32(0))), () => [
        set('group', call('addRule', i32(NESTED), get('dS'))),
        ...link(get('group')),
      ]),
      call('addDecl', select(get('r'), get('group'), get('own'))),
      if_(geS(get('group'), i32(0)), () => [rset(get('group'), R.END, get('dE'))]),
    ];
    const nest = (child: A.Code) => [set('q', child), ...link(get('q')), set('own', i32(0)), set('group', i32(-1))];
    return [
      set('own', eqz(get('wrap'))),
      set('group', i32(-1)),
      set('last', i32(-1)),
      loop('c', () => [
        set('t', kind(get('i'))),
        if_(or(isK(get('t'), Tok.Eof), isK(get('t'), Tok.RBrace)), () => [ret(get('last'))]),
        if_(isK(get('t'), Tok.Comment), () => [
          if_(call('commented', pos(get('i')), pos(add(get('i'), i32(1)))), addD),
          inc('i'),
          br('c'),
        ]),
        if_(or(isK(get('t'), Tok.Ws), isK(get('t'), Tok.Semi)), () => [inc('i'), br('c')]),
        if_(isK(get('t'), Tok.At), () => [...nest(call('atRule', i32(1))), br('c')]),
        set('mark', get('i')),
        if_(call('declaration'), addD, () => [
          set('i', get('mark')),
          set('q', call('qualified', i32(1))),
          if_(geS(get('q'), i32(0)), () => nest(get('q'))),
        ]),
        br('c'),
      ]),
      i32(-1),
    ];
  });

  m.define('run', () => [
    set('wide', get('wide16')),
    set('K', get('kinds')),
    set('S', get('starts')),
    set('LEN', get('n0')),
    set('N', call('lexW', get('n0'), get('K'), get('S'), i32(0))),
    if_(and(get('flags'), i32(LEX_ONLY)), () => [ret(get('N'))]),
    // kind(N) is Eof, as css-outline.ts's `kinds[j] ?? Tok.Eof`: the caller leaves room for it.
    store8(add(get('K'), get('N')), i32(Tok.Eof)),
    set('RB', add(get('S'), shl(add(get('N'), i32(1)), i32(2)))),
    // As css-outline.ts sizes its tables.
    set('RCAP', add(add(shrU(get('N'), i32(4)), shrU(get('N'), i32(6))), i32(4))),
    set('DCAP', add(shrU(get('N'), i32(3)), i32(4))),
    set('DB', add(get('RB'), mul(get('RCAP'), i32(RW * 4)))),
    call('ensure', add(get('DB'), mul(get('DCAP'), i32(DW * 4)))),
    set('RC', i32(0)),
    set('DC', i32(0)),
    set('i', i32(0)),
    set('inStyle', i32(0)),
    drop(call('addRule', i32(QUALIFIED), i32(0))),
    set('last', i32(-1)),
    loop('top', () => [
      if_(ltS(get('i'), get('N')), () => [
        set('t', kind(get('i'))),
        set('r', i32(-1)),
        if_(
          or(trivia(get('t')), or(isK(get('t'), Tok.Cdo), isK(get('t'), Tok.Cdc))),
          () => [inc('i')],
          () => [
            if_(
              isK(get('t'), Tok.At),
              () => [set('r', call('atRule', i32(0)))],
              () => [set('r', call('qualified', i32(0)))]
            ),
          ]
        ),
        if_(geS(get('r'), i32(0)), () => [
          if_(
            ltS(get('last'), i32(0)),
            () => [rset(i32(0), R.CHILD, get('r'))],
            () => [rset(get('last'), R.NEXT, get('r'))]
          ),
          set('last', get('r')),
        ]),
        br('top'),
      ]),
    ]),
    get('RC'),
  ]);
}
