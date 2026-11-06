// Matching in the namespaces a sheet declares, compared with Chrome: what an element inherits of
// the probe is not taken for a match, `:host()`, `::slotted()` and @scope are matched in them
// too, and a wrapper the page puts over adoptedStyleSheets never sees the probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { addStyle, both, nodeId, rule } from '../../../../../test-support/css-source.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
    for (const side of [t.ours, t.chrome]) {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
    }
  },
  () => env?.close()
);

const NS = '@namespace h url(http://www.w3.org/1999/xhtml);\n@namespace svg url(http://www.w3.org/2000/svg);\n';

/** The regular rules matching the element, of every sheet, on one side. */
const rules = async (side: Side, selector: string) =>
  (await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, selector) })).matchedCSSRules
    ?.filter(m => m.rule.origin === 'regular')
    .map(m => rule(m.rule));

async function same(selector: string) {
  const [ours, chrome] = [await rules(t.ours, selector), await rules(t.chrome, selector)];
  assert.ok(chrome?.length);
  assert.deepEqual(ours, chrome);
}

test('a rule matching the parent, not the element: not matched though the element inherits', async () => {
  const at = await addStyle(
    t,
    `${NS}h|div.m1 { top: 1px }\nh|div { left: 1px }\nh|div.m1 > h|div { right: 1px }\nh|div h|div { order: 1 }`,
    '<div class="m1"><div class="m2"><div class="m3">x</div></div></div>'
  );
  for (const target of ['.m1', '.m2', '.m3']) await same(`${at} ${target}`);
});

test('SVG and MathML elements in a matching element, with a default namespace: only inherit', async () => {
  const at = await addStyle(
    t,
    '@namespace url(http://www.w3.org/1999/xhtml);\ndiv.m8 { color: red }\n.m8 > * { top: 1px }',
    '<div class="m8"><svg id="m9"><rect id="m10"/></svg><math id="m11"><mi id="m12">x</mi></math></div>'
  );
  const all = async (side: Side, selector: string) => {
    const r = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, selector) });
    const regular = (list: { rule: Parameters<typeof rule>[0] }[] | undefined) =>
      (list ?? []).filter(m => m.rule.origin === 'regular').map(m => rule(m.rule).text);
    return { own: regular(r.matchedCSSRules), inherited: r.inherited?.map(i => regular(i.matchedCSSRules)) };
  };
  for (const target of ['#m9', '#m10', '#m11', '#m12'])
    assert.deepEqual(await all(t.ours, `${at} ${target}`), await all(t.chrome, `${at} ${target}`), target);
});

