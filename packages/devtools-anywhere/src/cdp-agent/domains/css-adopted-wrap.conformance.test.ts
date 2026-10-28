// CSS.disable restores the native `adoptedStyleSheets` only while the hook is still ours: a
// wrapper the page installed meanwhile is kept, and enabling again does not wrap twice.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from '../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
});
after(() => env?.close());

const getterIsNative = () =>
  t.page.evaluate(() =>
    String(Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets')?.get).includes('[native code]')
  );

test('CSS.disable restores the native descriptor when nobody wrapped it', async () => {
  await t.ours.send('CSS.enable');
  assert.equal(await getterIsNative(), false);
  await t.ours.send('CSS.disable');
  assert.equal(await getterIsNative(), true);
});

test('CSS.disable keeps a wrapper the page installed over the hook', async () => {
  await t.ours.send('CSS.enable');
  await t.page.evaluate(() => {
    const inner = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets');
    const get = inner?.get;
    const set = inner?.set;
    if (!get || !set) throw new Error('no accessors');
    const own = window as Window & { wrapped?: number };
    own.wrapped = 0;
    Object.defineProperty(Document.prototype, 'adoptedStyleSheets', {
      configurable: true,
      get(this: Document) {
        own.wrapped = (own.wrapped ?? 0) + 1;
        return get.call(this);
      },
      set(this: Document, v: CSSStyleSheet[]) {
        set.call(this, v);
      },
    });
  });
  await t.ours.send('CSS.disable');
  const calls = await t.page.evaluate(() => {
    void document.adoptedStyleSheets;
    return (window as Window & { wrapped?: number }).wrapped;
  });
  assert.equal(calls, 1);
  // Enabling and disabling again keeps working and keeps the page's wrapper.
  await t.ours.send('CSS.enable');
  await t.ours.send('CSS.disable');
  const again = await t.page.evaluate(() => {
    document.adoptedStyleSheets = [];
    void document.adoptedStyleSheets;
    return (window as Window & { wrapped?: number }).wrapped;
  });
  assert.equal(again, 2);
});
