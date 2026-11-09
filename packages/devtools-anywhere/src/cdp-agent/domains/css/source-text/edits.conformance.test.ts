// Editing a sheet's text, compared with Chrome: each side edits a page of its own (both act on
// the page they are in). Edits change the text as written, leave a <style>'s textContent and id
// alone, and send no CSS.styleSheetChanged; changes the page makes through the CSSOM do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, EventName, EventParams, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { addStyle, matched, nodeId, rule, style } from '../../../../../test-support/css-source.ts';

let env: Env | undefined;
/** Our agent on one page, Chrome on another. */
let sides: { side: Side; t: TestPage }[] = [];

const CSS = `/*a*/ .t1 , .t2  { color: red }
@media screen and (min-width: 1px) { .t1 { top: 1px } }
.t1 { left: 1px;
  /* right: 1px; */
}
`;

setUpAndTearDown(
  async () => {
    env = await launch();
    const events = ['CSS.styleSheetAdded', 'CSS.styleSheetChanged', 'CSS.styleSheetRemoved'] as const;
    const [a, b] = [await openPage(env, [...events]), await openPage(env, [...events])];
    sides = [
      { side: a.ours, t: a },
      { side: b.chrome, t: b },
    ];
    for (const { side, t } of sides) {
      await t.page.evaluate(css => {
        const s = document.createElement('style');
        s.id = 'edited';
        s.textContent = css;
        document.head.appendChild(s);
        document.body.insertAdjacentHTML('beforeend', '<p class="t1 t3" id="e1">x</p>');
      }, CSS);
      await side.send('DOM.enable');
      await side.send('CSS.enable');
    }
  },
  () => env?.close()
);

/** Runs `fn` on both sides; returns [ours, chrome]. */
async function each<T>(fn: (side: Side, t: TestPage) => Promise<T>): Promise<[T, T]> {
  const [a, b] = sides;
  assert.ok(a && b);
  return [await fn(a.side, a.t), await fn(b.side, b.t)];
}

/** The events of `method` since the last clear, once there is one (polled: they come over CDP). */
async function arrived<E extends EventName>(side: Side, method: E): Promise<EventParams<E>[]> {
  for (let deadline = Date.now() + 5000; ; await new Promise(r => setTimeout(r, 20))) {
    const events = await side.events(method);
    if (events.length || Date.now() > deadline) return events;
  }
}

const text = (side: Side, styleSheetId: string) =>
  side.send('CSS.getStyleSheetText', { styleSheetId }).then(r => r.text);
const textContent = (t: TestPage) => t.page.evaluate(() => document.getElementById('edited')?.textContent);
/** The rules of the edited sheet for #e1, the sheet's id, and the events since the last call. */
async function state(side: Side, t: TestPage) {
  const { sheet, rules } = await matched(side, '#e1');
  const changed = (await side.events('CSS.styleSheetChanged')).length;
  await side.clear();
  return {
    sheet,
    rules,
    text: await text(side, sheet),
    textContent: await textContent(t),
    changed,
  };
}
const strip = (s: Awaited<ReturnType<typeof state>>) => ({
  ...s,
  sheet: undefined,
});

test('setStyleTexts replaces the range only, keeps textContent, sends no styleSheetChanged', async () => {
  const [ours, chrome] = await each(async (side, t) => {
    await state(side, t);
    const { sheet, rules } = await rawRules(side);
    const raw = rules.find(r => r.style.cssText?.includes('left'));
    assert.ok(raw?.style.range);
    const res = await side.send('CSS.setStyleTexts', {
      edits: [
        {
          styleSheetId: sheet,
          range: raw.style.range,
          text: ' left: 2px; /* top: 3px; */ color: blue ',
        },
      ],
    });
    return {
      styles: res.styles.map(style),
      after: strip(await state(side, t)),
    };
  });
  assert.deepEqual(ours, chrome);
  assert.equal(ours.after.changed, 0);
  assert.equal(ours.after.textContent, CSS);
});

