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

test('a value changed before CSS.enable, the rules as many: its text is not taken either', async () => {
  await t.page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '.pv1 { color: red }\n.pv2 { top: 1px }';
    document.head.appendChild(s);
    const r = s.sheet?.cssRules[1];
    if (r instanceof CSSStyleRule) r.style.top = '2px';
  });
  await t.ours.clear();
  await t.ours.send('CSS.enable');
  let text = '';
  for (const { header } of await t.ours.events('CSS.styleSheetAdded')) {
    const r = await t.ours.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId });
    if (r.text.includes('.pv1')) text = r.text;
  }
  assert.ok(text.includes('top: 2px') && !text.includes('top: 1px'), text);
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

test('an @import inserted into a <style> before CSS.enable: in its text, as in Chrome', async () => {
  for (const side of [t.ours, t.chrome]) await side.send('CSS.disable');
  await t.page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '.u2{color:red}';
    document.head.appendChild(s);
    s.sheet?.insertRule('@import url("data:text/css,.zz{}");', 0);
  });
  const texts = [];
  for (const side of [t.ours, t.chrome]) {
    await side.clear();
    await side.send('CSS.enable');
    for (const { header } of await side.events('CSS.styleSheetAdded')) {
      const r = await side.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId });
      if (r.text.includes('.u2')) texts.push(r.text);
    }
  }
  const [ours, chrome] = texts;
  // Chrome splices the rule's text into the one of the <style> (no line break between them);
  // ours is serialized from the CSSOM, each rule followed by a line break.
  assert.equal(chrome, '@import url("data:text/css,.zz{}");.u2{color:red}');
  assert.equal(ours, '@import url("data:text/css,.zz{}");\n.u2 { color: red; }\n');
});

test('a constructed sheet changed before CSS.enable: served serialized as in Chrome', async () => {
  for (const side of [t.ours, t.chrome]) await side.send('CSS.disable');
  await t.page.evaluate(() => {
    const s = new CSSStyleSheet();
    s.replaceSync('.pre3 { color: red }\n@media all { .pre3 { top: 1px } }');
    s.insertRule('@layer x { .pre3 { left: 1px } }', 1);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
  });
  const texts = [];
  for (const side of [t.ours, t.chrome]) {
    await side.clear();
    await side.send('CSS.enable');
    const added = await side.events('CSS.styleSheetAdded');
    for (const { header } of added) {
      const r = await side.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId });
      if (r.text.includes('.pre3')) texts.push(r.text);
    }
  }
  assert.equal(texts.length, 2);
  assert.equal(texts[0], texts[1]);
});

/**
 * The text of the sheet holding `marker` (once CSS is enabled), and how many times its text was
 * checked against its CSSOM since `spy()`: parsed alone by replaceSync().
 */
async function textWith(marker: string): Promise<{ text: string; checks: number }> {
  let text = '';
  for (const { header } of await t.ours.events('CSS.styleSheetAdded')) {
    // Those removed since are gone.
    const r = await t.ours.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId }).catch(() => null);
    if (r?.text.includes(marker)) text = r.text;
  }
  const checks = await t.page.evaluate(
    m => (window as unknown as { __checks: string[] }).__checks.filter(s => s.includes(m)).length,
    marker
  );
  return { text, checks };
}

/** Records the texts given replaceSync(): the hooks, installed after, call it. */
const spy = () =>
  t.page.evaluate(() => {
    const w = window as unknown as { __checks: string[]; __replaceSync: unknown };
    w.__checks = [];
    const original = CSSStyleSheet.prototype.replaceSync;
    w.__replaceSync = original;
    CSSStyleSheet.prototype.replaceSync = function (this: CSSStyleSheet, text: string) {
      w.__checks.push(String(text));
      return original.call(this, text);
    };
  });
const unspy = () =>
  t.page.evaluate(() => {
    const w = window as unknown as { __replaceSync: (text: string) => void };
    CSSStyleSheet.prototype.replaceSync = w.__replaceSync;
  });
