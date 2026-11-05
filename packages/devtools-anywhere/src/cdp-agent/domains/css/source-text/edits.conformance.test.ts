// Editing a sheet's text, compared with Chrome: each side edits a page of its own (both act on
// the page they are in). Edits change the text as written, leave a <style>'s textContent and id
// alone, and send no CSS.styleSheetChanged; changes the page makes through the CSSOM do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
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
    await new Promise(r => setTimeout(r, 100));
    const changed = (await side.events('CSS.styleSheetChanged')).map(e => e.styleSheetId === sheet);
    // A constructed sheet's text is the one replaceSync gets.
    await side.clear();
    await t.page.evaluate(() => {
      const c = new CSSStyleSheet();
      c.replaceSync('.x { color: red }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, c];
    });
    await new Promise(r => setTimeout(r, 100));
    const added = (await side.events('CSS.styleSheetAdded')).map(e => e.header.styleSheetId);
    const id = added[added.length - 1];
    assert.ok(id);
    await side.clear();
    await t.page.evaluate(() => document.adoptedStyleSheets.at(-1)?.replaceSync('/*c*/ .ctor { color: teal }'));
    await new Promise(r => setTimeout(r, 100));
    const replaced = (await side.events('CSS.styleSheetChanged')).map(e => e.styleSheetId === id);
    // Setting a <style>'s text makes another sheet, with another id.
    await side.clear();
    await t.page.evaluate(() => {
      const s = document.getElementById('edited');
      if (s) s.textContent = '.t1 { color: olive }';
    });
    await new Promise(r => setTimeout(r, 100));
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
