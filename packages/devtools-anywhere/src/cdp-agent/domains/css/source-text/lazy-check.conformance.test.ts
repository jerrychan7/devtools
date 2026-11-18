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

/** Idle callbacks waiting. */
const idleWaiting = () => t.page.evaluate(() => (window as unknown as { __idle: Map<number, unknown> }).__idle.size);

/** Runs the idle callbacks waiting, each given a long idle period, until none is left; how many ran. */
const idle = () =>
  t.page.evaluate(() => {
    const w = window as unknown as { __idle: Map<number, IdleRequestCallback> };
    let ran = 0;
    while (w.__idle.size && ran < 1000) {
      const [id, cb] = w.__idle.entries().next().value as [number, IdleRequestCallback];
      w.__idle.delete(id);
      const end = performance.now() + 50;
      cb({ didTimeout: false, timeRemaining: () => Math.max(0, end - performance.now()) });
      ran++;
    }
    return ran;
  });

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

/** The header a side sent for the sheet whose text starts like `start`, with its text. */
async function headerOf(side: typeof t.ours, start: string) {
  for (const { header } of await side.events('CSS.styleSheetAdded')) {
    const r = await side.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId }).catch(() => null);
    if (r?.text.startsWith(start)) return { header, text: r.text };
  }
  throw new Error(`no sheet starting with ${start}`);
}

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

test('a <style> changed before CSS.enable: added with its text, changed once checked, as Chrome ends', async () => {
  const text = '.lz3 { color: red }\n.lz3b { top: 1px }';
  await addStyle('lz3', text, 'sheet.deleteRule(1); sheet.cssRules[0].style.left = "2px";');
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.clear();
    await side.send('CSS.enable');
  }
  try {
    const id = await idOfStyle('lz3');
    const header = (await t.ours.events('CSS.styleSheetAdded')).find(a => a.header.styleSheetId === id)?.header;
    // Ours: the header of the <style>'s text, not checked yet.
    assert.deepEqual([header?.length, header?.endLine, header?.endColumn], [text.length, 1, 18]);
    assert.equal(await checks('.lz3'), 0);
    // Its first use finds the text is not the sheet's: changed, then served serialized.
    const served = (await t.ours.send('CSS.getStyleSheetText', { styleSheetId: id })).text;
    assert.equal(served, '.lz3 { color: red; left: 2px; }\n');
    const changed = (await t.ours.events('CSS.styleSheetChanged')).map(e => e.styleSheetId);
    assert.deepEqual(changed, [id]);
    // A session enabling now is given the serialized text's header.
    await t.ours.send('CSS.disable');
    await t.ours.clear();
    await t.ours.send('CSS.enable');
    const id2 = await idOfStyle('lz3');
    const again = (await t.ours.events('CSS.styleSheetAdded')).find(a => a.header.styleSheetId === id2)?.header;
    const reserved = (await t.ours.send('CSS.getStyleSheetText', { styleSheetId: id2 })).text;
    assert.equal(again?.length, reserved.length);
    assert.equal(reserved, served);
    // Chrome gives its final text at once, header and all, and no styleSheetChanged: the text of
    // the changed rule spliced in front of the <style>'s, the rule deleted still in it. Ours is
    // serialized from the rules (docs/limitations.md).
    const chrome = await headerOf(t.chrome, '.lz3');
    assert.equal(chrome.text, `.lz3 { color: red; left: 2px; }${text}`);
    assert.deepEqual([chrome.header.length, chrome.header.endLine], [chrome.text.length, 1]);
    assert.deepEqual(await t.chrome.events('CSS.styleSheetChanged'), []);
  } finally {
    for (const side of [t.ours, t.chrome]) await side.send('CSS.disable');
  }
});

test('warming up while idle checks each text once; their first use checks none again', async () => {
  await addStyle('lz4', '.lz4 { color: red }');
  await addStyle('lz5', '.lz5 { color: red }\n.lz5b { top: 1px }', 'sheet.deleteRule(1);');
  await t.ours.clear();
  await t.ours.send('CSS.enable');
  try {
    assert.deepEqual([await checks('.lz4'), await checks('.lz5')], [0, 0]);
    assert.ok((await idleWaiting()) > 0);
    assert.ok((await idle()) >= 1);
    assert.deepEqual([await checks('.lz4'), await checks('.lz5')], [1, 1]);
    // The stale text found while warming up is announced as at a first use.
    const id5 = await idOfStyle('lz5');
    assert.deepEqual(
      (await t.ours.events('CSS.styleSheetChanged')).map(e => e.styleSheetId),
      [id5]
    );
    await t.ours.send('CSS.getStyleSheetText', { styleSheetId: await idOfStyle('lz4') });
    assert.equal((await t.ours.send('CSS.getStyleSheetText', { styleSheetId: id5 })).text, '.lz5 { color: red; }\n');
    assert.deepEqual([await checks('.lz4'), await checks('.lz5')], [1, 1]);
    assert.equal(await idleWaiting(), 0);
  } finally {
    await t.ours.send('CSS.disable');
  }
});

test('CSS.disable stops warming up', async () => {
  await addStyle('lz6', '.lz6 { color: red }');
  await t.ours.clear();
  await t.ours.send('CSS.enable');
  assert.ok((await idleWaiting()) > 0);
  await t.ours.send('CSS.disable');
  assert.equal(await idleWaiting(), 0);
  await idle();
  assert.equal(await checks('.lz6'), 0);
});

test('without requestIdleCallback: warmed up from timers', async () => {
  await addStyle('lz7', '.lz7 { color: red }');
  const saved = await t.page.evaluateHandle(() => {
    const w = window as unknown as { requestIdleCallback?: unknown };
    const ric = w.requestIdleCallback;
    delete w.requestIdleCallback;
    return ric;
  });
  await t.ours.clear();
  await t.ours.send('CSS.enable');
  try {
    assert.equal(await checks('.lz7'), 0);
    const start = Date.now();
    while ((await checks('.lz7')) === 0 && Date.now() - start < 3000) await new Promise(r => setTimeout(r, 50));
    assert.equal(await checks('.lz7'), 1);
  } finally {
    await t.ours.send('CSS.disable');
    await t.page.evaluate(ric => {
      (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = ric;
    }, saved);
  }
});
