import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { parseStack } from '../core/stack.ts';
import {
  CDP_BUNDLE,
  PROBE_BUNDLE,
  diffSubset,
  launch,
  openPage,
  waitForBoth,
} from '../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown']);
  await t.chrome.send('Runtime.enable');
  await t.ours.send('Runtime.enable');
});
after(() => env?.close());

async function logged(expression: string) {
  await t.chrome.clear();
  await t.ours.clear();
  await t.page.evaluate(expression);
  const [[ours], [chrome]] = await waitForBoth(t, 'Runtime.consoleAPICalled');
  assert.ok(ours && chrome);
  return { ours, chrome };
}

/** Runs `expression`, then a marker log: on both sides the marker must be the first message. */
async function silent(expression: string) {
  const { ours, chrome } = await logged(`${expression}; console.log('after-silent')`);
  assert.deepEqual(
    chrome.args.map(a => a.value),
    ['after-silent']
  );
  assert.deepEqual(
    ours.args.map(a => a.value),
    ['after-silent']
  );
}

const VALUES = {
  string: "'str'",
  number: '42',
  negativeZero: '-0',
  nan: 'NaN',
  bigint: '10n',
  boolean: 'true',
  null: 'null',
  undefined: 'undefined',
  object: "({ a: 1, b: 'x', c: { d: 2 } })",
  array: "[1, 'two', { three: 3 }]",
  map: "new Map([['k', 1]])",
  set: 'new Set([1, 2])',
  date: 'new Date(0)',
  regexp: '/re/g',
  error: "new TypeError('boom')",
  function: 'function foo(a, b) { return a + b }',
  symbol: "Symbol('s')",
  element: "document.getElementById('app')",
  // A node of another realm: a same-origin iframe's.
  iframeBody:
    "(() => { const f = document.body.appendChild(document.createElement('iframe')); const b = f.contentDocument.body; f.remove(); return b })()",
  typedArray: 'new Uint8Array(3)',
};

describe('Runtime.consoleAPICalled arguments', () => {
  for (const [name, expr] of Object.entries(VALUES)) {
    test(name, async () => {
      const { ours, chrome } = await logged(`console.log(${expr})`);
      assert.deepEqual(diffSubset(ours.args, chrome.args), []);
    });
  }
});

describe('Runtime.consoleAPICalled types', () => {
  const cases = {
    warn: "console.warn('w')",
    error: "console.error('e')",
    info: "console.info('i')",
    debug: "console.debug('d')",
    group: "console.group('g')",
    groupEnd: 'console.groupEnd()',
    count: "console.count('c')",
    assert: "console.assert(false, 'msg')",
    table: 'console.table([1])',
    dir: 'console.dir({})',
    trace: "console.trace('t')",
    timeEndMissing: "console.timeEnd('missing-timer')",
    timeLogMissing: "console.timeLog('missing-timer')",
    timeTwice: "console.time('twice'); console.time('twice')",
    countResetMissing: "console.countReset('missing-count')",
    timeLog: "console.time('tl'); console.timeLog('tl', 'extra'); console.timeEnd('tl')",
    timeEnd: "console.time('te'); console.timeEnd('te')",
    countAfterReset: "console.count('cr'); console.countReset('cr'); console.count('cr')",
  };
  for (const [name, expr] of Object.entries(cases)) {
    test(name, async () => {
      const { ours, chrome } = await logged(expr);
      assert.equal(ours.type, chrome.type);
      // Elapsed times differ between the sides: only the label is compared.
      if (name === 'timeLog' || name === 'timeEnd') {
        const label = (e: typeof ours) => String(e.args[0]?.value).replace(/: .*/, '');
        assert.equal(label(ours), label(chrome));
        assert.equal(ours.args.length, chrome.args.length);
      } else assert.deepEqual(diffSubset(ours.args, chrome.args), []);
    });
  }

  const silentCases = {
    logWithoutArguments: 'console.log()',
    assertTrue: "console.assert(true, 'x')",
    time: "console.time('quiet')",
  };
  for (const [name, expr] of Object.entries(silentCases)) {
    test(`${name} logs nothing`, () => silent(expr));
  }

  test('stack points at the caller', async () => {
    const { ours, chrome } = await logged("(function caller() { console.log('x') })()");
    // Chrome also reports the probe's console wrapper as the top frame; we hide it.
    const [ourFrame, chromeFrame] = [ours.stackTrace?.callFrames[0], chrome.stackTrace?.callFrames[1]];
    assert.ok(ourFrame && chromeFrame);
    assert.equal(ourFrame.functionName, chromeFrame.functionName);
  });

  test('stack names a constructor without new', async () => {
    const { ours, chrome } = await logged(
      "(() => { class Ctor { constructor() { console.log('x') } }; new Ctor() })()"
    );
    const [ourFrame, chromeFrame] = [ours.stackTrace?.callFrames[0], chrome.stackTrace?.callFrames[1]];
    assert.ok(ourFrame && chromeFrame);
    assert.equal(ourFrame.functionName, chromeFrame.functionName);
  });
});

