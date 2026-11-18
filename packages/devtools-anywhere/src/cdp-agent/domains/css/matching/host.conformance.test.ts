// The rules of a shadow tree for its host, compared with Chrome: the argument of `:host()` and
// `:host-context()` ends at its own parenthesis, not at the last one of the selector; and the host
// is featureless there, so only those alone match it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { addStyle, nodeId, rule } from '../../../../../test-support/css-source.ts';

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

/** The rules of the shadow tree's sheets for the host, on one side. */
const hostRules = async (side: Side, selector: string) =>
  (
    await side.send('CSS.getMatchedStylesForNode', {
      nodeId: await nodeId(side, selector),
    })
  ).matchedCSSRules
    ?.filter(m => m.rule.origin === 'regular')
    .map(m => rule(m.rule));

test('`:host(.a) :not(.b)` is for the shadow tree; `:host-context(.a):not(.b)` for neither', async () => {
  const at = await addStyle(t, '', '<div class="h1"><div class="h2"></div></div>');
  await t.page.evaluate(at => {
    const host = document.querySelector(`${at} .h2`) as HTMLElement;
    host.attachShadow({ mode: 'open' }).innerHTML = `<style>
:host(.h2) :not(.b) { top: 1px }
:host(*) :is(.x, .y) { left: 1px }
:host-context(.h1):not(.b) { right: 1px }
:host(:is(.h2, .z)):not(.b) { order: 1 }
:host-context(.h1) > :not(.b) { bottom: 1px }
</style><span>x</span>`;
  }, at);
  const [ours, chrome] = [await hostRules(t.ours, `${at} .h2`), await hostRules(t.chrome, `${at} .h2`)];
  assert.deepEqual(chrome, []);
  assert.deepEqual(ours, chrome);
});

/** Selectors of a shadow tree's rules, each with whether Chrome applies it to the host. */
const CASES: [string, boolean][] = [
  [':host', true],
  [':host(.h)', true],
  [':host:hover', false],
  [':host(.h):not(.b)', false],
  [':host:not(.b)', false],
  [':host(.h).x', false],
  [':host:is(:host(.h))', true],
  [':host:is(.x, :host(.h))', true],
  [':host:where(:host(.z))', false],
  [':host:not(:host(.z))', true],
  [':host(.z):is(:host(.h))', false],
  [':is(:host(.h))', true],
  [':host-context(.c)', true],
  [':host-context(.c):not(.b)', false],
  [':host:focus-within', false],
  [':host::before', false],
  [':host(.h):has(span)', true],
];

test('the host is featureless: only `:host` and the like match it', async () => {
  const html = CASES.map((_, i) => `<div class="c"><div class="h x n${i}"></div></div>`).join('');
  const at = await addStyle(t, '', html);
  await t.page.evaluate(
    (at, selectors) =>
      selectors.forEach((s, i) => {
        const host = document.querySelector(`${at} .n${i}`);
        if (host) host.attachShadow({ mode: 'open' }).innerHTML = `<style>${s} { order: 1 }</style><span>x</span>`;
      }),
    at,
    CASES.map(([s]) => s)
  );
  for (const [i, [selector, applies]] of CASES.entries()) {
    const [ours, chrome] = [await hostRules(t.ours, `${at} .n${i}`), await hostRules(t.chrome, `${at} .n${i}`)];
    assert.equal(chrome?.length, applies ? 1 : 0, `Chrome, ${selector}`);
    assert.deepEqual(ours, chrome, selector);
  }
});

test('`:host:hover` does not match a hovered host; `:host(:hover)` does', async () => {
  const at = await addStyle(t, '', '<div class="hv" style="width: 50px; height: 50px"></div>');
  await t.page.evaluate(at => {
    const host = document.querySelector(`${at} .hv`);
    if (host)
      host.attachShadow({ mode: 'open' }).innerHTML =
        '<style>:host:hover { order: 1 } :host(:hover) { order: 2 }</style><span>x</span>';
  }, at);
  await t.page.hover(`${at} .hv`);
  const [ours, chrome] = [await hostRules(t.ours, `${at} .hv`), await hostRules(t.chrome, `${at} .hv`)];
  assert.deepEqual(
    chrome?.map(r => r.text),
    [':host(:hover)']
  );
  assert.deepEqual(ours, chrome);
});
