import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import {
  debuggerStatementSites,
  debuggerStatements,
  lastExpressionStatement,
  returnOutsideFunction,
  topLevelLexicalNames,
  topLevelVarNames,
  tokenize,
} from './lexer.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

test('regex vs division', () => {
  const kinds = (s: string) =>
    tokenize(s)
      .filter(t => t.kind === 'regex')
      .map(t => s.slice(t.start, t.end));
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
  module: boolean;
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
  const onToken = (token: acorn.Token) => {
    if (token.type === acorn.tokTypes._debugger) debuggers.push(token.start);
  };
  for (const sourceType of ['script', 'module'] as const) {
    debuggers.length = 0;
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
  for (const node of program.body) {
    if (node.type === 'VariableDeclaration' && node.kind !== 'var')
      for (const d of node.declarations) patternNames(d.id, names);
    else if (node.type === 'ClassDeclaration' && node.id) names.push(node.id.name);
  }
  return { names, debuggers, module };
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
    const debuggers = debuggerStatements(source, options);
    if (JSON.stringify(names) !== JSON.stringify(want.names))
      mismatches.push(`${file}: names ${JSON.stringify(names)} != ${JSON.stringify(want.names)}`);
    if (JSON.stringify(debuggers) !== JSON.stringify(want.debuggers))
      mismatches.push(`${file}: debugger ${JSON.stringify(debuggers)} != ${JSON.stringify(want.debuggers)}`);
  }
  console.log(`lexer corpus: ${compared} files compared`);
  assert.ok(compared > 100);
  assert.deepEqual(mismatches, []);
});