describe('Runtime.evaluate', () => {
  const cases: Record<string, Protocol.Runtime.EvaluateRequest> = {
    arithmetic: { expression: '1 + 1' },
    objectLiteral: { expression: '{ a: 1 }', generatePreview: true },
    array: { expression: '[1, 2]', generatePreview: true },
    undefined: { expression: 'undefined' },
    awaitPromise: { expression: 'Promise.resolve(5)', awaitPromise: true },
    returnByValue: { expression: '({ a: [1, 2] })', returnByValue: true },
    throws: { expression: "throw new Error('x')" },
    awaitWithSemicolon: { expression: 'await Promise.resolve(5);', replMode: true },
    utilitiesAfterAwait: {
      expression: '(await Promise.resolve(), typeof $)',
      replMode: true,
      includeCommandLineAPI: true,
    },
  };
  for (const [name, params] of Object.entries(cases)) {
    test(name, async () => {
      const ours = await t.ours.send('Runtime.evaluate', params);
      const chrome = await t.chrome.send('Runtime.evaluate', params);
      assert.deepEqual(diffSubset(ours, chrome), []);
    });
  }
});

describe('Runtime.releaseObjectGroup', () => {
  test('keeps the same object wrapped in another group', async () => {
    for (const session of [t.ours, t.chrome]) {
      const expression = '(window.__grouped ??= { a: 1 })';
      const kept = await session.send('Runtime.evaluate', { expression, objectGroup: 'kept' });
      await session.send('Runtime.evaluate', { expression, objectGroup: 'released' });
      await session.send('Runtime.releaseObjectGroup', { objectGroup: 'released' });
      assert.ok(kept.result.objectId);
      const props = await session.send('Runtime.getProperties', {
        objectId: kept.result.objectId,
        ownProperties: true,
      });
      assert.deepEqual(
        props.result.map(p => p.name),
        ['a']
      );
    }
  });
});