test('setStyleTexts is all or none: an edit failing takes back those before it', async () => {
  const [ours, chrome] = await each(async (side, t) => {
    const before = strip(await state(side, t));
    const { sheet, rules } = await rawRules(side);
    const raw = rules.find(r => r.style.cssText?.includes('left'));
    const selector = raw?.selectorList.selectors[0]?.range;
    assert.ok(raw?.style.range && selector);
    const error = await side
      .send('CSS.setStyleTexts', {
        edits: [
          { styleSheetId: sheet, range: raw.style.range, text: ' left: 4px ' },
          // A selector's range: no style's.
          { styleSheetId: sheet, range: selector, text: 'color: green' },
        ],
      })
      .then(
        () => 'ok',
        (e: Error) => (e.message.split('\n')[0] ?? '').replace(/^Protocol error \([\w.]+\): /, '')
      );
    return { error, unchanged: JSON.stringify(strip(await state(side, t))) === JSON.stringify(before) };
  });
  assert.deepEqual(ours, chrome);
  assert.equal(ours.unchanged, true);
});

/** The raw rules of the edited sheet matching #e1. */
async function rawRules(side: Side): Promise<{ sheet: string; rules: Protocol.CSS.CSSRule[] }> {
  const { root } = await side.send('DOM.getDocument', {});
  const { nodeId } = await side.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '#e1',
  });
  const res = await side.send('CSS.getMatchedStylesForNode', { nodeId });
  const { sheet } = await matched(side, '#e1');
  return {
    sheet,
    rules: (res.matchedCSSRules ?? []).map(m => m.rule).filter(r => r.styleSheetId === sheet),
  };
}

test('setRuleSelector writes the selector as given and returns it normalized', async () => {
  const [ours, chrome] = await each(async (side, t) => {
    const { sheet, rules } = await rawRules(side);
    const target = rules.find(r => r.selectorList.selectors.length === 2);
    const [a, b] = [target?.selectorList.selectors[0]?.range, target?.selectorList.selectors[1]?.range];
    assert.ok(a && b);
    const range = {
      startLine: a.startLine,
      startColumn: a.startColumn,
      endLine: b.endLine,
      endColumn: b.endColumn,
    };
    const res = await side.send('CSS.setRuleSelector', {
      styleSheetId: sheet,
      range,
      selector: '.t1,   .t3',
    });
    return {
      res: res.selectorList.selectors.map(s => [s.text, s.range]),
      text: res.selectorList.text,
      after: strip(await state(side, t)),
    };
  });
  assert.deepEqual(ours, chrome);
});

test('setMediaText writes the condition as given; a range not a condition’s is NotFoundError', async () => {
  const [ours, chrome] = await each(async (side, t) => {
    const { sheet, rules } = await rawRules(side);
    const range = rules.find(r => r.media?.length)?.media?.[0]?.range;
    assert.ok(range);
    const res = await side.send('CSS.setMediaText', {
      styleSheetId: sheet,
      range,
      text: 'screen  and (min-width: 2px)',
    });
    const wrong = await side
      .send('CSS.setMediaText', {
        styleSheetId: sheet,
        range: { ...range, startColumn: range.startColumn + 1 },
        text: 'print',
      })
      .then(
        () => 'ok',
        (e: Error) => /NotFoundError Source range didn't match existing source range/.test(e.message)
      );
    return {
      text: res.media.text,
      range: res.media.range,
      wrong,
      after: strip(await state(side, t)),
    };
  });
  assert.deepEqual(ours, chrome);
});

test('addRule inserts the text as it is, where asked', async () => {
  const [ours, chrome] = await each(async (side, t) => {
    const { sheet } = await rawRules(side);
    const location = { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 };
    const res = await side.send('CSS.addRule', {
      styleSheetId: sheet,
      location,
      ruleText: '.t1 { order: 1 }',
    });
    return { rule: rule(res.rule), after: strip(await state(side, t)) };
  });
  assert.deepEqual(ours, chrome);
});

