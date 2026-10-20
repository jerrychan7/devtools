// Style sheets of shadow trees and constructed (adopted) style sheets in the CSS domain:
// their headers, the rules they give elements inside and around the shadow tree (`:host`,
// `::slotted()`), forced pseudo-classes in shadow trees, and sheets added later.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from './harness.ts';
import type { Env, Side, TestPage } from './harness.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, ['CSS.styleSheetAdded']);
  await t.page.evaluate(() => {
    const doc = new CSSStyleSheet();
    doc.replaceSync('.sh-adopted { color: rgb(9, 9, 9); }');
    document.adoptedStyleSheets = [doc];
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="sh-host" class="sh-h"><span id="sh-light" class="sh-adopted">light</span></div>'
    );
    const host = document.getElementById('sh-host');
    if (!host) throw new Error('no host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { color: rgb(1, 1, 1); }
      :host(.sh-h) { padding: 1px; }
      :host(.sh-x) { padding: 2px; }
      ::slotted(span) { color: rgb(2, 2, 2); }
      .sh-in { color: rgb(3, 3, 3); }
      .sh-in:hover { color: rgb(4, 4, 4); }
    </style><p class="sh-in" id="sh-in">in</p><slot></slot>`;
    const adopted = new CSSStyleSheet();
    adopted.replaceSync('.sh-in { margin: 3px; }');
    root.adoptedStyleSheets = [adopted];
  });
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
});
after(() => env?.close());

type DomNode = Protocol.DOM.Node;
function find(node: DomNode, id: string): DomNode | null {
  if (node.attributes?.includes(id)) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
async function nodeId(side: Side, id: string) {
  const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
  const node = find(root, id);
  assert.ok(node, id);
  return node.nodeId;
}

const selectors = (matches: Protocol.CSS.RuleMatch[]) =>
  matches.filter(m => m.rule.origin === 'regular').map(m => m.rule.selectorList.text);

async function matched(id: string) {
  const result: Record<string, unknown>[] = [];
  for (const side of [t.ours, t.chrome]) {
    const m = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, id) });
    result.push({
      matched: selectors(m.matchedCSSRules ?? []),
      inherited: (m.inherited ?? []).map(e => selectors(e.matchedCSSRules)),
    });
  }
  return result;
}

test('constructed and shadow tree style sheets are announced like in Chrome', async () => {
  const pick = (headers: { header: Protocol.CSS.CSSStyleSheetHeader }[]) =>
    headers
      .map(({ header: h }) => ({
        sourceURL: h.sourceURL,
        isInline: h.isInline,
        isMutable: h.isMutable,
        isConstructed: h.isConstructed,
        loadingFailed: h.loadingFailed,
        hasOwner: h.ownerNode !== undefined,
      }))
      .filter(h => h.isConstructed || h.sourceURL === '')
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const [o, c] = [await t.ours.events('CSS.styleSheetAdded'), await t.chrome.events('CSS.styleSheetAdded')];
  assert.deepEqual(pick(o), pick(c));
  assert.equal(pick(c).filter(h => h.isConstructed).length, 2);
});

for (const id of ['sh-in', 'sh-host', 'sh-light']) {
  test(`getMatchedStylesForNode #${id} with shadow tree and adopted rules`, async () => {
    const [o, c] = await matched(id);
    assert.deepEqual(o, c);
  });
}

test('forced :hover applies to rules of the shadow tree', async () => {
  const result: unknown[] = [];
  for (const side of [t.ours, t.chrome]) {
    const id = await nodeId(side, 'sh-in');
    await side.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: ['hover'] });
    const m = await side.send('CSS.getMatchedStylesForNode', { nodeId: id });
    const color = (await side.send('CSS.getComputedStyleForNode', { nodeId: id })).computedStyle.find(
      p => p.name === 'color'
    );
    result.push({ matched: selectors(m.matchedCSSRules ?? []), color: color?.value });
    await side.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: [] });
  }
  assert.deepEqual(result[0], result[1]);
});