describe('Runtime.getProperties', () => {
  async function properties(expression: string, params: Omit<Protocol.Runtime.GetPropertiesRequest, 'objectId'>) {
    const [ours, chrome] = await Promise.all([
      t.ours.send('Runtime.evaluate', { expression }),
      t.chrome.send('Runtime.evaluate', { expression }),
    ]);
    assert.ok(ours.result.objectId && chrome.result.objectId);
    return {
      ours: await t.ours.send('Runtime.getProperties', { objectId: ours.result.objectId, ...params }),
      chrome: await t.chrome.send('Runtime.getProperties', { objectId: chrome.result.objectId, ...params }),
    };
  }
  const byName = (list: Protocol.Runtime.PropertyDescriptor[] | undefined) =>
    Object.fromEntries((list || []).map(p => [p.name, p]));

  test('own properties of a plain object', async () => {
    const { ours, chrome } = await properties('({ a: 1, b: { c: 2 }, get g() { return 1 } })', { ownProperties: true });
    assert.deepEqual(Object.keys(byName(ours.result)), Object.keys(byName(chrome.result)));
    assert.deepEqual(diffSubset(byName(ours.result), byName(chrome.result)), []);
    assert.deepEqual(
      (ours.internalProperties || []).map(p => p.name),
      (chrome.internalProperties || []).map(p => p.name)
    );
  });

  test('of a symbol, which has an objectId but no properties', async () => {
    const [ours, chrome] = await Promise.all([
      t.ours.send('Runtime.evaluate', { expression: "Symbol('s')" }),
      t.chrome.send('Runtime.evaluate', { expression: "Symbol('s')" }),
    ]);
    assert.ok(ours.result.objectId && chrome.result.objectId);
    const outcome = (p: Promise<Protocol.Runtime.GetPropertiesResponse>) =>
      p.then(
        r => JSON.stringify(r.result.map(d => d.name)),
        (e: unknown) => String(e instanceof Error ? e.message : e)
      );
    const [o, c] = await Promise.all([
      outcome(t.ours.send('Runtime.getProperties', { objectId: ours.result.objectId, ownProperties: true })),
      outcome(t.chrome.send('Runtime.getProperties', { objectId: chrome.result.objectId, ownProperties: true })),
    ]);
    assert.equal(
      o.replace(/^.*?(Value with given id is not an object).*$/, '$1'),
      c.replace(/^.*?(Value with given id is not an object).*$/, '$1')
    );
  });

  test('map entries', async () => {
    const { ours, chrome } = await properties("new Map([['k', 1]])", { ownProperties: true });
    assert.deepEqual(
      (ours.internalProperties || []).map(p => p.name),
      (chrome.internalProperties || []).map(p => p.name)
    );
  });
});

describe('Runtime.exceptionThrown', () => {
  async function thrown(expression: string) {
    await t.chrome.clear();
    await t.ours.clear();
    await t.page.evaluate(expression);
    const [[ours], [chrome]] = await waitForBoth(t, 'Runtime.exceptionThrown');
    assert.ok(ours && chrome);
    return { ours, chrome };
  }

  test('uncaught error', async () => {
    const { ours, chrome } = await thrown("setTimeout(() => { throw new Error('late') })");
    assert.equal(ours.exceptionDetails.text, chrome.exceptionDetails.text);
    assert.deepEqual(diffSubset(ours.exceptionDetails.exception, chrome.exceptionDetails.exception), []);
  });

  test('a rejection whose stack is not a string', async () => {
    const { ours, chrome } = await thrown('void Promise.reject({ stack: 1 })');
    assert.equal(ours.exceptionDetails.text, chrome.exceptionDetails.text);
  });

  test('unhandled rejection', async () => {
    const { ours, chrome } = await thrown("void Promise.reject(new Error('rejected'))");
    assert.equal(ours.exceptionDetails.text, chrome.exceptionDetails.text);
    assert.deepEqual(diffSubset(ours.exceptionDetails.exception, chrome.exceptionDetails.exception), []);
  });
});