test('setStyleSheetText replaces the whole text, invalid rules kept, textContent untouched', async () => {
  const [ours, chrome] = await each(async (side, t) => {
    const { sheet } = await rawRules(side);
    const res = await side.send('CSS.setStyleSheetText', {
      styleSheetId: sheet,
      text: '/*x*/\n.t1 { color: pink }\n.t1 {{ bad }\n',
    });
    const after = await state(side, t);
    return { res, sameId: after.sheet === sheet, after: strip(after) };
  });
  assert.deepEqual(ours, chrome);
  assert.ok(ours.sameId);
});

test('changes through the CSSOM: styleSheetChanged, same id; replaceSync gives the new text', async () => {
  const [ours, chrome] = await each(async (side, t) => {
    const { sheet } = await rawRules(side);
    await side.clear();
    await t.page.evaluate(() => {
      const s = document.getElementById('edited');
      if (!(s instanceof HTMLStyleElement) || !s.sheet) throw new Error('no sheet');
      s.sheet.insertRule('.t1 { word-spacing: 1px }', 0);
      const r = s.sheet.cssRules[0];
      if (r instanceof CSSStyleRule) r.style.setProperty('margin', '3px');
    });
    const changed = (await arrived(side, 'CSS.styleSheetChanged')).map(e => e.styleSheetId === sheet);
    // A constructed sheet's text is the one replaceSync gets.
    await side.clear();
    await t.page.evaluate(() => {
      const c = new CSSStyleSheet();
      c.replaceSync('.x { color: red }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, c];
    });
    const added = (await arrived(side, 'CSS.styleSheetAdded')).map(e => e.header.styleSheetId);
    const id = added[added.length - 1];
    assert.ok(id);
    await side.clear();
    await t.page.evaluate(() => document.adoptedStyleSheets.at(-1)?.replaceSync('/*c*/ .ctor { color: teal }'));
    const replaced = (await arrived(side, 'CSS.styleSheetChanged')).map(e => e.styleSheetId === id);
    // Setting a <style>'s text makes another sheet, with another id.
    await side.clear();
    await t.page.evaluate(() => {
      const s = document.getElementById('edited');
      if (s) s.textContent = '.t1 { color: olive }';
    });
    await arrived(side, 'CSS.styleSheetAdded');
    const removed = (await side.events('CSS.styleSheetRemoved')).map(e => e.styleSheetId === sheet);
    const readded = (await side.events('CSS.styleSheetAdded')).map(e => e.header.styleSheetId !== sheet);
    const gone = await text(side, sheet).then(
      () => 'ok',
      (e: Error) => /No style sheet with given id found/.test(e.message)
    );
    return {
      changed,
      replaced,
      replacedText: await text(side, id),
      removed,
      readded,
      gone,
    };
  });
  assert.deepEqual(ours, chrome);
});

for (const css of [
  '@namespace svg url(http://www.w3.org/2000/svg);\nsvg|\\61 { top: 1px }\n.u1 { color: red }',
  '@namespace url(http://www.w3.org/1999/xhtml);\n@namespace s "http://www.w3.org/2000/svg";\n|p, s|\\61 , *|p.u1 { top: 1px }\n.u1 { color: red }',
])
  test(`a sheet with @namespace is edited as written: ${JSON.stringify(css)}`, async () => {
    // `svg|\61` is paired as parsed after the sheet's @namespace rules.
    const [ours, chrome] = await each(async (side, t) => {
      const at = await addStyle(t, css, '<p class="u1">x</p>');
      const res = await side.send('CSS.getMatchedStylesForNode', {
        nodeId: await nodeId(side, `${at} .u1`),
      });
      const found = res.matchedCSSRules?.map(m => m.rule).find(r => r.selectorList.text === '.u1');
      assert.ok(found?.styleSheetId && found.style.range && found.selectorList.selectors[0]?.range);
      const id = found.styleSheetId;
      const outcome = (p: Promise<unknown>) =>
        p.then(
          () => 'ok',
          (e: Error) => e.message
        );
      const styleEdit = await outcome(
        side.send('CSS.setStyleTexts', {
          edits: [{ styleSheetId: id, range: found.style.range, text: 'color: blue' }],
        })
      );
      const selectorEdit = await outcome(
        side.send('CSS.setRuleSelector', {
          styleSheetId: id,
          range: found.selectorList.selectors[0].range,
          selector: '.u1, .u2',
        })
      );
      const rules = await t.page.evaluate(
        at =>
          [...((document.getElementById(`${at.slice(1)}-style`) as HTMLStyleElement).sheet?.cssRules ?? [])].map(
            r => r.cssText
          ),
        at
      );
      return { found: rule(found), styleEdit, selectorEdit, rules, text: await text(side, id) };
    });
    assert.deepEqual(ours, chrome);
    assert.equal(chrome.styleEdit, 'ok');
    assert.ok(chrome.text.startsWith('@namespace'));
  });

test('selectors with escapes: setStyleTexts and setRuleSelector edit the text as written', async () => {
  const css = `.x\\31 0 , .\\78 2\\:b { color: red }
.x\\31 0 { :\\6e ot(.\\7a) { top: 1px } }
`;
  const [ours, chrome] = await each(async (side, t) => {
    const at = await addStyle(t, css, '<p class="x10 x2:b">x</p>');
    const target = `${at} p`;
    const first = await matched(side, target);
    const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, target) });
    const raws = (res.matchedCSSRules ?? []).map(m => m.rule).filter(r => r.styleSheetId === first.sheet);
    const both = raws.find(r => r.selectorList.selectors.length === 2);
    assert.ok(both?.style.range);
    const styles = await side.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: first.sheet, range: both.style.range, text: ' color: blue ' }],
    });
    const [a, b] = [both.selectorList.selectors[0]?.range, both.selectorList.selectors[1]?.range];
    assert.ok(a && b);
    const selector = await side.send('CSS.setRuleSelector', {
      styleSheetId: first.sheet,
      range: { startLine: a.startLine, startColumn: a.startColumn, endLine: b.endLine, endColumn: b.endColumn },
      selector: '.\\78 2\\:b,  .x\\31 0',
    });
    const last = await matched(side, target);
    return {
      first: first.rules,
      styles: styles.styles.map(style),
      selector: selector.selectorList.selectors.map(s => [s.text, s.range]),
      rules: last.rules,
      text: await text(side, last.sheet),
    };
  });
  assert.deepEqual(ours, chrome);
  // As written and edited, not serialized from the CSSOM.
  assert.ok(ours.text.includes('.\\78 2\\:b,  .x\\31 0 { color: blue }'), ours.text);
  assert.ok(ours.text.includes(':\\6e ot(.\\7a)'), ours.text);
});

