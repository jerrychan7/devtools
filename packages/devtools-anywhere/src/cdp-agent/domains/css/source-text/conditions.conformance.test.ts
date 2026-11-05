// @keyframes of an element's animation, editing conditions and keyframe keys, and editing the
// sheet of a <link>, compared with Chrome: each side on a page of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { matched, rule, style } from '../../../../../test-support/css-source.ts';

let env: Env | undefined;
let sides: { side: Side; t: TestPage }[] = [];

const CSS = `@keyframes kf { from { opacity: 0 } 50%, 60% { opacity: .5 } to { opacity: 1 } }
.c1 { animation: kf 1s paused; }
@supports (display: grid) { .c1 { top: 1px } }
@container (min-width: 0px) { .c1 { left: 1px } }
@scope (.c0) to (.end) { .c1 { right: 1px } }
`;
const LINK = '/packages/devtools-anywhere/test-support/assets/frame.css';

setUpAndTearDown(
  async () => {
    env = await launch();
    const events = ['CSS.styleSheetChanged', 'CSS.styleSheetAdded', 'CSS.styleSheetRemoved'] as const;
    const [a, b] = [await openPage(env, [...events]), await openPage(env, [...events])];
    sides = [
      { side: a.ours, t: a },
      { side: b.chrome, t: b },
    ];
    for (const { side, t } of sides) {
      await t.page.evaluate(
        (css, href) =>
          new Promise<void>(resolve => {
            const s = document.createElement('style');
            s.textContent = css;
            document.head.appendChild(s);
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            link.onload = () => resolve();
            document.head.appendChild(link);
            document.body.insertAdjacentHTML(
              'beforeend',
              '<div class="c0" style="container-type: inline-size"><p class="c1 narrow" id="c1">x</p></div>'
            );
          }),
        CSS,
        LINK
      );
      await side.send('DOM.enable');
      await side.send('CSS.enable');
    }
  },
  () => env?.close()
);

async function each<T>(fn: (side: Side, t: TestPage) => Promise<T>): Promise<[T, T]> {
  const [a, b] = sides;
  assert.ok(a && b);
  return [await fn(a.side, a.t), await fn(b.side, b.t)];
}

async function raw(side: Side) {
  const { root } = await side.send('DOM.getDocument', {});
  const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#c1' });
  return side.send('CSS.getMatchedStylesForNode', { nodeId });
}
const range = (r: Protocol.CSS.SourceRange | undefined) =>
  r && `${r.startLine}:${r.startColumn}-${r.endLine}:${r.endColumn}`;
const keyframes = (k: Protocol.CSS.CSSKeyframesRule[] | undefined) =>
  (k ?? []).map(r => ({
    name: r.animationName.text,
    range: range(r.animationName.range),
    keyframes: r.keyframes.map(f => ({ key: f.keyText.text, range: range(f.keyText.range), style: style(f.style) })),
  }));
const text = (side: Side, styleSheetId: string) =>
  side.send('CSS.getStyleSheetText', { styleSheetId }).then(r => r.text);
/** The <style>'s rules for #c1, its text and the styleSheetChanged since the last call. */
async function after(side: Side) {
  const { sheet, rules } = await matched(side, '#c1');
  const changed = (await side.events('CSS.styleSheetChanged')).length;
  await side.clear();
  return { rules, text: await text(side, sheet), changed };
}

test('the @keyframes of an animation: its name, keys and styles where they are written', async () => {
  const [ours, chrome] = await each(async side => keyframes((await raw(side)).cssKeyframesRules));
  assert.ok(ours.length);
  assert.deepEqual(ours, chrome);
});

test('setKeyframeKey writes the key as given', async () => {
  const [ours, chrome] = await each(async side => {
    const res = await raw(side);
    const kf = res.cssKeyframesRules?.[0];
    const key = kf?.keyframes[1]?.keyText.range;
    const sheet = kf?.keyframes[1]?.styleSheetId;
    assert.ok(key && sheet);
    const set = await side.send('CSS.setKeyframeKey', { styleSheetId: sheet, range: key, keyText: '40%,  60%' });
    return {
      set: [set.keyText.text, range(set.keyText.range)],
      after: await after(side),
      kf: keyframes((await raw(side)).cssKeyframesRules),
    };
  });
  assert.deepEqual(ours, chrome);
});

for (const [name, method, pick, value] of [
  ['@supports', 'CSS.setSupportsText', (r: Protocol.CSS.CSSRule) => r.supports?.[0], '(display:  flex)'],
  [
    '@container',
    'CSS.setContainerQueryText',
    (r: Protocol.CSS.CSSRule) => r.containerQueries?.[0],
    '(min-width:  1px)',
  ],
  ['@scope', 'CSS.setScopeText', (r: Protocol.CSS.CSSRule) => r.scopes?.[0], '(.c0)  to (.none)'],
] as const)
  test(`${method} writes the ${name} condition as given`, async () => {
    const [ours, chrome] = await each(async side => {
      const res = await raw(side);
      const at = res.matchedCSSRules?.map(m => pick(m.rule)).find(x => x?.range);
      assert.ok(at?.range && at.styleSheetId);
      const params = { styleSheetId: at.styleSheetId, range: at.range, text: value };
      const set =
        method === 'CSS.setSupportsText'
          ? (await side.send(method, params)).supports
          : method === 'CSS.setContainerQueryText'
            ? (await side.send(method, params)).containerQuery
            : (await side.send(method, params)).scope;
      return { set: [set.text, range(set.range)], after: await after(side) };
    });
    assert.deepEqual(ours, chrome);
  });

test("a <link>'s sheet: setStyleTexts and setStyleSheetText change its text, no event", async () => {
  const [ours, chrome] = await each(async (side, t) => {
    const res = await raw(side);
    const r = res.matchedCSSRules?.map(m => m.rule).find(x => x.selectorList.text === '.narrow');
    assert.ok(r?.styleSheetId && r.style.range);
    await side.clear();
    const edited = await side.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: r.styleSheetId, range: r.style.range, text: ' color: navy; ' }],
    });
    const afterEdit = await text(side, r.styleSheetId);
    await side.send('CSS.setStyleSheetText', { styleSheetId: r.styleSheetId, text: '.narrow{color:lime}' });
    const events = [
      (await side.events('CSS.styleSheetChanged')).length,
      (await side.events('CSS.styleSheetAdded')).length,
      (await side.events('CSS.styleSheetRemoved')).length,
    ];
    const cssom = await t.page.evaluate(href => {
      const link = [...document.styleSheets].find(s => s.href?.endsWith(href));
      return link ? [...link.cssRules].map(x => x.cssText) : [];
    }, LINK);
    return {
      edited: edited.styles.map(style),
      afterEdit,
      afterSet: await text(side, r.styleSheetId),
      events,
      cssom,
      rule: rule((await raw(side)).matchedCSSRules?.map(m => m.rule).find(x => x.selectorList.text === '.narrow') ?? r),
    };
  });
  assert.deepEqual(ours, chrome);
});