describe('Runtime exceptions of commands', () => {
  test('awaitPromise rejection is uncaught in promise', async () => {
    const params = { expression: "Promise.reject(new Error('no'))", awaitPromise: true };
    const [ours, chrome] = await Promise.all([
      t.ours.send('Runtime.evaluate', params),
      t.chrome.send('Runtime.evaluate', params),
    ]);
    assert.equal(ours.exceptionDetails?.text, chrome.exceptionDetails?.text);
    // The same object in both places.
    assert.equal(ours.exceptionDetails?.exception?.objectId, ours.result.objectId);
  });

  test('callFunctionOn with a declaration that is not a function is a response error', async () => {
    const [{ result: o }, { result: c }] = await Promise.all([
      t.ours.send('Runtime.evaluate', { expression: 'window' }),
      t.chrome.send('Runtime.evaluate', { expression: 'window' }),
    ]);
    assert.ok(o.objectId && c.objectId);
    const message = (e: unknown) => String(e instanceof Error ? e.message : e);
    const [ours, chrome] = await Promise.all([
      t.ours
        .send('Runtime.callFunctionOn', { objectId: o.objectId, functionDeclaration: '42' })
        .then(() => '', message),
      t.chrome
        .send('Runtime.callFunctionOn', { objectId: c.objectId, functionDeclaration: '42' })
        .then(() => '', message),
    ]);
    assert.match(chrome, /Given expression does not evaluate to a function/);
    assert.match(ours, /Given expression does not evaluate to a function/);
  });

  test('compileScript reports the syntax error without keeping an object', async () => {
    const params = { expression: '1 +', sourceURL: '', persistScript: false };
    const [ours, chrome] = await Promise.all([
      t.ours.send('Runtime.compileScript', params),
      t.chrome.send('Runtime.compileScript', params),
    ]);
    assert.equal(ours.exceptionDetails?.text, chrome.exceptionDetails?.text);
    assert.equal(ours.exceptionDetails?.exception, undefined);
  });

  test('eager evaluation refuses getters of the page', async () => {
    await t.page.evaluate(() => {
      Object.defineProperty(window, 'counter', { get: () => 1, configurable: true });
      Reflect.set(window, 'box', { n: 1 });
    });
    const evaluate = (expression: string) => t.ours.send('Runtime.evaluate', { expression, throwOnSideEffect: true });
    assert.ok((await evaluate('counter')).exceptionDetails);
    assert.ok((await evaluate("box + ''")).exceptionDetails);
    assert.ok((await evaluate('box == 1')).exceptionDetails);
    assert.ok((await evaluate('box != 1')).exceptionDetails);
    assert.equal((await evaluate('box.n')).exceptionDetails, undefined);
    assert.equal((await evaluate('document.body')).exceptionDetails, undefined);
    assert.equal((await evaluate('1 + 2')).exceptionDetails, undefined);
  });

  test('eager evaluation refuses assignments and calls without running them', async () => {
    for (const expression of ['window.sideEffect = 1', '(() => { window.sideEffect = 1 })()', 'sideEffectCount++']) {
      const params = { expression, throwOnSideEffect: true };
      const [ours, chrome] = await Promise.all([
        t.ours.send('Runtime.evaluate', params),
        t.chrome.send('Runtime.evaluate', params),
      ]);
      assert.ok(chrome.exceptionDetails, expression);
      assert.ok(ours.exceptionDetails, expression);
      assert.equal(ours.result.className, chrome.result.className);
      assert.equal(await t.page.evaluate(() => 'sideEffect' in window), false);
    }
  });

  test('replMode awaits a top-level await', async () => {
    const params = { expression: 'await Promise.resolve(7)', replMode: true };
    const [ours, chrome] = await Promise.all([
      t.ours.send('Runtime.evaluate', params),
      t.chrome.send('Runtime.evaluate', params),
    ]);
    assert.equal(chrome.exceptionDetails, undefined);
    assert.equal(ours.exceptionDetails, undefined);
    assert.deepEqual(diffSubset(ours.result, chrome.result), []);
  });

  test('includeCommandLineAPI provides the utilities only during the evaluation', async () => {
    const params = { expression: 'keys({ a: 1, b: 2 })', includeCommandLineAPI: true, returnByValue: true };
    const [ours, chrome] = await Promise.all([
      t.ours.send('Runtime.evaluate', params),
      t.chrome.send('Runtime.evaluate', params),
    ]);
    assert.deepEqual(ours.result.value, chrome.result.value);
    assert.equal(await t.page.evaluate(() => 'keys' in window), false);
  });

  test('callFunctionOn passes objectId, value and unserializableValue arguments', async () => {
    const [{ result: o }, { result: c }] = await Promise.all([
      t.ours.send('Runtime.evaluate', { expression: '({ n: 1 })' }),
      t.chrome.send('Runtime.evaluate', { expression: '({ n: 1 })' }),
    ]);
    assert.ok(o.objectId && c.objectId);
    const call = (objectId: string) => ({
      objectId,
      functionDeclaration: 'function (o, v, z, b) { return [this.n, o.n, v, Object.is(z, -0), typeof b] }',
      arguments: [{ objectId }, { value: 'x' }, { unserializableValue: '-0' }, { unserializableValue: '5n' }],
      returnByValue: true,
    });
    const [ours, chrome] = await Promise.all([
      t.ours.send('Runtime.callFunctionOn', call(o.objectId)),
      t.chrome.send('Runtime.callFunctionOn', call(c.objectId)),
    ]);
    assert.deepEqual(chrome.result.value, [1, 1, 'x', true, 'bigint']);
    assert.deepEqual(ours.result.value, chrome.result.value);
  });

  test('compileScript accepts input with await (the console evaluates it in REPL mode)', async () => {
    // Differs from V8 on purpose: the console checks the input is complete with compileScript,
    // and evaluates `await` at the top level.
    const ours = await t.ours.send('Runtime.compileScript', {
      expression: 'await Promise.resolve(1)',
      sourceURL: '',
      persistScript: false,
    });
    assert.equal(ours.exceptionDetails, undefined);
  });
});