/** As Chrome's VerifyStyleText refuses them: closing the block, a `}` more, something left open. */
const REFUSED = [
  ' color: blue }',
  ' color: blue } .d { top: 1px ',
  ' color: blue } }',
  ' color: blue; /* open',
  ' color: blue; x { top: 1px ',
  ' color: "open',
  ' color: blue } @import "y.css"; .a2 { top: 1px ',
  ' color: blue } @layer y',
  ' color: red; } ',
  'color:red } ; top:0',
  'color: red; } top: 1px',
];
/** Taken: what stays in the block, `}` in a string, comment or URL, rules in the block. */
const TAKEN = [
  '',
  ';',
  ' content: "}" ',
  ' /* } */ color: red ',
  ' color: red !important ',
  ' background: url(a}) ',
  ' --x: { a } ',
  ' color: red; & i { top: 1px } ',
  'color: blue; }{',
  'color: red; ]',
  // Taken for an element's style too, though its attribute is read as declarations only.
  'a{top:0} color:red',
  '@media x{} color:red',
  'x { top: 1px } left: 2px',
  '@media x { top: 1px } color: red',
];
const STYLED = '@media screen {\n  .sv { color: red }\n  .sw { top: 0 }\n}\n.sx { color: red }\n';
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => (e.message.split('\n')[0] ?? '').replace(/^Protocol error \([\w.]+\): /, '')
  );