test(':host(), ::slotted() and @scope in a sheet declaring namespaces', async () => {
  const at = await addStyle(
    t,
    `${NS}@scope (h|div.m5) { h|p { top: 1px } svg|p { left: 1px } }\n@scope (svg|div) { h|p { right: 1px } }`,
    '<div class="m4 m5"><p class="m6">x</p></div>'
  );
  await t.page.evaluate(at => {
    const host = document.querySelector(`${at} .m4`) as HTMLElement;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${'@namespace h url(http://www.w3.org/1999/xhtml);'}
:host(h|div) { top: 2px }
:host(svg|div) { left: 2px }
::slotted(h|p) { right: 2px }
::slotted(svg|p) { bottom: 2px }
h|slot::slotted(*) { order: 2 }
</style><slot></slot>`;
  }, at);
  await same(`${at} .m4`);
  await same(`${at} .m6`);
});

test('a wrapper of the page over adoptedStyleSheets is not called by matching', async () => {
  const at = await addStyle(t, `${NS}h|p.m7 { top: 1px }\np.m7 { left: 1px }`, '<p class="m7">x</p>');
  const id = await nodeId(t.ours, `${at} .m7`);
  await t.page.evaluate(() => {
    const proto = Document.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
    const w = window as unknown as { calls: number; unwrap: () => void };
    w.calls = 0;
    Object.defineProperty(proto, 'adoptedStyleSheets', {
      configurable: true,
      get() {
        w.calls++;
        return d?.get?.call(this);
      },
      set(v) {
        w.calls++;
        d?.set?.call(this, v);
      },
    });
    w.unwrap = () => d && Object.defineProperty(proto, 'adoptedStyleSheets', d);
  });
  try {
    for (let i = 0; i < 20; i++) await t.ours.send('CSS.getMatchedStylesForNode', { nodeId: id });
    assert.equal(await t.page.evaluate(() => (window as unknown as { calls: number }).calls), 0);
    const { ours, chrome } = await both(t, `${at} .m7`);
    assert.deepEqual(ours.rules, chrome.rules);
  } finally {
    await t.page.evaluate(() => {
      (window as unknown as { unwrap: () => void }).unwrap();
    });
  }
});

const XLINK = '@namespace xlink url(http://www.w3.org/1999/xlink);\n';

test('`*|`, `|`, `|=` and selectors without a prefix in a sheet declaring namespaces', async () => {
  const at = await addStyle(
    t,
    `${NS}*|div.n1 { top: 1px }\n*|*.n1 > *|p { left: 1px }\n.n1 p { right: 1px }\np[lang|=en] { order: 1 }\n` +
      `[*|lang|="en"] { bottom: 1px }\n|p { color: red }\np[title="a|b"] { z-index: 1 }\n:is(*|div) > :is(.n2) { width: 1px }`,
    '<div class="n1"><p class="n2" lang="en-US" title="a|b">x</p></div>'
  );
  await same(`${at} .n1`);
  await same(`${at} .n2`);
});

test('a default namespace, in :is() and :not() too', async () => {
  const at = await addStyle(
    t,
    '@namespace url(http://www.w3.org/1999/xhtml);\n@namespace svg url(http://www.w3.org/2000/svg);\n' +
      '.n3 * { top: 1px }\n.n3 :is(rect) { left: 1px }\n.n3 :is(:is(*)) { right: 1px }\n.n3 svg|*:is(*) { bottom: 1px }\n' +
      '.n3 svg|*:not(*) { order: 1 }\n.n3 :not(svg|rect) { z-index: 1 }\n.n3 *|rect { width: 1px }\n' +
      '.n3 :is(svg|svg) > :where(svg|rect) { height: 1px }',
    '<div class="n3"><span class="n4">x</span><svg class="n5"><rect class="n6"/></svg></div>'
  );
  for (const target of ['.n4', '.n5', '.n6']) await same(`${at} ${target}`);
});

test('SVG: `[xlink|href]`, `svg|`, unprefixed and `*|` selectors, nested :is()', async () => {
  const at = await addStyle(
    t,
    `${NS}${XLINK}svg|a[xlink|href] { top: 1px }\na[href] { left: 1px }\n*|a[*|href="#y"] { right: 1px }\n` +
      'svg|svg :is(svg|g :is(svg|rect)) { order: 1 }\nsvg rect { bottom: 1px }\nh|rect { z-index: 1 }\n' +
      ':is(svg, h|div) rect { width: 1px }',
    '<svg class="n7"><g><a xlink:href="#y" class="n8"><rect class="n9"/></a><rect/></g></svg>'
  );
  await same(`${at} .n8`);
  await same(`${at} .n9`);
  await same(`${at} .n7 g > rect:not([class])`);
});

test('ancestors with neither id nor class, and what they pass on', async () => {
  const at = await addStyle(
    t,
    `${NS}h|section h|div { top: 1px }\nh|section > h|div > h|div { left: 1px }\nh|div { right: 1px }\n` +
      'section div { order: 1 }\nh|b { bottom: 1px }',
    '<section><div><div><b>x</b></div></div></section>'
  );
  await same(`${at} b`);
  await same(`${at} section > div > div`);
  await same(`${at} section > div`);
});

test('elements of a shadow tree, slotted ones too, in a sheet declaring namespaces', async () => {
  const at = await addStyle(t, '', '<div class="n10"><p>light</p></div>');
  await t.page.evaluate(at => {
    const host = document.querySelector(`${at} .n10`) as HTMLElement;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>@namespace h url(http://www.w3.org/1999/xhtml);@namespace svg url(http://www.w3.org/2000/svg);
h|div h|span { top: 1px }
div > span { left: 1px }
*|span { right: 1px }
svg|span { order: 1 }
h|div > h|slot::slotted(h|p) { bottom: 1px }
::slotted(*|p) { z-index: 1 }
</style><div><div><span>x</span><span class="n11">y</span></div><slot></slot></div>`;
  }, at);
  type N = { nodeId: number; children?: N[]; shadowRoots?: N[] };
  const shadow = async (side: Side, css: string) => {
    const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = (await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: `${at} .n10` })).nodeId;
    const find = (n: N): N | undefined =>
      n.nodeId === host ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(find).find(Boolean);
    const sr = find(root as N)?.shadowRoots?.[0];
    assert.ok(sr);
    const { nodeId } = await side.send('DOM.querySelector', { nodeId: sr.nodeId, selector: css });
    return (await side.send('CSS.getMatchedStylesForNode', { nodeId })).matchedCSSRules
      ?.filter(m => m.rule.origin === 'regular')
      .map(m => rule(m.rule));
  };
  for (const css of ['span:not([class])', '.n11']) {
    const chrome = await shadow(t.chrome, css);
    assert.ok(chrome?.length, css);
    assert.deepEqual(await shadow(t.ours, css), chrome, css);
  }
  await same(`${at} .n10 > p`);
});

