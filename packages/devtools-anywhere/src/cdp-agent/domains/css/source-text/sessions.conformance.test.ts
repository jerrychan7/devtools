// Edits of one client seen by another, and what setStyleSheetText does to the page's CSSOM
// objects, compared with Chrome (each side on a page of its own).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { matched } from '../../../../../test-support/css-source.ts';

let env: Env | undefined;
/** A call the other client makes. */
type Call = (method: string, params: object) => Promise<unknown>;
let sides: {
  side: Side;
  t: TestPage;
  other: () => Promise<string[]>;
  otherText: () => Promise<string>;
  otherCall: Call;
}[] = [];

const CSS = `@import url(/packages/devtools-anywhere/test-support/assets/frame.css);
@namespace svg url(http://www.w3.org/2000/svg);
.s1 { color: red }
.s2 { top: 1px }`;

setUpAndTearDown(
  async () => {
    env = await launch();
    const [a, b] = [await openPage(env, []), await openPage(env, [])];
    for (const t of [a, b])
      await t.page.evaluate(css => {
        const s = document.createElement('style');
        s.id = 'sess';
        s.textContent = css;
        document.head.appendChild(s);
        document.body.insertAdjacentHTML('beforeend', '<p class="s1" id="s1">x</p>');
      }, CSS);
    // A second client: another session of our agent, another CDP session of Chrome's.
    await a.page.evaluate(() => {
      const second = window.DevtoolsAnywhere.createCdpSession();
      const seen: string[] = [];
      Reflect.set(window, '__second', seen);
      Reflect.set(window, '__secondSession', second);
      const ids: string[] = [];
      Reflect.set(window, '__secondIds', ids);
      second.onMessage(m => {
        const msg: { method?: string; params?: { header?: { styleSheetId: string } } } = JSON.parse(m);
        if (msg.method?.startsWith('CSS.styleSheet')) seen.push(msg.method);
        if (msg.params?.header) ids.push(msg.params.header.styleSheetId);
      });
      void second.call('DOM.enable', {}).then(() => second.call('CSS.enable', {}));
    });
    const cdp = await b.page.createCDPSession();
    const seen: string[] = [];
    const ids: string[] = [];
    for (const m of ['CSS.styleSheetAdded', 'CSS.styleSheetChanged', 'CSS.styleSheetRemoved'] as const)
      cdp.on(m, () => seen.push(m));
    cdp.on('CSS.styleSheetAdded', e => ids.push(e.header.styleSheetId));
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    sides = [
      {
        side: a.ours,
        t: a,
        other: () => a.page.evaluate(() => (Reflect.get(window, '__second') as string[]).splice(0)),
        otherCall: (method, params) =>
          a.page.evaluate(
            (method, params) =>
              (
                Reflect.get(window, '__secondSession') as ReturnType<typeof window.DevtoolsAnywhere.createCdpSession>
              ).call(method, params),
            method,
            params
          ),
        otherText: () =>
          a.page.evaluate(async () => {
            const s = Reflect.get(window, '__secondSession') as ReturnType<
              typeof window.DevtoolsAnywhere.createCdpSession
            >;
            const texts: string[] = [];
            for (const styleSheetId of Reflect.get(window, '__secondIds') as string[]) {
              const r: unknown = await s.call('CSS.getStyleSheetText', { styleSheetId }).catch(() => null);
              const text: unknown = r && typeof r === 'object' ? Reflect.get(r, 'text') : '';
              if (typeof text === 'string') texts.push(text);
            }
            return texts.find(x => x.includes('.s1')) ?? '';
          }),
      },
      {
        side: b.chrome,
        t: b,
        other: async () => seen.splice(0),
        otherCall: (method, params) => cdp.send(method as 'CSS.enable', params as never),
        otherText: async () => {
          const texts = await Promise.all(
            ids.map(styleSheetId =>
              cdp.send('CSS.getStyleSheetText', { styleSheetId }).then(
                r => r.text,
                () => ''
              )
            )
          );
          return texts.find(x => x.includes('.s1')) ?? '';
        },
      },
    ];
    for (const { side } of sides) {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
    }
    await new Promise(r => setTimeout(r, 300));
    for (const { other } of sides) await other();
  },
  () => env?.close()
);

async function each<T>(fn: (s: (typeof sides)[number]) => Promise<T>): Promise<[T, T]> {
  const [a, b] = sides;
  assert.ok(a && b);
  return [await fn(a), await fn(b)];
}

