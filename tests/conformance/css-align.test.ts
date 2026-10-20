// Details of the CSS domain compared with Chrome: the longhands at the end of cssProperties,
// CSS.addRule in an @media, headers of style sheets a script inserts, :host-context() and
// ::slotted() through nested slots, adoptedStyleSheets changes, nested selectors as written,
// gradient stops in other color spaces and em / rem in media queries.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, waitForBoth } from './harness.ts';
import type { Env, Side, TestPage } from './harness.ts';

let env: Env | undefined;
let t: TestPage;

const STYLE = `
  #al-p { color: rgb(3,3,3); margin: 1px 2px; background: red; width: 5px !important; height: bogus; --v: 4px; padding: var(--v); }
  #al-p { border: 1px solid red; font: 12px serif; }
  @media (min-width: 2em) and (max-width: 100rem) { #al-p { z-index: 1 } }
  [data-al="p{1}"] { .al-q, & [data-al="c;}"] { color: red } }
  .al-par { .al-x { color: red } > .al-y, & .al-z { top: 1px } .al-x & { left: 1px } }
  #al-g1 { background: linear-gradient(hsl(120 50% 50%), oklch(0.5 0.1 200)); }
  #al-g2 { background: linear-gradient(color(display-p3 1 0 0), lab(50 20 30)), radial-gradient(rgb(0 0 255 / 0.5), red); }
  #al-g3 { background: linear-gradient(color-mix(in srgb, red, blue), hwb(0 0% 0%)); }
  #al-g4 { background: linear-gradient(rgba(0, 0, 0, 0.5), blue), linear-gradient(red, blue); }
`;

