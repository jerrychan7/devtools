// The texts of the sheets there when CSS.enable runs are checked against their CSSOM and paired
// with their rules at their first use, or while the page is idle, not for their headers; a text
// found then not to be the sheet's (the page changed the sheet before) is announced by
// styleSheetChanged, and served serialized, as Chrome serves it from the first.
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
    await t.page.evaluate(() => {
      // Texts given replaceSync() (the check parses each alone), and idle callbacks run only when
      // the test says so (`idle`).
      const w = window as unknown as {
        __checks: string[];
        __idle: Map<number, IdleRequestCallback>;
        requestIdleCallback: (cb: IdleRequestCallback) => number;
        cancelIdleCallback: (id: number) => void;
      };
      w.__checks = [];
      w.__idle = new Map();
      let next = 0;
      w.requestIdleCallback = cb => {
        w.__idle.set(++next, cb);
        return next;
      };
      w.cancelIdleCallback = id => void w.__idle.delete(id);
      const original = CSSStyleSheet.prototype.replaceSync;
      CSSStyleSheet.prototype.replaceSync = function (this: CSSStyleSheet, text: string) {
        w.__checks.push(String(text));
        return original.call(this, text);
      };
    });
  },
  () => env?.close()
);

/** How many times a text with `marker` was checked. */
const checks = (marker: string) =>
  t.page.evaluate(
    m => (window as unknown as { __checks: string[] }).__checks.filter(s => s.includes(m)).length,
    marker
  );

/** Adds a <style> with `text` and `id`, then lets `change` change its sheet. */
const addStyle = (id: string, text: string, change = '') =>
  t.page.evaluate(
    (i, s, c) => {
      const style = document.createElement('style');
      style.id = i;
      style.textContent = s;
      document.head.appendChild(style);
      if (c) new Function('sheet', c)(style.sheet);
    },
    id,
    text,
    change
  );

/** The id of the sheet of the <style> `#id` ours sent a header for. */
async function idOfStyle(id: string): Promise<string> {
  const { root } = await t.ours.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await t.ours.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${id}` });
  const { node } = await t.ours.send('DOM.describeNode', { nodeId });
  const added = await t.ours.events('CSS.styleSheetAdded');
  const found = added.find(a => a.header.ownerNode === node.backendNodeId);
  if (!found) throw new Error(`no sheet of #${id}`);
  return found.header.styleSheetId;
}

const matched = async (selector: string) => {
  const { root } = await t.ours.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await t.ours.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  return t.ours.send('CSS.getMatchedStylesForNode', { nodeId });
};

test('CSS.enable checks no text; getMatchedStylesForNode and getStyleSheetText check theirs once', async () => {
  await addStyle('lz1', '.lz1 { color: red }\n#lz-el { top: 1px }');
  await addStyle('lz2', '.lz2 { color: blue }');
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'lz-el';
    document.body.appendChild(el);
  });
  await t.ours.send('DOM.enable');
  await t.ours.clear();
  await t.ours.send('CSS.enable');
  try {
    assert.equal((await t.ours.events('CSS.styleSheetAdded')).length > 1, true);
    assert.deepEqual([await checks('.lz1'), await checks('.lz2')], [0, 0]);
    // The header is the text's, unchecked.
    const id1 = await idOfStyle('lz1');
    const h1 = (await t.ours.events('CSS.styleSheetAdded')).find(a => a.header.styleSheetId === id1)?.header;
    assert.deepEqual([h1?.length, h1?.endLine, h1?.endColumn], [39, 1, 19]);
    // Only the sheets with rules matching the element are used.
    await matched('#lz-el');
    assert.deepEqual([await checks('.lz1'), await checks('.lz2')], [1, 0]);
    await t.ours.send('CSS.getStyleSheetText', { styleSheetId: await idOfStyle('lz2') });
    assert.deepEqual([await checks('.lz1'), await checks('.lz2')], [1, 1]);
    // Once checked, not again.
    await matched('#lz-el');
    await t.ours.send('CSS.getStyleSheetText', { styleSheetId: id1 });
    assert.deepEqual([await checks('.lz1'), await checks('.lz2')], [1, 1]);
  } finally {
    await t.ours.send('CSS.disable');
  }
  // Watching again after none watched: checked again, at the first use only.
  await t.ours.clear();
  await t.ours.send('CSS.enable');
  try {
    assert.equal(await checks('.lz1'), 1);
    await t.ours.send('CSS.getStyleSheetText', { styleSheetId: await idOfStyle('lz1') });
    assert.equal(await checks('.lz1'), 2);
    assert.equal(await checks('.lz2'), 1);
  } finally {
    await t.ours.send('CSS.disable');
  }
});