/**
 * Each text set, with CSS.setStyleTexts, on `.sv` in an @media and on an element's style, each in
 * a sheet and an element of its own: the outcome of both, the sheet's text and the element's style
 * attribute after them. `around`, when given, runs the two edits.
 */
async function styleTexts(
  side: Side,
  t: TestPage,
  texts: string[],
  around?: (edit: () => Promise<void>) => Promise<void>
) {
  const out: { to: string; sheet: string; element: string; text: string; attribute: unknown }[] = [];
  for (const to of texts) {
    const at = await addStyle(t, STYLED, '<p class="sv sw sx" style="top: 1px">x</p>');
    const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, `${at} p`) });
    // The last: in this text's sheet, added after the others.
    const found = res.matchedCSSRules?.map(m => m.rule).findLast(r => r.selectorList.text === '.sv');
    const inline = res.inlineStyle;
    assert.ok(found?.styleSheetId && found.style.range && inline?.styleSheetId && inline.range);
    const [sheetId, range, inlineId, inlineRange] = [
      found.styleSheetId,
      found.style.range,
      inline.styleSheetId,
      inline.range,
    ];
    let sheet = '';
    let element = '';
    const edit = async () => {
      sheet = await outcome(
        side.send('CSS.setStyleTexts', {
          edits: [{ styleSheetId: sheetId, range, text: to }],
        })
      );
      element = await outcome(
        side.send('CSS.setStyleTexts', {
          edits: [{ styleSheetId: inlineId, range: inlineRange, text: to }],
        })
      );
    };
    await (around ? around(edit) : edit());
    const attribute = await t.page.evaluate(at => document.querySelector(`${at} p`)?.getAttribute('style'), at);
    out.push({ to, sheet, element, text: await text(side, sheetId), attribute });
  }
  return out;
}

test('style texts that would not stay the style are refused, in a sheet and on an element', async () => {
  const [ours, chrome] = await each((side, t) => styleTexts(side, t, [...REFUSED, ...TAKEN]));
  assert.deepEqual(ours, chrome);
  for (const r of chrome.slice(0, REFUSED.length)) assert.ok(r.sheet !== 'ok' && r.element !== 'ok', r.to);
  for (const r of chrome.slice(REFUSED.length)) assert.ok(r.sheet === 'ok' && r.element === 'ok', r.to);
});

test('style texts checked through the native CSSOM, though the page replaced it', async () => {
  // What styleTextFits reads (style.ts), replaced by the page: the check is Chrome's still.
  const [ours, chrome] = await each((side, t) =>
    styleTexts(side, t, [' color: blue }', ' color: red; } ', ' color: green ', ' content: "}" '], async edit => {
      try {
        await t.page.evaluate(() => {
          // What to put back, kept before anything is replaced.
          const saved: [object, string, PropertyDescriptor][] = [];
          (globalThis as unknown as { restore?: () => void }).restore = () => {
            for (const [proto, name, d] of saved) Object.defineProperty(proto, name, d);
          };
          const lie = (proto: object, name: string, d: PropertyDescriptor) => {
            saved.push([proto, name, Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor]);
            Object.defineProperty(proto, name, { configurable: true, ...d });
          };
          lie(CSSStyleDeclaration.prototype, 'length', { get: () => 1 });
          lie(CSSStyleRule.prototype, 'selectorText', { get: () => 'div' });
          lie(CSSStyleDeclaration.prototype, 'getPropertyValue', { value: () => 'x' });
          lie(CSSRuleList.prototype, 'item', { value: () => null });
        });
        await edit();
      } finally {
        await t.page.evaluate(() => (globalThis as unknown as { restore?: () => void }).restore?.());
      }
    })
  );
  assert.deepEqual(ours, chrome);
});