describe('parseStack', () => {
  const frame = (line: string) => parseStack(`Error\n${line}`)[0];

  test('named, anonymous and async V8 frames', () => {
    assert.deepEqual(frame('    at foo (http://a.js:3:5)'), {
      functionName: 'foo',
      scriptId: '',
      url: 'http://a.js',
      lineNumber: 2,
      columnNumber: 4,
    });
    assert.equal(frame('    at http://a.js:3:5')?.functionName, '');
    assert.equal(frame('    at http://a.js:3:5')?.url, 'http://a.js');
    assert.equal(frame('    at async foo (http://a.js:3:5)')?.functionName, 'foo');
  });

  test('a constructor is named without new', () => {
    assert.equal(frame('    at new Foo (http://a.js:3:5)')?.functionName, 'Foo');
  });

  test('eval frames have no URL', () => {
    const f = frame('    at eval (eval at foo (http://a.js:3:5), <anonymous>:1:1)');
    assert.equal(f?.url, '');
    assert.equal(f?.lineNumber, 0);
    assert.equal(frame('foo@http://a.js line 2 > eval:1:1')?.url, '');
  });

  test('Gecko and Safari frames', () => {
    assert.deepEqual(frame('async*foo@http://a.js:3:5'), {
      functionName: 'foo',
      scriptId: '',
      url: 'http://a.js',
      lineNumber: 2,
      columnNumber: 4,
    });
    assert.equal(frame('global code@http://a.js:1:1')?.functionName, '');
  });

  test('skip drops top frames', () => {
    const frames = parseStack('Error\n    at a (http://a.js:1:1)\n    at b (http://a.js:2:1)', 1);
    assert.deepEqual(
      frames.map(f => f.functionName),
      ['b']
    );
  });
});

describe('probe buffers', () => {
  test('keeps the last 1000 log entries', async () => {
    const result = await t.page.evaluate(`(() => {
      for (let i = 0; i < 1100; i++) console.debug('flood', i);
      const logs = window.__devtoolsAnywhereProbe__.logs;
      return { length: logs.length, first: logs[0].args[1], last: logs[logs.length - 1].args[1] };
    })()`);
    assert.deepEqual(result, { length: 1000, first: 100, last: 1099 });
  });

  test('keeps up to 10000 entries until a server mounts, which keeps the last 1000', async () => {
    assert.ok(env);
    const page = await env.browser.newPage();
    try {
      await page.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
      await page.addScriptTag({ path: PROBE_BUNDLE });
      const logs = `(() => {
        const logs = window.__devtoolsAnywhereProbe__.logs;
        return { length: logs.length, first: logs[0].args[1] };
      })()`;
      await page.evaluate(`for (let i = 0; i < 10100; i++) console.debug('flood', i)`);
      assert.deepEqual(await page.evaluate(logs), { length: 10000, first: 100 });
      await page.addScriptTag({ path: CDP_BUNDLE });
      await page.evaluate(() => void window.DevtoolsAnywhere.createCdpServer());
      assert.deepEqual(await page.evaluate(logs), { length: 1000, first: 9100 });
    } finally {
      await page.close();
    }
  });
});
