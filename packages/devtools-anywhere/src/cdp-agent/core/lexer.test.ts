import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { build } from 'esbuild';

// Bundled: lexer-queries.ts imports lexer.ts without an extension, which Node does not resolve.
const bundled = await build({
  stdin: {
    contents: "export * from './lexer.ts'; export * from './lexer-queries.ts';",
    resolveDir: dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const {
  debuggerStatementSites,
  debuggerStatements,
  Kind,
  tokenize,
  lastExpressionStatement,
  returnOutsideFunction,
  topLevelLexicalDeclarations,
  topLevelLexicalNames,
  topLevelVarNames,
}: typeof import('./lexer.ts') & typeof import('./lexer-queries.ts') = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
);

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

test('regex vs division', () => {
  const kinds = (s: string) => {
    const tokens = tokenize(s);
    const regexes: string[] = [];
    for (let i = 0; i < tokens.length; i++)
      if (tokens.kinds[i] === Kind.Regex) regexes.push(s.slice(tokens.starts[i], tokens.ends[i]));
    return regexes;
  };
  assert.deepEqual(kinds('a = (b) / 2 / c'), []);
  assert.deepEqual(kinds('a = x[0] / 2 / c'), []);
  assert.deepEqual(kinds('if (x) /re/.test(y)'), ['/re/']);
  assert.deepEqual(kinds('while (x) /re/g.exec(y)'), ['/re/g']);
  assert.deepEqual(kinds('x++ /2/ 1'), []);
  assert.deepEqual(kinds('x-- /2/ 1'), []);
  assert.deepEqual(kinds('1. / 2 / 3'), []);
  assert.deepEqual(kinds('a = /[/\\]]+/; b = 1 / 2'), ['/[/\\]]+/']);
  assert.deepEqual(kinds('function f() {}\n/re/.test(s)'), ['/re/']);
  assert.deepEqual(kinds('x = {} / 2'), []);
  assert.deepEqual(kinds('x = () => {}\n/re/'), ['/re/']);
  assert.deepEqual(kinds('class A {}\n/re/'), ['/re/']);
  assert.deepEqual(kinds('return /re/'), ['/re/']);
  assert.deepEqual(kinds('typeof /re/'), ['/re/']);
  assert.deepEqual(kinds('l: for (;;) { break l\n/re/ }'), ['/re/']);
  assert.deepEqual(kinds('for (const a of /re/g.exec(s)) {}'), ['/re/g']);
  assert.deepEqual(kinds('`a${ `b${ /c/ }` }d` / 2'), ['/c/']);
  assert.deepEqual(kinds('x = `${a}` / 2'), []);
});

test('token arrays grow past their first guess and keep every field', () => {
  // A token per code unit: three times what the arrays are first sized for.
  const source = 'a;'.repeat(50_000) + '\n`x${1}y`';
  const tokens = tokenize(source);
  assert.equal(tokens.length, 100_003);
  assert.equal(tokens.kinds.length, tokens.length);
  assert.deepEqual([tokens.kinds[99_999], tokens.starts[99_999], tokens.ends[99_999]], [Kind.Punct, 99_999, 100_000]);
  const last = tokens.length - 1;
  assert.deepEqual(
    [tokens.kinds[last], tokens.starts[last], tokens.ends[last], tokens.depths[last], tokens.newlines[last]],
    [Kind.Template, 100_006, 100_009, 1, 0]
  );
  assert.equal(tokens.newlines[100_000], 1);
});

test('token arrays grow again when the source gets denser than its start suggested', () => {
  // A sparse start (long comments, a word and a `;` each) makes each guess from the density read
  // so far low: the dense tail needs several grows, each keeping what came before.
  const head = '/*' + ' '.repeat(40_000) + '*/ ' + 'longidentifier_'.repeat(2) + ';\n';
  const source = head.repeat(10) + 'a,'.repeat(300_000) + 'z';
  const tokens = tokenize(source);
  const expected = 10 * 2 + 600_001;
  assert.equal(tokens.length, expected);
  for (const array of [tokens.kinds, tokens.starts, tokens.ends, tokens.depths, tokens.parents, tokens.newlines])
    assert.equal(array.length, expected);
  for (let i = 0; i < 10; i++) {
    assert.equal(tokens.starts[2 * i], i * head.length + 40_005);
    assert.equal(tokens.newlines[2 * i], i === 0 ? 0 : 1);
  }
  const at = head.length * 10;
  assert.deepEqual([tokens.starts[20], tokens.ends[20], tokens.kinds[20]], [at, at + 1, Kind.Word]);
  assert.deepEqual([tokens.starts[expected - 1], tokens.kinds[expected - 1]], [source.length - 1, Kind.Word]);
  assert.equal(
    tokens.starts.every((start, i) => i === 0 || start > (tokens.starts[i - 1] ?? 0)),
    true
  );
});

test('top-level lexical names', () => {
  assert.deepEqual(topLevelLexicalNames('let a = 1, b\nconst c = 2; class D {}'), ['a', 'b', 'c', 'D']);
  assert.deepEqual(topLevelLexicalNames('const { a, b: c, d = 1, [k]: e, ...f } = o, [g, , [h], i = 2, ...j] = p'), [
    'a',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
  ]);
  assert.deepEqual(topLevelLexicalNames('let = 1; let.x = 2; let(0); let\nin x'), []);
  assert.deepEqual(topLevelLexicalNames('let\nx = 1'), ['x']);
  assert.deepEqual(topLevelLexicalNames('{ let a } function f() { const b } if (x) { class C {} }'), []);
  assert.deepEqual(topLevelLexicalNames('for (let i = 0;;) {} x = class A {}'), []);
  assert.deepEqual(topLevelLexicalNames('a = b\nlet c = d\n(e)\nconst f = g'), ['c', 'f']);
  assert.deepEqual(topLevelLexicalNames('let a = () => { let b }, c = function () {}'), ['a', 'c']);
  assert.deepEqual(topLevelLexicalNames('"let x"; // let y\n/* const z */ `${"let w"}`; /let v/'), []);
  assert.deepEqual(topLevelLexicalNames('let a = x ? y : z, b = { k: 1 }.k / 2\nclass B extends C {}'), [
    'a',
    'b',
    'B',
  ]);
  assert.deepEqual(topLevelLexicalNames('#!/usr/bin/env node\nconst a = 1'), ['a']);
  assert.deepEqual(topLevelLexicalNames('<!-- let a\nconst b = 1 --> 0\n--> let c'), ['b']);
});

test('`-->` starts a comment only at the start of a line, in debugger mode too', () => {
  // x-- > 0 mid-line: an operator, the debugger after it is a statement.
  assert.deepEqual(debuggerStatements('x-->0; debugger'), [7]);
  assert.deepEqual(debuggerStatements('x = 1\nx-->0; debugger'), [13]);
  // At the start of the source or of a line (after spaces): a comment to the end of the line.
  assert.deepEqual(debuggerStatements('--> debugger\ndebugger'), [13]);
  assert.deepEqual(debuggerStatements('x\n  --> debugger\ndebugger'), [17]);
  // After a comment: a comment too when it is the first thing, or when a line break came before.
  assert.deepEqual(debuggerStatements('/* c */ --> debugger\ndebugger'), [21]);
  assert.deepEqual(debuggerStatements('x /*\n*/ --> debugger\ndebugger'), [21]);
  assert.deepEqual(debuggerStatements('x /* c */ --> 0; debugger'), [17]);
  // Modules have no HTML-like comments.
  assert.deepEqual(debuggerStatements('--> 0; debugger', { module: true }), [7]);
  // The token list agrees.
  const tokens = tokenize('x-->0; debugger');
  assert.equal(tokens.length, 7);
});

test('debugger statements', () => {
  const src = [
    'debugger;',
    'obj.debugger; obj?.debugger; o = { debugger: 1, debugger() {}, get debugger() {} };',
    'class A { debugger() {} static debugger = 1; #debugger; m() { debugger } }',
    '"debugger"; `debugger ${ "x" } debugger`; // debugger',
    '/debugger/; /* debugger */',
    'if (x) debugger; else { label: debugger }',
    'f(() => { debugger })',
  ].join('\n');
  const want = expected(src)?.debuggers;
  assert.equal(want?.length, 5);
  assert.deepEqual(debuggerStatements(src), want);
  assert.deepEqual(debuggerStatements('x = /[/]debugger/; debugger'), [19]);
});

test('unicode escapes and exports', () => {
  assert.deepEqual(topLevelLexicalNames('let \\u0061 = 1, \\u{62}c = 2; cl\\u0061ss = 3'), ['a', 'bc']);
  assert.deepEqual(debuggerStatements('debu\\u0067ger; o.debu\\u{67}ger'), [0]);
  assert.deepEqual(
    topLevelLexicalNames('export\nconst a = 1\nexport default\nclass B {}\nx.export\nconst c = 1', {
      module: true,
    }),
    ['c']
  );
});

test('return outside functions', () => {
  for (const source of [
    'return 1',
    '{ return 1 }',
    'if (x) return',
    'for (;;) { return }',
    'x = () => new.target',
    'return (x)',
    'o = { a: 1 }; return (o)',
    'a = `${() => 1}`; return',
    // Escaped words spell the keyword.
    '\\u0072eturn 1',
    're\\u{74}urn',
    'x = new.\\u0074arget',
    'f(function () {}, () => {}); [{ a: `${1}` }]; return',
    'try {} catch (e) { return 1 }',
    'for await (const a of b) { return 1 }',
  ])
    assert.equal(returnOutsideFunction(source), true, source);
  for (const source of [
    'function f() { return 1 }',
    'o = { m() { if (x) { return } } }',
    'class A { m() { return new.target } }',
    'f = () => { return 1 }',
    'g = function () { { return } }',
    'x.return; y = { return: 1 }',
    'o = { return() { return 1 } }; x?.return; class C { return() {} static return = 1 }',
    'o = { get return() { return 1 }, async return() {} }',
    'returned; return\\u0061; \\u0072eturns; newer.target',
    'f(() => { [x, { y: `${() => { return }}` }] })',
    // Methods named like a statement keyword.
    'let x = 1; class P { catch(f) { return f } }',
    'class P { a() {} catch(f) { return f } }',
    'class T { then(f) { return f } catch(g) { return g } }',
    '({ if() { return 1 } })',
    'x = { a, while(q) { return 1 } }',
    '({ async for(q) { return 1 } })',
  ])
    assert.equal(returnOutsideFunction(source), false, source);
});

test('only identifiers bind', () => {
  assert.deepEqual(topLevelLexicalNames('let [a, 0, this] = x; const {b: c, d = 1} = y; let é\u0301 = 1'), [
    'a',
    'c',
    'd',
    'é\u0301',
  ]);
});

test('code acorn rejects is skipped, not thrown on', () => {
  for (const source of ['let[0] = 2', 'let let = 1', 'class {}', 'const a']) {
    assert.equal(expected(source), undefined);
    assert.ok(Array.isArray(topLevelLexicalNames(source)));
  }
});

test('debugger statement sites tell a following semicolon', () => {
  assert.deepEqual(
    debuggerStatementSites('debugger /*x*/;\ndebugger\n;\ndebugger\n(x)').map(site => site.semicolon),
    [true, true, false]
  );
  // At the end of the source, before `}`, and past a comment and a line break.
  for (const source of ['debugger', 'function f() { debugger }', 'debugger // c\n;', 'debugger /* c\n */ ;'])
    assert.deepEqual(debuggerStatementSites(source), expected(source)?.sites, source);
});

test('a hashbang ends at its line break, even an empty one', () => {
  assert.deepEqual(debuggerStatements('#!\ndebugger\nfoo()'), [3]);
  assert.deepEqual(debuggerStatements('#!/usr/bin/env node\ndebugger'), [20]);
  const tokens = tokenize('#!x\nfoo');
  assert.deepEqual([tokens.length, tokens.starts[0]], [1, 4]);
});

test('debugger on its own line before `(` names an object literal method', () => {
  for (const source of [
    '({ debugger\n() { return 1 } })',
    'x = { a, debugger\n() {} }',
    'x = { get debugger\n() {} }',
    'x = { *debugger\n() {} }',
    'f({ debugger\n() {} })',
  ])
    assert.deepEqual(debuggerStatements(source), [], source);
  // A block's statement, then a parenthesized expression.
  assert.deepEqual(debuggerStatements('{ debugger\n(f) }'), [2]);
  assert.deepEqual(debuggerStatements('if (a) { debugger\n(f) }'), [9]);
  assert.deepEqual(debuggerStatements('() => { debugger\n(f) }'), [8]);
});

test('long words are debugger only with escapes', () => {
  assert.deepEqual(debuggerStatements('addEventListener; debuggerX; d\\u0065bugger'), [29]);
});

test('non-ASCII line terminators and white space', () => {
  for (const br of ['\u2028', '\u2029'])
    for (const source of [`let${br}x = 1`, `a${br}debugger${br}(f)`, `x = 1${br}/re/g.test(s)`]) {
      const want = expected(source);
      assert.deepEqual(topLevelLexicalNames(source), want?.names, source);
      assert.deepEqual(debuggerStatementSites(source), want?.sites, source);
    }
  assert.equal(lastExpressionStatement('a = 1\u2028b'), 6);
  for (const ws of ['\u00a0', '\ufeff', '\u3000', '\u2003'])
    for (const source of [`x;${ws}debugger${ws};`, `let${ws}a${ws}=${ws}1`]) {
      const want = expected(source);
      assert.deepEqual(topLevelLexicalNames(source), want?.names, source);
      assert.deepEqual(debuggerStatementSites(source), want?.sites, source);
    }
});

test('last expression statement', () => {
  const last = (s: string) => {
    const at = lastExpressionStatement(s);
    return at === undefined ? undefined : s.slice(at);
  };
  assert.equal(last('await a; b + 1'), 'b + 1');
  assert.equal(last('let a = await b\na'), 'a');
  assert.equal(last('x = 1\n(f)()'), 'x = 1\n(f)()');
  assert.equal(last('if (a) {}\nlet b = 1'), undefined);
  assert.equal(last('a; { b }'), undefined);
  assert.equal(last('a;'), 'a;');
  // After a block's or a declaration's `}` on the same line.
  assert.equal(last('async function f(){ return 1 } await f()'), 'await f()');
  assert.equal(last('if (a) {} await b'), 'await b');
  assert.equal(last('for (const x of xs) {} await y'), 'await y');
  assert.equal(last('class A {} 1'), '1');
  assert.equal(last('if (a) {1} else {2}'), undefined);
  assert.equal(last('try {} catch {} finally {}'), undefined);
  assert.equal(last('x = {a: 1}'), 'x = {a: 1}');
  assert.equal(last('x = function () {} + 1'), 'x = function () {} + 1');
  // A function body's `}` before `(` or `[` is called or indexed; a statement's block is not.
  assert.equal(last('!function (e) {}(this)'), '!function (e) {}(this)');
  assert.equal(last('x = function () {}[0]'), 'x = function () {}[0]');
  assert.equal(last('if (a) {}(f)'), '(f)');
  // A line break before what goes on with the expression does not end it.
  assert.equal(last('a\n`t`'), 'a\n`t`');
  assert.equal(last('a\nin b'), 'a\nin b');
  assert.equal(last('a\ninstanceof B'), 'a\ninstanceof B');
  assert.equal(last('a = [1\n]'), 'a = [1\n]');
  assert.equal(last('a\n.b'), 'a\n.b');
  // A postfix `++` cannot follow a line break: it starts the next statement.
  assert.equal(last('a\n++b'), '++b');
  assert.equal(last('a\n[0]'), 'a\n[0]');
  // Labels and `async` are left to a statement.
  assert.equal(last('x: a'), undefined);
  assert.equal(last('async () => 1'), undefined);
});

test('recovers from syntax errors', () => {
  assert.deepEqual(topLevelLexicalNames(') ] } let a; "unterminated\nconst b = 1'), ['a', 'b']);
  assert.deepEqual(debuggerStatements('`unterminated ${ debugger'), [17]);
});

test('a pattern cut short by a semicolon ends', () => {
  // These used to loop forever.
  assert.deepEqual(topLevelLexicalNames('let [a;'), ['a']);
  assert.deepEqual(topLevelLexicalNames('let [a = 1;'), ['a']);
  assert.deepEqual(topLevelLexicalNames('let {a;'), ['a']);
  assert.deepEqual(topLevelVarNames('var [a;'), ['a']);
});

test('top-level var names', () => {
  assert.deepEqual(topLevelVarNames('var a = 1, { b, c: [d] } = o, ...e\nvar f'), ['a', 'b', 'd', 'f']);
  // Not inside a block, a function or a `for` head.
  assert.deepEqual(topLevelVarNames('{ var a } function f() { var b } for (var c of d) {}'), []);
  // A line break ends the declaration without `;`.
  assert.deepEqual(topLevelVarNames('var a = 1\nb = 2\nvar c'), ['a', 'c']);
  assert.deepEqual(topLevelVarNames('x.var = 1; ({ var: 1 })'), []);
});

test('top-level lexical declarations: bare names and offsets', () => {
  const declarations = (s: string) =>
    topLevelLexicalDeclarations(s).map(d => ({ ...d, text: s.slice(d.start, d.end) }));
  assert.deepEqual(declarations('let a, b = 1, [c] = d;\nconst e = 2\nclass F { m() {} } f()'), [
    { kind: 'let', names: ['a', 'b', 'c'], bare: ['a'], start: 0, end: 22, text: 'let a, b = 1, [c] = d;' },
    { kind: 'const', names: ['e'], bare: [], start: 23, end: 34, text: 'const e = 2' },
    { kind: 'class', names: ['F'], bare: [], start: 35, end: 53, text: 'class F { m() {} }' },
  ]);
  for (const source of ['let a\n;', 'let { a } = o, b', 'class A extends B {}; const c = 1 /* c */;']) {
    const want = expected(source)?.declarations;
    assert.deepEqual(
      topLevelLexicalDeclarations(source).map(({ bare, start, end }) => ({ bare, start, end })),
      want,
      source
    );
  }
});

test('class bodies: without a space, and not a brace in the heritage', () => {
  assert.deepEqual(debuggerStatements('x=class{debugger=1}'), []);
  assert.deepEqual(debuggerStatements('class A extends f({}) { debugger = 1 }'), []);
  assert.deepEqual(debuggerStatements('class A extends f({ m() { debugger } }) {}'), [26]);
});

// Corpus comparison with acorn.

function collect(dir: string, out: string[], limit: number) {
  // es-module-lexer.ignore is a local, git-ignored checkout: the corpus goes without it when absent.
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    if (out.length >= limit) return;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collect(path, out, limit);
    else if (name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs')) out.push(path);
  }
}

interface Expected {
  names: string[];
  debuggers: number[];
  /** Each `debugger` with whether acorn's next token is a `;`. */
  sites: { start: number; semicolon: boolean }[];
  module: boolean;
  varNames: string[];
  /** Each top-level `let`, `const` and `class` declaration's names without an initializer, and offsets. */
  declarations: { bare: string[]; start: number; end: number }[];
  /** Offset of the last top-level statement when it is an expression statement. */
  last: number | undefined;
}

function patternNames(node: acorn.Pattern, out: string[]) {
  switch (node.type) {
    case 'Identifier':
      out.push(node.name);
      break;
    case 'ObjectPattern':
      for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern':
      for (const e of node.elements) if (e) patternNames(e, out);
      break;
    case 'RestElement':
      patternNames(node.argument, out);
      break;
    case 'AssignmentPattern':
      patternNames(node.left, out);
      break;
    case 'MemberExpression':
      break;
  }
}

function expected(source: string): Expected | undefined {
  let program: acorn.Program | undefined;
  let module = false;
  const debuggers: number[] = [];
  const sites: { start: number; semicolon: boolean }[] = [];
  let after = false;
  const onToken = (token: acorn.Token) => {
    if (after) {
      const last = sites[sites.length - 1];
      if (last) last.semicolon = token.type === acorn.tokTypes.semi;
      after = false;
    }
    if (token.type === acorn.tokTypes._debugger) {
      debuggers.push(token.start);
      sites.push({ start: token.start, semicolon: false });
      after = true;
    }
  };
  for (const sourceType of ['script', 'module'] as const) {
    debuggers.length = 0;
    sites.length = 0;
    after = false;
    try {
      program = acorn.parse(source, { ecmaVersion: 'latest', sourceType, onToken });
      module = sourceType === 'module';
      break;
    } catch {
      program = undefined;
    }
  }
  if (!program) return undefined;
  const names: string[] = [];
  const varNames: string[] = [];
  const declarations: Expected['declarations'] = [];
  for (const node of program.body) {
    if (node.type === 'VariableDeclaration' && node.kind === 'var')
      for (const d of node.declarations) patternNames(d.id, varNames);
    else if (node.type === 'VariableDeclaration') {
      const bare: string[] = [];
      for (const d of node.declarations) {
        patternNames(d.id, names);
        if (d.id.type === 'Identifier' && !d.init) bare.push(d.id.name);
      }
      declarations.push({ bare, start: node.start, end: node.end });
    } else if (node.type === 'ClassDeclaration' && node.id) {
      names.push(node.id.name);
      declarations.push({ bare: [], start: node.start, end: node.end });
    }
  }
  const final = program.body[program.body.length - 1];
  const last = final?.type === 'ExpressionStatement' ? final.start : undefined;
  return { names, debuggers, sites, module, varNames, declarations, last };
}

test('agrees with acorn on real code', () => {
  const require = createRequire(import.meta.url);
  const files: string[] = [];
  collect(join(root, 'es-module-lexer.ignore/test/samples'), files, 40);
  collect(join(dirname(require.resolve('puppeteer-core/package.json')), 'lib/esm'), files, 360);
  collect(join(dirname(require.resolve('acorn/package.json')), 'dist'), files, 420);
  collect(join(dirname(require.resolve('vite/package.json')), 'dist'), files, 480);
  let compared = 0;
  const mismatches: string[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (source.length > 2_000_000) continue;
    const want = expected(source);
    if (!want) continue;
    compared++;
    const options = { module: want.module };
    const names = topLevelLexicalNames(source, options);
    const sites = debuggerStatementSites(source, options);
    if (JSON.stringify(names) !== JSON.stringify(want.names))
      mismatches.push(`${file}: names ${JSON.stringify(names)} != ${JSON.stringify(want.names)}`);
    if (JSON.stringify(sites) !== JSON.stringify(want.sites))
      mismatches.push(`${file}: debugger ${JSON.stringify(sites)} != ${JSON.stringify(want.sites)}`);
    const varNames = topLevelVarNames(source, options);
    if (JSON.stringify(varNames) !== JSON.stringify(want.varNames))
      mismatches.push(`${file}: var ${JSON.stringify(varNames)} != ${JSON.stringify(want.varNames)}`);
    const declarations = topLevelLexicalDeclarations(source, options).map(({ bare, start, end }) => ({
      bare,
      start,
      end,
    }));
    if (JSON.stringify(declarations) !== JSON.stringify(want.declarations))
      mismatches.push(`${file}: declarations ${JSON.stringify(declarations)} != ${JSON.stringify(want.declarations)}`);
    // An expression statement starting with `async` or a label is left to a statement on purpose.
    const last = lastExpressionStatement(source, options);
    if (last !== want.last && !(want.last !== undefined && /^async\b/.test(source.slice(want.last))))
      mismatches.push(`${file}: last expression ${last} != ${want.last}`);
  }
  console.log(`lexer corpus: ${compared} files compared`);
  assert.ok(compared > 100);
  assert.deepEqual(mismatches, []);
});