test("setStyleTexts: a range that is no style's is told before an invalid text; a second edit refused takes back the first", async () => {
  const [ours, chrome] = await each(async (side, t) => {
    const at = await addStyle(t, STYLED, '<p class="sv sw sx">x</p>');
    const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, `${at} p`) });
    const rules = res.matchedCSSRules?.map(m => m.rule) ?? [];
    // The last: in this test's sheet, added after the others.
    const sv = rules.findLast(r => r.selectorList.text === '.sv');
    const sw = rules.findLast(r => r.selectorList.text === '.sw');
    assert.ok(sv?.styleSheetId && sv.style.range && sw?.style.range);
    const id = sv.styleSheetId;
    const wrong = { ...sv.style.range, startColumn: sv.style.range.startColumn - 1 };
    const mismatch = await outcome(
      side.send('CSS.setStyleTexts', { edits: [{ styleSheetId: id, range: wrong, text: '}' }] })
    );
    const second = await outcome(
      side.send('CSS.setStyleTexts', {
        edits: [
          // The later style first: the first edit moves no range of the second.
          { styleSheetId: id, range: sw.style.range, text: ' top: 2px; left: 0 ' },
          { styleSheetId: id, range: sv.style.range, text: ' color: green }' },
        ],
      })
    );
    return { mismatch, second, text: await text(side, id) };
  });
  assert.deepEqual(ours, chrome);
  assert.match(chrome.second, /edit #1/);
  assert.ok(chrome.text.includes('.sw { top: 0 }'));
});

test('setStyleTexts: two edits, the first making its style longer, the second at its range from before', async () => {
  // Every range is read in the text from before the first edit, its offsets applied to the text
  // the edits before it left: once `.sv` is longer, those of `.sw` are no style's, on its line
  // or on the next.
  const [ours, chrome] = await each(async (side, t) => {
    const out: unknown[] = [];
    for (const css of [STYLED, '.sv { color: red } .sw { top: 0 }\n'])
      for (const second of [' top: 2px; left: 0 ', ' top: 2px }']) {
        const at = await addStyle(t, css, '<p class="sv sw">x</p>');
        const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, `${at} p`) });
        const rules = res.matchedCSSRules?.map(m => m.rule) ?? [];
        const sv = rules.findLast(r => r.selectorList.text === '.sv');
        const sw = rules.findLast(r => r.selectorList.text === '.sw');
        assert.ok(sv?.styleSheetId && sv.style.range && sw?.style.range);
        const got = await outcome(
          side.send('CSS.setStyleTexts', {
            edits: [
              { styleSheetId: sv.styleSheetId, range: sv.style.range, text: ' color: green; left: 10px ' },
              { styleSheetId: sv.styleSheetId, range: sw.style.range, text: second },
            ],
          })
        );
        out.push({ css, second, got, text: await text(side, sv.styleSheetId) });
      }
    return out;
  });
  assert.deepEqual(ours, chrome);
  for (const r of chrome) assert.match((r as { got: string }).got, /^Failed applying edit #1: /);
});