test("one client's edit sends the other no styleSheetChanged either", async () => {
  const [ours, chrome] = await each(async ({ side, other, otherText }) => {
    const { root } = await side.send('DOM.getDocument', {});
    const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#s1' });
    const res = await side.send('CSS.getMatchedStylesForNode', { nodeId });
    const rule = res.matchedCSSRules?.map(m => m.rule).find(r => r.selectorList.text === '.s1');
    assert.ok(rule?.styleSheetId && rule.style.range);
    await side.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: rule.styleSheetId, range: rule.style.range, text: ' color: blue ' }],
    });
    await new Promise(r => setTimeout(r, 200));
    return { events: await other(), otherText: await otherText() };
  });
  assert.deepEqual(ours, chrome);
  // The other client keeps the text it had.
  assert.equal(ours.otherText, CSS);
});

test('setStyleSheetText keeps the sheet, replaces its rules: those the page held are detached', async () => {
  const [ours, chrome] = await each(async ({ side, t, other }) => {
    const { sheet } = await matched(side, '#s1');
    await t.page.evaluate(() => {
      const s = document.getElementById('sess');
      if (!(s instanceof HTMLStyleElement) || !s.sheet) throw new Error('no sheet');
      Reflect.set(window, '__held', { sheet: s.sheet, rules: [...s.sheet.cssRules] });
    });
    await side.send('CSS.setStyleSheetText', {
      styleSheetId: sheet,
      // An @import after @namespace is dropped.
      text: '@namespace svg url(http://www.w3.org/2000/svg);\n@import url(/x.css);\n.s1 { color: green }\n.s2 { top: 2px }',
    });
    const objects = await t.page.evaluate(() => {
      const s = document.getElementById('sess');
      if (!(s instanceof HTMLStyleElement) || !s.sheet) throw new Error('no sheet');
      const held = Reflect.get(window, '__held') as { sheet: CSSStyleSheet; rules: CSSRule[] };
      return {
        sameSheet: s.sheet === held.sheet,
        rules: [...s.sheet.cssRules].map(r => r.cssText),
        sameRules: held.rules.map((r, i) => r === s.sheet?.cssRules[i]),
        attached: held.rules.map(r => !!r.parentStyleSheet),
      };
    });
    return { objects, other: await other() };
  });
  assert.deepEqual(ours, chrome);
});

test("after another client's setStyleSheetText, this one's getStyleSheetText gives what Chrome's does", async () => {
  const [ours, chrome] = await each(async ({ side, otherText }) => {
    const before = await otherText();
    const { sheet } = await matched(side, '#s1');
    const text = '.s1 { color: olive }\n.s3 { top: 3px }';
    await side.send('CSS.setStyleSheetText', { styleSheetId: sheet, text });
    const after = await otherText();
    return { after, kept: after === before, isNew: after === text };
  });
  assert.deepEqual(ours, chrome);
});

/** A field of a reply, as `unknown` goes. */
const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? Reflect.get(v, k) : undefined), value);

test('after another client replaced the rules, an edit with the ranges of the old text goes as in Chrome', async () => {
  const [ours, chrome] = await each(async ({ side, otherCall }) => {
    const root = field(await otherCall('DOM.getDocument', {}), 'root', 'nodeId');
    const nodeId = field(await otherCall('DOM.querySelector', { nodeId: root, selector: '#s1' }), 'nodeId');
    const found = field(await otherCall('CSS.getMatchedStylesForNode', { nodeId }), 'matchedCSSRules');
    const rule = Array.isArray(found)
      ? found.map(m => field(m, 'rule')).find(r => field(r, 'selectorList', 'text') === '.s1')
      : undefined;
    const edit = {
      styleSheetId: field(rule, 'styleSheetId'),
      range: field(rule, 'style', 'range'),
      text: ' color: pink ',
    };
    // This client replaces the rules: the other's range is of rules gone.
    const { sheet } = await matched(side, '#s1');
    await side.send('CSS.setStyleSheetText', { styleSheetId: sheet, text: '.s0 { top: 0 }\n.s1 { color: green }' });
    return otherCall('CSS.setStyleTexts', { edits: [edit] }).then(
      () => 'ok',
      // Ours come through page.evaluate, with where they were thrown on the next lines.
      (e: Error) => (e.message.split('\n')[0] ?? '').replace(/^Protocol error \([\w.]+\): /, '')
    );
  });
  assert.equal(ours, chrome);
});