test('sheets of new shadow roots and newly adopted sheets are announced', async () => {
  for (const side of [t.ours, t.chrome]) await side.clear();
  await t.page.evaluate(() => {
    const root = document.getElementById('sh-host')?.shadowRoot;
    if (!root) throw new Error('no shadow root');
    const extra = new CSSStyleSheet();
    extra.replaceSync('.sh-extra {}');
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, extra];
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).innerHTML = '<style>.sh-new {}</style>';
    document.body.append(host);
  });
  // Ours notices adopted sheets when it next looks at styles.
  await t.ours.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(t.ours, 'sh-in') });
  await new Promise(r => setTimeout(r, 200));
  const pick = async (side: Side) => (await side.events('CSS.styleSheetAdded')).map(e => e.header.isConstructed).sort();
  assert.deepEqual(await pick(t.ours), await pick(t.chrome));
});

test('the companion sheet stays out of sight and at the end of adoptedStyleSheets', async () => {
  const id = await nodeId(t.ours, 'sh-in');
  // A reference to the real array, taken before the companion is added.
  await t.page.evaluate(() => {
    const root = document.getElementById('sh-host')?.shadowRoot;
    if (!root) throw new Error('no shadow root');
    Object.assign(window, { __shAdopted: root.adoptedStyleSheets, __shCount: root.adoptedStyleSheets.length });
  });
  await t.ours.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: ['hover'] });
  const seen = await t.page.evaluate(() => {
    const root = document.getElementById('sh-host')?.shadowRoot;
    const real: unknown = Reflect.get(window, '__shAdopted');
    if (!root || !Array.isArray(real)) throw new Error('no shadow root');
    const visible = root.adoptedStyleSheets.length === Reflect.get(window, '__shCount');
    const pushed = new CSSStyleSheet();
    real.push(pushed);
    Object.assign(window, { __shPushed: pushed });
    return { visible, realLonger: real.length > root.adoptedStyleSheets.length };
  });
  assert.deepEqual(seen, { visible: true, realLonger: true });
  await t.ours.send('CSS.getMatchedStylesForNode', { nodeId: id });
  const last = await t.page.evaluate(() => {
    const real: unknown = Reflect.get(window, '__shAdopted');
    if (!Array.isArray(real)) throw new Error('no array');
    return { companionLast: real[real.length - 1] !== Reflect.get(window, '__shPushed') };
  });
  assert.deepEqual(last, { companionLast: true });
  await t.ours.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: [] });
  const after = await t.page.evaluate(() => {
    const root = document.getElementById('sh-host')?.shadowRoot;
    if (!root) throw new Error('no shadow root');
    return {
      own: Object.getOwnPropertyDescriptor(root, 'adoptedStyleSheets') === undefined,
      pushedKept: root.adoptedStyleSheets.length === Number(Reflect.get(window, '__shCount')) + 1,
    };
  });
  assert.deepEqual(after, { own: true, pushedKept: true });
});

test('a custom element defined after CSS.enable brings the rules of its shadow tree', async () => {
  await t.page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<x-sh-late id="sh-late"></x-sh-late>');
  });
  // Both sides know the element before it is upgraded.
  for (const side of [t.ours, t.chrome]) await nodeId(side, 'sh-late');
  // Once the insertion has been observed, a request fills our list of shadow roots again: only
  // the attachShadow below can make it stale.
  await t.page.evaluate(() => new Promise(r => setTimeout(r, 0)));
  await t.ours.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(t.ours, 'sh-late') });
  await t.page.evaluate(() => {
    customElements.define(
      'x-sh-late',
      class extends HTMLElement {
        constructor() {
          super();
          const root = this.attachShadow({ mode: 'open' });
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(':host { color: rgb(7, 7, 7); } .sh-late-in { margin: 7px; }');
          root.adoptedStyleSheets = [sheet];
          root.innerHTML = '<p class="sh-late-in" id="sh-late-in">late</p>';
        }
      }
    );
  });
  await new Promise(r => setTimeout(r, 100));
  for (const id of ['sh-late', 'sh-late-in']) {
    const [o, c] = await matched(id);
    assert.deepEqual(o, c);
  }
});
