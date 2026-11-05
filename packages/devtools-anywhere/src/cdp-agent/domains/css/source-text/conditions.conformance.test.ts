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

test('setContainerQueryConditionText writes the @container condition as given', async () => {
  const [ours, chrome] = await each(async side => {
    const res = await raw(side);
    const at = res.matchedCSSRules?.map(m => m.rule.containerQueries?.[0]).find(x => x?.range);
    assert.ok(at?.range && at.styleSheetId);
    const set = await side.send('CSS.setContainerQueryConditionText', {
      styleSheetId: at.styleSheetId,
      range: at.range,
      text: '(min-width: 2px)',
    });
    return { set: [set.containerQuery.text, range(set.containerQuery.range)], after: await after(side) };
  });
  assert.deepEqual(ours, chrome);
});

test("setStyleTexts edits a keyframe's style, and the animation follows", async () => {
  const [ours, chrome] = await each(async (side, t) => {
    const kf = (await raw(side)).cssKeyframesRules?.[0]?.keyframes[2];
    assert.ok(kf?.style.range && kf.styleSheetId);
    const { styles } = await side.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: kf.styleSheetId, range: kf.style.range, text: ' opacity: 0.9 ' }],
    });
    const frames = await t.page.evaluate(() => {
      const effect = document.getElementById('c1')?.getAnimations()[0]?.effect;
      return effect instanceof KeyframeEffect ? effect.getKeyframes().map(k => [k.offset, k['opacity']]) : [];
    });
    return {
      styles: styles.map(style),
      frames,
      after: await after(side),
      kf: keyframes((await raw(side)).cssKeyframesRules),
    };
  });
  assert.deepEqual(ours, chrome);
});

test("errors: a key the parser does not take, a range past the text, a range that is no style's", async () => {
  const [ours, chrome] = await each(async side => {
    const res = await raw(side);
    const kf = res.cssKeyframesRules?.[0]?.keyframes[0];
    assert.ok(kf?.keyText.range && kf.styleSheetId);
    const sheet = kf.styleSheetId;
    const error = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        // Ours come through page.evaluate, with where they were thrown on the next lines.
        (e: Error) => (e.message.split('\n')[0] ?? '').replace(/^Protocol error \([\w.]+\): /, '')
      );
    return [
      await error(side.send('CSS.setKeyframeKey', { styleSheetId: sheet, range: kf.keyText.range, keyText: 'bogus' })),
      await error(
        side.send('CSS.setMediaText', {
          styleSheetId: sheet,
          range: { startLine: 99, startColumn: 0, endLine: 99, endColumn: 1 },
          text: 'all',
        })
      ),
      await error(
        side.send('CSS.setStyleTexts', {
          edits: [
            { styleSheetId: sheet, range: { startLine: 0, startColumn: 1, endLine: 0, endColumn: 3 }, text: 'x:y' },
          ],
        })
      ),
    ];
  });
  assert.deepEqual(ours, chrome);
});

test('errors: a range that starts past its end, to every edit and addRule’s location; a selector range not a selector’s', async () => {
  const [ours, chrome] = await each(async side => {
    const res = await raw(side);
    const sheet = res.cssKeyframesRules?.[0]?.keyframes[0]?.styleSheetId;
    assert.ok(sheet);
    const reversed = { startLine: 1, startColumn: 5, endLine: 1, endColumn: 1 };
    const error = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: Error) => (e.message.split('\n')[0] ?? '').replace(/^Protocol error \([\w.]+\): /, '')
      );
    const at = { styleSheetId: sheet, range: reversed };
    return [
      await error(side.send('CSS.setStyleTexts', { edits: [{ ...at, text: 'x:y' }] })),
      await error(side.send('CSS.setRuleSelector', { ...at, selector: '.a' })),
      await error(side.send('CSS.setMediaText', { ...at, text: 'all' })),
      await error(side.send('CSS.setSupportsText', { ...at, text: '(display: grid)' })),
      await error(side.send('CSS.setContainerQueryText', { ...at, text: '(min-width: 0px)' })),
      await error(side.send('CSS.setContainerQueryConditionText', { ...at, text: '(min-width: 0px)' })),
      await error(side.send('CSS.setScopeText', { ...at, text: '(.c0)' })),
      await error(side.send('CSS.setKeyframeKey', { ...at, keyText: 'from' })),
      await error(side.send('CSS.addRule', { styleSheetId: sheet, ruleText: '.r {}', location: reversed })),
      // Inside `.c1 {`: not where a selector starts and ends.
      await error(
        side.send('CSS.setRuleSelector', {
          styleSheetId: sheet,
          range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 },
          selector: '.a',
        })
      ),
    ];
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
