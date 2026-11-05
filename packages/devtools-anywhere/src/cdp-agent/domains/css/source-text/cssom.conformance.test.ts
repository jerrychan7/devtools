// Watching the page's CSSOM changes: the hooks look like the native functions to the page, and
// go when the CSS domain is disabled; changes made before it was enabled are not taken for the
// text; a sheet changed in the task that adopts it is added, then changed, as in Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['CSS.styleSheetAdded', 'CSS.styleSheetChanged']);
  },
  () => env?.close()
);

/** What a page can tell of the hooked functions. */
const hooked = () =>
  t.page.evaluate(() => {
    const list: [object, string, boolean][] = [
      [CSSStyleSheet.prototype, 'insertRule', false],
      [CSSStyleSheet.prototype, 'deleteRule', false],
      [CSSStyleSheet.prototype, 'replace', false],
      [CSSStyleSheet.prototype, 'replaceSync', false],
      [CSSGroupingRule.prototype, 'insertRule', false],
      [CSSStyleDeclaration.prototype, 'setProperty', false],
      [CSSStyleDeclaration.prototype, 'cssText', true],
      [CSSStyleRule.prototype, 'selectorText', true],
    ];
    return list.map(([proto, name, setter]) => {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      const f: unknown = setter ? d?.set : d?.value;
      if (typeof f !== 'function') return `${name}: none`;
      let construct = 'constructible';
      try {
        Reflect.construct(f, []);
      } catch (e) {
        construct = e instanceof Error ? e.constructor.name : 'thrown';
      }
      const source = Function.prototype.toString.call(f);
      return [
        name,
        f.name,
        f.length,
        /^function [\w ]*\(\) \{ \[native code\] \}$/.test(source),
        'prototype' in f,
        construct,
        d?.enumerable,
        d?.writable,
        d?.configurable,
      ].join(' ');
    });
  });

test('the hooks look native to the page and go with CSS.disable', async () => {
  const before = await hooked();
  await t.ours.send('CSS.enable');
  const during = await hooked();
  // `toString()` keeps the native form, without the name (`function () { [native code] }`).
  assert.deepEqual(
    during.map(s =>
      s.replace(/ (insertRule|deleteRule|replace|replaceSync|setProperty|set cssText|set selectorText) /, ' NAME ')
    ),
    before.map(s =>
      s.replace(/ (insertRule|deleteRule|replace|replaceSync|setProperty|set cssText|set selectorText) /, ' NAME ')
    )
  );
  await t.ours.send('CSS.disable');
  assert.deepEqual(await hooked(), before);
});

test('a sheet changed before CSS.enable: its text is not taken for the rules', async () => {
  await t.page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'pre';
    s.textContent = '.pre1 { color: red }\n.pre2 { top: 1px }';
    document.head.appendChild(s);
    s.sheet?.deleteRule(1);
    const r = s.sheet?.cssRules[0];
    if (r instanceof CSSStyleRule) r.style.left = '2px';
  });
  await t.ours.clear();
  await t.ours.send('CSS.enable');
  const added = await t.ours.events('CSS.styleSheetAdded');
  let text = '';
  for (const { header } of added) {
    const r = await t.ours.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId });
    if (r.text.includes('.pre1')) text = r.text;
  }
  // The serialized rules the sheet has, not its <style>'s text.
  assert.ok(text.includes('left: 2px') && !text.includes('.pre2'), text);
  await t.ours.send('CSS.disable');
});

test('replaceSync, adopt and replaceSync in one task: added, then changed, as in Chrome', async () => {
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
  await Promise.all([t.ours.clear(), t.chrome.clear()]);
  await t.page.evaluate(() => {
    const s = new CSSStyleSheet();
    s.replaceSync('.ad { color: red }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
    s.replaceSync('.ad  { color : blue }');
  });
  await new Promise(r => setTimeout(r, 300));
  const counts = async (side: typeof t.ours) => [
    (await side.events('CSS.styleSheetAdded')).length,
    (await side.events('CSS.styleSheetChanged')).length,
  ];
  assert.deepEqual(await counts(t.ours), await counts(t.chrome));
});