const settled = () => new Promise(r => setTimeout(r, 100));

test('a <style> added while watched: its text taken unchecked; one there before: checked', async () => {
  for (const side of [t.ours, t.chrome]) await side.send('CSS.disable');
  await t.page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '.fw0 { color: red }';
    document.head.appendChild(s);
  });
  await spy();
  try {
    await t.ours.clear();
    await t.ours.send('CSS.enable');
    await t.page.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = '.fw1 { color: red }\n.fw1b {  top: 1px }';
      document.head.appendChild(s);
    });
    await settled();
    assert.deepEqual(await textWith('.fw1'), { text: '.fw1 { color: red }\n.fw1b {  top: 1px }', checks: 0 });
    assert.deepEqual(await textWith('.fw0'), { text: '.fw0 { color: red }', checks: 1 });
  } finally {
    await t.ours.send('CSS.disable');
    await unspy();
  }
});

test('a <style> added while watched, changed while none watched: checked when watched again', async () => {
  await spy();
  try {
    await t.ours.clear();
    await t.ours.send('CSS.enable');
    await t.page.evaluate(() => {
      const s = document.createElement('style');
      s.id = 'fw2';
      s.textContent = '.fw2 { color: red }\n.fw2b { top: 1px }';
      document.head.appendChild(s);
    });
    await settled();
    await t.ours.send('CSS.disable');
    await t.page.evaluate(() => (document.getElementById('fw2') as HTMLStyleElement).sheet?.deleteRule(1));
    await t.ours.clear();
    await t.ours.send('CSS.enable');
    assert.deepEqual(await textWith('.fw2'), { text: '.fw2 { color: red; }\n', checks: 1 });
  } finally {
    await t.ours.send('CSS.disable');
    await unspy();
  }
});

test('a <style> added while watched and changed in the same task: the change is in its text', async () => {
  await t.ours.clear();
  await t.ours.send('CSS.enable');
  await t.page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '.fw3 { color: red }';
    document.head.appendChild(s);
    s.sheet?.insertRule('.fw3b { top: 1px }', 1);
    const r = s.sheet?.cssRules[0];
    if (r instanceof CSSStyleRule) r.style.left = '2px';
  });
  await settled();
  const { text } = await textWith('.fw3');
  assert.equal(text, '.fw3 { color: red; left: 2px; }\n.fw3b { top: 1px; }\n');
  await t.ours.send('CSS.disable');
});

test('a <style> there before, given a new text while watched: taken unchecked', async () => {
  await t.page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'fw4';
    s.textContent = '.old4 { color: red }';
    document.head.appendChild(s);
    s.sheet?.insertRule('.unseen {}', 0);
  });
  await spy();
  try {
    await t.ours.clear();
    await t.ours.send('CSS.enable');
    await t.page.evaluate(() => {
      (document.getElementById('fw4') as HTMLStyleElement).textContent = '.fw4 {  color: blue }';
    });
    await settled();
    assert.deepEqual(await textWith('.fw4'), { text: '.fw4 {  color: blue }', checks: 0 });
  } finally {
    await t.ours.send('CSS.disable');
    await unspy();
  }
});

test('a <style> added to a shadow tree while watched: taken unchecked', async () => {
  await spy();
  try {
    await t.ours.clear();
    await t.ours.send('CSS.enable');
    await t.page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'fw5';
      host.attachShadow({ mode: 'open' });
      document.body.appendChild(host);
    });
    await settled();
    await t.page.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = '.fw5 {  color: red }';
      document.getElementById('fw5')?.shadowRoot?.appendChild(s);
    });
    await settled();
    assert.deepEqual(await textWith('.fw5'), { text: '.fw5 {  color: red }', checks: 0 });
  } finally {
    await t.ours.send('CSS.disable');
    await unspy();
  }
});
