import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { diffSubset, launch, openPage, waitForBoth } from './harness.ts';
import type { Env, TestPage } from './harness.ts';

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
  };
  for (const [name, expr] of Object.entries(cases)) {
    test(name, async () => {
      const { ours, chrome } = await logged(expr);
      assert.equal(ours.type, chrome.type);
      assert.deepEqual(diffSubset(ours.args, chrome.args), []);
    });
  }

  test('stack points at the caller', async () => {
    const { ours, chrome } = await logged("(function caller() { console.log('x') })()");
    // Chrome also reports the probe's console wrapper as the top frame; we hide it.
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
  };
  for (const [name, params] of Object.entries(cases)) {
    test(name, async () => {
      const ours = await t.ours.send('Runtime.evaluate', params);
      const chrome = await t.chrome.send('Runtime.evaluate', params);
      assert.deepEqual(diffSubset(ours, chrome), []);
    });
  }
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

  test('unhandled rejection', async () => {
    const { ours, chrome } = await thrown("void Promise.reject(new Error('rejected'))");
    assert.equal(ours.exceptionDetails.text, chrome.exceptionDetails.text);
    assert.deepEqual(diffSubset(ours.exceptionDetails.exception, chrome.exceptionDetails.exception), []);
  });
});