before(async () => {
  env = await launch();
  t = await openPage(env, ['CSS.styleSheetAdded', 'CSS.styleSheetRemoved']);
  await t.page.evaluate(style => {
    const s = document.createElement('style');
    s.textContent = style;
    document.head.appendChild(s);
    document.documentElement.style.fontSize = '20px';
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div id="al-p" style="color: blue; margin: 3px; top: x; left: var(--v) !important">x</div>
      <div data-al="p{1}"><i class="al-q" id="al-q"></i><i data-al="c;}" id="al-q2"></i></div><div class="al-par"><div class="al-x" id="al-x">x</div><div class="al-y al-z" id="al-y">y</div></div>
      <div id="al-g1">g</div><div id="al-g2">g</div><div id="al-g3">g</div><div id="al-g4">g</div>
      <div class="al-dark"><div id="al-host"></div></div>`
    );
    const host = document.getElementById('al-host');
    if (!host) return;
    const outer = host.attachShadow({ mode: 'open' });
    outer.innerHTML =
      '<style>:host-context(.al-dark) { color: red } :host-context(.al-light) { top: 1px } ::slotted(span) { color: blue }</style><div id="al-inner"><slot></slot></div>';
    const inner = outer.getElementById('al-inner')?.attachShadow({ mode: 'open' });
    if (inner)
      inner.innerHTML = '<style>::slotted(span) { margin: 3px } ::slotted(slot) { margin: 4px }</style><slot></slot>';
    host.innerHTML = '<span id="al-slotted">s</span>';
  }, STYLE);
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
});
after(() => env?.close());

function find(node: Protocol.DOM.Node, id: string): Protocol.DOM.Node | undefined {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = find(child, id);
    if (found) return found;
  }
  return undefined;
}

async function nodeId(side: Side, id: string): Promise<number> {
  const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
  const node = find(root, id);
  assert.ok(node, id);
  return node.nodeId;
}

const both = <T>(fn: (side: Side) => Promise<T>) => Promise.all([fn(t.ours), fn(t.chrome)]);

const regular = (m: Protocol.CSS.GetMatchedStylesForNodeResponse) =>
  (m.matchedCSSRules ?? []).filter(r => r.rule.origin === 'regular');

test('cssProperties end with the longhands the style holds, without ranges', async () => {
  const [ours, chrome] = await both(async side => {
    const m = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, 'al-p') });
    const unranged = (s: Protocol.CSS.CSSStyle | undefined) => s?.cssProperties.filter(p => !p.range);
    return { inline: unranged(m.inlineStyle), rules: regular(m).map(r => unranged(r.rule.style)) };
  });
  assert.deepEqual(ours, chrome);
});

test('media queries: em and rem are 16px whatever the root font size', async () => {
  const [ours, chrome] = await both(async side => {
    const m = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, 'al-p') });
    return regular(m).flatMap(r => r.rule.media?.map(x => x.mediaList) ?? []);
  });
  assert.equal(ours.length, 1);
  assert.deepEqual(ours, chrome);
});

test('nested selectors are shown as written, without the & the CSSOM adds', async () => {
  const [ours, chrome] = await both(async side => {
    const result: string[][] = [];
    for (const id of ['al-x', 'al-y', 'al-q', 'al-q2']) {
      const m = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, id) });
      for (const r of regular(m))
        result.push([r.rule.selectorList.text, ...r.rule.selectorList.selectors.map(s => s.text)]);
    }
    return result;
  });
  assert.deepEqual(ours, chrome);
});

test('gradients: stops of the topmost one, in their own color space', async () => {
  const [ours, chrome] = await both(async side => {
    const result: (string[] | undefined)[] = [];
    for (const id of ['al-g1', 'al-g2', 'al-g3', 'al-g4'])
      result.push((await side.send('CSS.getBackgroundColors', { nodeId: await nodeId(side, id) })).backgroundColors);
    return result;
  });
  assert.deepEqual(ours, chrome);
});

test(':host-context() and ::slotted() through nested slots', async () => {
  const [ours, chrome] = await both(async side => {
    const result: string[][] = [];
    for (const id of ['al-host', 'al-slotted']) {
      const m = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, id) });
      result.push(
        regular(m).map(r => `${r.rule.selectorList.text} ${r.rule.style.cssProperties.map(p => p.name).join()}`)
      );
    }
    return result;
  });
  assert.deepEqual(ours, chrome);
});

test('a <style> a script inserts has no source URL and is not inline', async () => {
  const pairs = (events: Protocol.CSS.StyleSheetAddedEvent[]) =>
    events
      .filter(e => !e.header.isConstructed && e.header.origin === 'regular')
      .map(e => `${e.header.sourceURL.replace(/^http:\/\/[^/]+/, '')} ${e.header.isInline}`)
      .sort();
  const [ours, chrome] = [await t.ours.events('CSS.styleSheetAdded'), await t.chrome.events('CSS.styleSheetAdded')];
  assert.deepEqual(pairs(ours), pairs(chrome));
  assert.ok(pairs(chrome).includes(' false'));
});

test('adoptedStyleSheets changes are reported without another request', async () => {
  await t.ours.clear();
  await t.chrome.clear();
  await t.page.evaluate(() => {
    const a = new CSSStyleSheet();
    a.replaceSync('.al-a { color: red }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, a];
    const b = new CSSStyleSheet();
    b.replaceSync('.al-b { color: red }');
    document.adoptedStyleSheets.push(b);
  });
  const [ours, chrome] = await waitForBoth(t, 'CSS.styleSheetAdded', 2);
  assert.equal(ours.length, chrome.length);
  await t.page.evaluate(() => {
    document.adoptedStyleSheets.splice(0);
  });
  const [removedOurs, removedChrome] = await waitForBoth(t, 'CSS.styleSheetRemoved', 2);
  assert.equal(removedOurs.length, removedChrome.length);
});

test('reading adoptedStyleSheets does not make us look for style sheets again', async () => {
  const reads = await t.page.evaluate(async () => {
    // Looking for style sheets reads document.styleSheets: count that.
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'styleSheets');
    const get = descriptor?.get;
    if (!descriptor || !get) return -1;
    let count = 0;
    Object.defineProperty(Document.prototype, 'styleSheets', {
      ...descriptor,
      get(this: Document) {
        count++;
        return get.call(this);
      },
    });
    try {
      for (let i = 0; i < 50; i++) void document.adoptedStyleSheets.length;
      await new Promise(resolve => setTimeout(resolve, 50));
      return count;
    } finally {
      Object.defineProperty(Document.prototype, 'styleSheets', descriptor);
    }
  });
  assert.equal(reads, 0);
});

test('CSS.addRule at a rule in an @media puts the new rule in it', async () => {
  await t.page.evaluate(() => {
    for (const side of ['o', 'c']) {
      const s = document.createElement('style');
      s.textContent = `@media all { .al-m1-${side} { top: 1px } .al-m2-${side} { top: 2px } }`;
      document.head.appendChild(s);
    }
    document.body.insertAdjacentHTML('beforeend', '<div id="al-m" class="al-m1-o al-m2-o al-m1-c al-m2-c"></div>');
  });
  const results: (number | undefined)[] = [];
  for (const [side, name] of [
    [t.ours, 'o'],
    [t.chrome, 'c'],
  ] as const) {
    const m = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, 'al-m') });
    const rule = regular(m).find(r => r.rule.selectorList.text === `.al-m2-${name}`)?.rule;
    const range = rule?.selectorList.selectors[0]?.range;
    assert.ok(rule?.styleSheetId && range);
    const added = await side.send('CSS.addRule', {
      styleSheetId: rule.styleSheetId,
      ruleText: `.al-new-${name} { color: red }`,
      location: {
        startLine: range.startLine,
        startColumn: range.startColumn,
        endLine: range.startLine,
        endColumn: range.startColumn,
      },
    });
    assert.equal(added.rule.media?.length, 1);
    results.push(
      // The new rule's index in the @media of its sheet.
      await t.page.evaluate(n => {
        for (const sheet of Array.from(document.styleSheets))
          for (const r of Array.from(sheet.cssRules)) {
            if (!(r instanceof CSSMediaRule)) continue;
            const at = Array.from(r.cssRules).findIndex(
              x => x instanceof CSSStyleRule && x.selectorText === `.al-new-${n}`
            );
            if (at >= 0) return at;
          }
        return -1;
      }, name)
    );
  }
  assert.deepEqual(results, [1, 1]);
});
