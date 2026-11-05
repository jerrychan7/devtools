// Edits of one client seen by another, and what setStyleSheetText does to the page's CSSOM
// objects, compared with Chrome (each side on a page of its own). Unlike Chrome, where the other
// clients keep the text they had and hear nothing, ours all take the new text and are sent
// styleSheetChanged.
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
    const [a, b] = [await openPage(env, ['CSS.styleSheetChanged']), await openPage(env, [])];
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

test("one client's edit: unlike Chrome, the other is sent styleSheetChanged and takes the new text", async () => {
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
  assert.deepEqual(chrome, { events: [], otherText: CSS });
  assert.deepEqual(ours, {
    events: ['CSS.styleSheetChanged'],
    otherText: CSS.replace('.s1 { color: red }', '.s1 { color: blue }'),
  });
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
  // The other client is told of the sheet removed (the @import's), and with ours, of the change.
  assert.deepEqual(ours.objects, chrome.objects);
  assert.deepEqual(chrome.other, ['CSS.styleSheetRemoved']);
  assert.deepEqual(ours.other, ['CSS.styleSheetChanged', 'CSS.styleSheetRemoved']);
});

test("after another client's setStyleSheetText, this one serves the new text (Chrome: the old one)", async () => {
  const [ours, chrome] = await each(async ({ side, other, otherText }) => {
    const before = await otherText();
    const { sheet } = await matched(side, '#s1');
    const text = '.s1 { color: olive }\n.s3 { top: 3px }';
    await side.send('CSS.setStyleSheetText', { styleSheetId: sheet, text });
    await new Promise(r => setTimeout(r, 200));
    const after = await otherText();
    return {
      kept: after === before,
      isNew: after === text,
      changed: (await other()).includes('CSS.styleSheetChanged'),
    };
  });
  assert.deepEqual(chrome, { kept: true, isNew: false, changed: false });
  assert.deepEqual(ours, { kept: false, isNew: true, changed: true });
});

/** A field of a reply, as `unknown` goes. */
const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? Reflect.get(v, k) : undefined), value);

/** The other client's rule for `.s1`: its sheet and style range. */
async function otherRule(otherCall: Call): Promise<{ styleSheetId: unknown; range: unknown }> {
  const root = field(await otherCall('DOM.getDocument', {}), 'root', 'nodeId');
  const nodeId = field(await otherCall('DOM.querySelector', { nodeId: root, selector: '#s1' }), 'nodeId');
  const found = field(await otherCall('CSS.getMatchedStylesForNode', { nodeId }), 'matchedCSSRules');
  const rule = Array.isArray(found)
    ? found.map(m => field(m, 'rule')).find(r => field(r, 'selectorList', 'text') === '.s1')
    : undefined;
  return { styleSheetId: field(rule, 'styleSheetId'), range: field(rule, 'style', 'range') };
}

/** Our side: Chrome's other client keeps the old text, so there is nothing to compare. */
function ours() {
  const [a] = sides;
  assert.ok(a);
  return a;
}

test('after another client replaced the rules, this one edits the new text in place, with its ranges', async () => {
  const { side, otherCall } = ours();
  const { sheet } = await matched(side, '#s1');
  await side.send('CSS.setStyleSheetText', { styleSheetId: sheet, text: '.s0 { top: 0 }\n.s1 { color: green }\n' });
  const { styleSheetId, range } = await otherRule(otherCall);
  assert.deepEqual(range, { startLine: 1, startColumn: 5, endLine: 1, endColumn: 19 });
  await otherCall('CSS.setStyleTexts', { edits: [{ styleSheetId, range, text: ' color: pink ' }] });
  const edited = '.s0 { top: 0 }\n.s1 { color: pink }\n';
  // Not serialized: both clients serve the text as written, edited where the range was.
  assert.equal(field(await otherCall('CSS.getStyleSheetText', { styleSheetId }), 'text'), edited);
  assert.equal((await side.send('CSS.getStyleSheetText', { styleSheetId: sheet })).text, edited);
});

test("the other client's addRule: this one takes the text and is sent styleSheetChanged", async () => {
  const { side, otherCall } = ours();
  const { sheet } = await matched(side, '#s1');
  await side.send('CSS.setStyleSheetText', { styleSheetId: sheet, text: '.s1 { color: green }\n' });
  await side.clear();
  const { styleSheetId } = await otherRule(otherCall);
  await otherCall('CSS.addRule', {
    styleSheetId,
    ruleText: '.s9 { left: 9px }',
    location: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
  });
  await new Promise(r => setTimeout(r, 200));
  assert.ok((await side.events('CSS.styleSheetChanged')).some(e => e.styleSheetId === sheet));
  assert.equal(
    (await side.send('CSS.getStyleSheetText', { styleSheetId: sheet })).text,
    '.s1 { color: green }\n.s9 { left: 9px }'
  );
  // Ranges of the text as written.
  const { rules } = await matched(side, '#s1');
  assert.ok(rules.length > 0);
});
