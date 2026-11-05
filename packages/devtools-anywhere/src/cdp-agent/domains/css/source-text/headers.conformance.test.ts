// Where a style sheet's text comes from, compared with Chrome: the parser's <style>, one a
// script adds, constructed and adopted sheets, <link> and @import, and a cross-origin sheet
// without CORS (whose text Chrome has and a page script cannot read).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown, waitForBoth } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;
const ASSETS = '/packages/devtools-anywhere/test-support/assets';

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['CSS.styleSheetAdded']);
    for (const side of [t.ours, t.chrome]) {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
    }
  },
  () => env?.close()
);

/** The fields of a header Chrome and we agree on, and the text of its sheet. */
async function sheet(side: Side, header: Protocol.CSS.CSSStyleSheetHeader, position: boolean) {
  const { styleSheetId, frameId: _f, ownerNode: _o, startLine, startColumn, endLine, endColumn, ...rest } = header;
  const { text } = await side.send('CSS.getStyleSheetText', { styleSheetId });
  return { ...rest, ...(position && { startLine, startColumn, endLine, endColumn }), text };
}

/** The headers both sides add while `fn` runs, as `sheet` gives them. */
async function added(fn: () => Promise<unknown>, count = 1, position = true) {
  const [o, c] = [
    (await t.ours.events('CSS.styleSheetAdded')).length,
    (await t.chrome.events('CSS.styleSheetAdded')).length,
  ];
  await fn();
  const [ours, chrome] = await waitForBoth(t, 'CSS.styleSheetAdded', Math.max(o, c) + count);
  return Promise.all([
    Promise.all(ours.slice(o).map(e => sheet(t.ours, e.header, position))),
    Promise.all(chrome.slice(c).map(e => sheet(t.chrome, e.header, position))),
  ]);
}

test("the parser's <style>s: their text, all of it (Chrome starts it where it is in the HTML)", async () => {
  const [ours, chrome] = await waitForBoth(t, 'CSS.styleSheetAdded', 2);
  const all = (side: Side, list: { header: Protocol.CSS.CSSStyleSheetHeader }[]) =>
    Promise.all(list.map(e => sheet(side, e.header, false))).then(s => s.sort((a, b) => a.text.localeCompare(b.text)));
  assert.deepEqual(await all(t.ours, ours), await all(t.chrome, chrome));
});

test('a <style> a script adds: its text, from 0:0, a BOM in it kept', async () => {
  const [ours, chrome] = await added(() =>
    t.page.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = '﻿/* c */ .h1 { color: red }\r\n.h1 {{ bad }\n';
      document.head.appendChild(s);
    })
  );
  assert.deepEqual(ours, chrome);
});

test('constructed and adopted sheets: the text replaceSync got', async () => {
  const [ours, chrome] = await added(() =>
    t.page.evaluate(() => {
      const c = new CSSStyleSheet();
      c.replaceSync('/* x */ .h2 { color: red }\n@media print { .h2 { top: 0 } }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, c];
    })
  );
  assert.deepEqual(ours, chrome);
});

test('<link> and @import: the file; an @import after rules makes no sheet', async () => {
  const [ours, chrome] = await added(
    () =>
      t.page.evaluate(
        href =>
          new Promise<void>(resolve => {
            const s = document.createElement('style');
            s.textContent = `@import url(${href});\n.h3 { color: red }\n@import url(${href}?late);`;
            s.onload = () => resolve();
            document.head.appendChild(s);
          }),
        `${ASSETS}/frame.css`
      ),
    2,
    false
  );
  // The imported sheet's text: the file. Chrome serializes its rules instead when the file is not
  // in its cache (the test server sends `no-store`).
  const file = '.narrow {\n  letter-spacing: 1px;\n}\n';
  const imported = (list: { text: string; length?: number }[]) =>
    list.map(s => (s.text.startsWith('.narrow') ? { ...s, text: file, length: file.length } : s));
  assert.ok(ours.some(s => s.text === file));
  assert.deepEqual(imported(ours), imported(chrome));
});

test('a cross-origin sheet without CORS: Chrome has its text, we fail explicitly', async () => {
  assert.ok(env);
  const href = `${env.baseUrl.replace('localhost', '127.0.0.1')}${ASSETS}/cross.css?nocors`;
  const before = (await t.ours.events('CSS.styleSheetAdded')).length;
  await t.page.evaluate(
    href =>
      new Promise<void>(resolve => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = () => resolve();
        document.head.appendChild(link);
      }),
    href
  );
  const [ours, chrome] = await waitForBoth(t, 'CSS.styleSheetAdded', before + 1);
  const [o, c] = [ours.at(-1), chrome.at(-1)];
  assert.ok(o && c);
  assert.equal(o.header.sourceURL, c.header.sourceURL);
  const { text } = await t.chrome.send('CSS.getStyleSheetText', { styleSheetId: c.header.styleSheetId });
  assert.ok(text.length);
  await assert.rejects(t.ours.send('CSS.getStyleSheetText', { styleSheetId: o.header.styleSheetId }), /CORS/);
});