test('the root element and body, by a path from the root', async () => {
  await addStyle(
    t,
    `${NS}h|html:not(svg|*) { --n12: 1 }\n:root > h|body { --n13: 1 }\nh|html > h|body:not(.n14) { --n15: 1 }`,
    ''
  );
  await same('html');
  await same('body');
});

test('elements of a shadow tree whose sheet declares a default namespace', async () => {
  const at = await addStyle(t, '', '<div class="n16"></div>');
  await t.page.evaluate(at => {
    const host = document.querySelector(`${at} .n16`) as HTMLElement;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>@namespace url(http://www.w3.org/1999/xhtml);
div span { top: 1px }
:is(div) > span { left: 1px }
*|span:not(*) { right: 1px }
</style><div><span>x</span></div>`;
  }, at);
  const shadow = async (side: Side) => {
    const host = await nodeId(side, `${at} .n16`);
    const { node } = await side.send('DOM.describeNode', { nodeId: host, depth: -1, pierce: true });
    const backendNodeId = node.shadowRoots?.[0]?.children?.[1]?.children?.[0]?.backendNodeId;
    assert.ok(backendNodeId);
    const { nodeIds } = await side.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] });
    return (await side.send('CSS.getMatchedStylesForNode', { nodeId: nodeIds[0] ?? 0 })).matchedCSSRules
      ?.filter(m => m.rule.origin === 'regular')
      .map(m => rule(m.rule));
  };
  const chrome = await shadow(t.chrome);
  assert.equal(chrome?.length, 2);
  assert.deepEqual(await shadow(t.ours), chrome);
});

test('what an element inherits is not taken for a match: an id twice, an @scope limit, a slot', async () => {
  const at = await addStyle(
    t,
    `${NS}h|div#n17 { top: 1px }\nh|div.n18 h|div { left: 1px }\n` +
      '@scope (h|div.n19) to (h|div.n21) { h|div { right: 1px } }\nh|section h|b { order: 1 }',
    '<div id="n17" class="n18"><div id="n17" class="n20"><div class="n19"><div><div class="n21"><div>x</div></div></div></div></div></div>' +
      '<section class="n22"><b>y</b></section>'
  );
  for (const target of ['.n18', '.n20', '.n19', '.n19 > div', '.n21', '.n21 > div']) await same(`${at} ${target}`);
  await t.page.evaluate(at => {
    const host = document.querySelector(`${at} .n22`) as HTMLElement;
    host.attachShadow({ mode: 'open' }).innerHTML = '<section><slot></slot></section>';
  }, at);
  await same(`${at} .n22 > b`);
});
