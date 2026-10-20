// Console input in REPL mode (what the Console panel sends) against Chrome's: top-level let /
// const / class kept across commands and seen by page scripts, declared again without error, a
// const that cannot be assigned, top-level await. Each side gets its own page, since the
// declarations are global.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from './harness.ts';
import type { Env, Side, TestPage } from './harness.ts';

let env: Env | undefined;
let chromePage: TestPage;
let oursPage: TestPage;

before(async () => {
  env = await launch();
  chromePage = await openPage(env, []);
  oursPage = await openPage(env, []);
});
after(() => env?.close());

/** What a result says, without object ids and stacks. */
function outcome(response: Protocol.Runtime.EvaluateResponse) {
  const { result, exceptionDetails } = response;
  return {
    type: result.type,
    value: result.value,
    className: result.className,
    description: result.description?.split('\n')[0],
    threw: !!exceptionDetails,
    at: exceptionDetails?.stackTrace?.callFrames
      .slice(0, 1)
      .map(frame => `${frame.lineNumber}:${frame.columnNumber}`)[0],
  };
}

async function both(expression: string, compare = true) {
  const send = (side: Side) => side.send('Runtime.evaluate', { expression, replMode: true });
  const chrome = outcome(await send(chromePage.chrome));
  const ours = outcome(await send(oursPage.ours));
  if (compare) assert.deepEqual(ours, chrome, expression);
  return { ours, chrome };
}

test('let, const and class are kept across commands and declared again', async () => {
  await both('let a = 1; a');
  await both('a');
  await both('let a = 2; a');
  await both('a += 1; a');
  await both('const c = 1');
  await both('c = 2');
  await both('c');
  await both('const c = 3; c');
  await both('class K { x() {} }; typeof K');
  await both('class K {}; K.name');
  await both('let {d, e: [f]} = {d: 1, e: [2]}, n; d + f');
  await both('[d, f, n]');
  await both('1 + 1; let h = 3');
  await both('h');
});

test('a name a page script or var declared cannot be declared', async () => {
  await both('var v = 1');
  await both('let v = 2');
  for (const t of [chromePage, oursPage]) await t.page.addScriptTag({ content: 'let pageLet = 1' });
  await both('let pageLet = 2');
  await both('pageLet');
});

test('closures see the live binding, and so do page scripts', async () => {
  await both('let counter = 0; function inc() { return ++counter }');
  await both('inc(); inc()');
  await both('counter');
  const read = (t: TestPage) =>
    // oxlint-disable-next-line no-eval -- reading a global binding by name, as a page script.
    t.page.evaluate(() => String(globalThis.eval('counter')));
  assert.equal(await read(oursPage), await read(chromePage));
  await both('counter = 10; inc()');
});

test('errors are located in the input as typed', async () => {
  await both('let q = 1; null.x');
  await both('const q2 = 1; q2 = 2');
  await both('let r = 1\nconst r2 = 2; undefined.y');
  await both('qq; let qq = 1');
});

test('input that does not compile declares nothing', async () => {
  await both('return 1; let returned = 2');
  await both("'returned' in window");
  await both('{ return 1 } let returned2 = 2');
  await both('if (true) return; let returned3 = 3');
  await both("'returned2' in window || 'returned3' in window");
  await both('const methods = { return() { return 1 }, return2: 2 }; let viaMethod = methods.return(); viaMethod');
  await both('viaMethod');
  await both('let broken = ;');
  await both('broken');
  await both("'broken' in window");
  for (const t of [chromePage, oursPage]) {
    // A page script declaring the name.
    const declared = await t.page.evaluate(() => {
      let error = '';
      const onError = (e: ErrorEvent) => {
        error = e.message;
        e.preventDefault();
      };
      window.addEventListener('error', onError);
      const script = document.createElement('script');
      script.textContent = 'let broken = 1, returned = 2';
      document.head.append(script);
      window.removeEventListener('error', onError);
      return error;
    });
    assert.equal(declared, '');
  }
});

test('only top-level declarations are rewritten', async () => {
  await both('"let s1 = 1"; `const ${"s2"} = 2`; /* let s3 */ "ok"');
  await both('typeof s1');
  await both('for (let i1 = 0; i1 < 2; i1++) {} typeof i1');
  await both('{ let inBlock = 1 } typeof inBlock');
  await both('let = 3; let');
  await both('let\nletNext = 4; letNext');
  await both('(() => { let inner = 5; return inner })()');
  await both('typeof inner');
});

test('a declaration whose initializer throws is not kept', async () => {
  await both('let late = (() => { throw new Error("no") })()');
  await both('late');
});

test('top-level await with declarations', async () => {
  await both('let g = await Promise.resolve(5); g');
  await both('await 1; 2 + 3');
  await both('class A2 {}\nconst z = await Promise.resolve(A2); z.name');
  await both('A2.name');
  await both('g');
  await both('const w = await Promise.resolve(6)');
  await both('w + g');
});

test('page scripts see the declarations and cannot declare them again', async () => {
  const seen = (t: TestPage) =>
    t.page.evaluate(() => {
      let error = '';
      const onError = (e: ErrorEvent) => {
        error = e.message;
        e.preventDefault();
      };
      window.addEventListener('error', onError);
      const script = document.createElement('script');
      script.textContent = 'let a = 5';
      document.head.append(script);
      window.removeEventListener('error', onError);
      // The binding as a page script reads it.
      // oxlint-disable-next-line no-eval -- reading a global binding by name.
      return { a: String(globalThis.eval('typeof a + a')), error };
    });
  const [chrome, ours] = [await seen(chromePage), await seen(oursPage)];
  assert.equal(ours.a, chrome.a);
  assert.match(chrome.error, /'a' has already been declared/);
  assert.match(ours.error, /'a' has already been declared/);
});

test('globalLexicalScopeNames includes the console declarations', async () => {
  const names = async (side: Side) =>
    [...new Set((await side.send('Runtime.globalLexicalScopeNames', {})).names)].sort();
  assert.deepEqual(await names(oursPage.ours), await names(chromePage.chrome));
});