test('setStyleTexts: a range outside the text is told before any edit; the text made shorter; two sheets', async () => {
  const css = '.sv { color: red; top: 1px; left: 2px }\n.sw { top: 0 }\n';
  const [ours, chrome] = await each(async (side, t) => {
    let made = 0;
    const sheetOf = async () => {
      // Each text its own: Chrome shares the rules of <style> elements of the same text.
      const at = await addStyle(t, `${css}/* ${++made} */\n`, '<p class="sv sw">x</p>');
      const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, `${at} p`) });
      const rules = res.matchedCSSRules?.map(m => m.rule) ?? [];
      const sv = rules.findLast(r => r.selectorList.text === '.sv');
      const sw = rules.findLast(r => r.selectorList.text === '.sw');
      assert.ok(sv?.styleSheetId && sv.style.range && sw?.style.range);
      return { id: sv.styleSheetId, sv: sv.style.range, sw: sw.style.range };
    };
    const outside = { startLine: 5, startColumn: 0, endLine: 5, endColumn: 1 };
    const out: unknown[] = [];
    const run = async (name: string, edits: Protocol.CSS.StyleDeclarationEdit[], ids: string[]) => {
      const got = await outcome(side.send('CSS.setStyleTexts', { edits }));
      out.push({ name, got, texts: await Promise.all(ids.map(id => text(side, id))) });
    };
    for (const [name, first] of [
      ['no style at the first range', (a: Awaited<ReturnType<typeof sheetOf>>) => ({ ...a.sv, startColumn: 4 })],
      ['the first fine', (a: Awaited<ReturnType<typeof sheetOf>>) => a.sv],
    ] as const) {
      const a = await sheetOf();
      await run(
        `outside, after ${name}`,
        [
          { styleSheetId: a.id, range: first(a), text: ' color: blue ' },
          { styleSheetId: a.id, range: outside, text: 'top: 1px' },
        ],
        [a.id]
      );
    }
    {
      // `.sw`'s range from before: past the end of the text once `.sv`'s style is empty.
      const a = await sheetOf();
      const pastEnd = { ...a.sw, endColumn: a.sw.endColumn + 1 };
      await run(
        'shorter, then past its end',
        [
          { styleSheetId: a.id, range: a.sv, text: '' },
          { styleSheetId: a.id, range: pastEnd, text: ' top: 9px ' },
        ],
        [a.id]
      );
    }
    {
      const [a, b] = [await sheetOf(), await sheetOf()];
      await run(
        'two sheets',
        [
          { styleSheetId: a.id, range: a.sv, text: ' color: blue; left: 100px; top: 2px ' },
          { styleSheetId: b.id, range: b.sw, text: ' top: 9px ' },
        ],
        [a.id, b.id]
      );
    }
    return out;
  });
  assert.deepEqual(ours, chrome);
  const got = chrome.map(r => (r as { got: string }).got);
  assert.deepEqual(got.slice(0, 2), ['Specified range is out of bounds', 'Specified range is out of bounds']);
  assert.match(got[2] as string, /^Failed applying edit #1: /);
  assert.equal(got[3], 'ok');
});

test('setStyleTexts: a sheet and an element in one call, in either order, a refused one taking back the other', async () => {
  const [ours, chrome] = await each(async (side, t) => {
    const out: unknown[] = [];
    let made = 0;
    for (const sheetFirst of [true, false])
      for (const elementText of [' top: 3px; left: 1px ', ' top: 3px }']) {
        // Each text its own: Chrome shares the rules of <style> elements of the same text.
        const at = await addStyle(t, `${STYLED}/* ${++made} */\n`, '<p class="sv" style="top: 1px">x</p>');
        const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, `${at} p`) });
        const sv = res.matchedCSSRules?.map(m => m.rule).findLast(r => r.selectorList.text === '.sv');
        const inline = res.inlineStyle;
        assert.ok(sv?.styleSheetId && sv.style.range && inline?.styleSheetId && inline.range);
        const sheetEdit = { styleSheetId: sv.styleSheetId, range: sv.style.range, text: ' color: green; left: 10px ' };
        const elementEdit = { styleSheetId: inline.styleSheetId, range: inline.range, text: elementText };
        const got = await outcome(
          side.send('CSS.setStyleTexts', { edits: sheetFirst ? [sheetEdit, elementEdit] : [elementEdit, sheetEdit] })
        );
        const attribute = await t.page.evaluate(at => document.querySelector(`${at} p`)?.getAttribute('style'), at);
        out.push({ sheetFirst, elementText, got, text: await text(side, sv.styleSheetId), attribute });
      }
    return out;
  });
  assert.deepEqual(ours, chrome);
  const got = chrome.map(r => (r as { got: string }).got);
  assert.deepEqual(got, [
    'ok',
    'Failed applying edit #1: SyntaxError Style text is not valid.',
    'ok',
    'Failed applying edit #0: SyntaxError Style text is not valid.',
  ]);
});
