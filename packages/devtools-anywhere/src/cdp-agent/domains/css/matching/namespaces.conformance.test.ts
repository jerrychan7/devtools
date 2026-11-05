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
