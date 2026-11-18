// `isMutable` in style sheet headers. As in Chrome (StyleSheetContents::IsMutable(), set by
// CSSStyleSheet::WillMutateRules): constructed sheets are mutable from the start; the others,
// inspector sheets included, once their rules were changed through the CSSOM, by the page or by
// an edit of a session, and from then on. An @import's sheet counts on its own. A <style> whose
// text changes gets a new, immutable sheet. Writes the browser drops without a change (a name no
// property has, a bad priority, a rule it cannot parse, an index out of range) count for
// nothing and are not told. Only the next styleSheetAdded (enabling again) tells the new value:
// styleSheetChanged has no header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { readFile } from 'node:fs/promises';
import type { Page } from 'puppeteer-core';
import { PROBE_BUNDLE, launch, openPage, setUpAndTearDown } from '../../../../../../test-support/conformance.ts';
import type { Env, EventName, EventParams, Side, TestPage } from '../../../../../../test-support/conformance.ts';

let env: Env | undefined;

setUpAndTearDown(
  async () => {
    env = await launch();
  },
  () => env?.close()
);

type Mutable = Record<string, boolean>;

/** Runs `body` on a page with no sheets but those `setUp` adds, closing it afterwards. */
async function withPage(
  setUp: () => Promise<void>,
  body: (t: TestPage) => Promise<void>,
  beforeGoto?: (page: Page) => Promise<unknown>
): Promise<void> {
  if (!env) throw new Error('no browser');
  const t = await openPage(env, ['CSS.styleSheetAdded', 'CSS.styleSheetChanged', 'CSS.styleSheetRemoved'], beforeGoto);
  try {
    await t.page.evaluate(() => document.querySelectorAll('style, link[rel=stylesheet]').forEach(e => e.remove()));
    await t.page.evaluate(setUp);
    for (const side of [t.chrome, t.ours]) await side.send('DOM.enable');
    await body(t);
  } finally {
    await t.page.close();
  }
}

/**
 * Waits until `side` has told `count` events `method` since it was last cleared, then makes sure
 * no more come: one more command's round trip and a quiet moment.
 */
async function waitFor<E extends EventName>(side: Side, method: E, count: number): Promise<EventParams<E>[]> {
  const start = Date.now();
  while ((await side.events(method)).length < count) {
    if (Date.now() - start > 5000) throw new Error(`${(await side.events(method)).length} of ${count} ${method}`);
    await new Promise(r => setTimeout(r, 20));
  }
  // Settled: the same count after two more round trips, a moment apart each.
  for (let i = 0; i < 2; i++) {
    await side.send('DOM.getDocument', { depth: 0 });
    await new Promise(r => setTimeout(r, 125));
    const events = await side.events(method);
    assert.equal(events.length, count, `${method}: ${JSON.stringify(events)}`);
  }
  return side.events(method);
}

/** The events of the page's last change on both sides, which must be exactly `count` each. */
async function both<E extends EventName>(t: TestPage, method: E, count: number) {
  return { chrome: await waitFor(t.chrome, method, count), ours: await waitFor(t.ours, method, count) };
}

/**
 * What a header is about: the query of its file (`<link>`s and @imports), the first class of a
 * constructed sheet, the id of its owner node, or `ours-inspector` for our inspector sheet, a
 * <style> to Chrome.
 */
async function label(side: Side, h: Protocol.CSS.CSSStyleSheetHeader): Promise<string> {
  if (h.origin === 'inspector') return 'inspector';
  const query = /\?([\w-]+)/.exec(h.sourceURL);
  if (query?.[1]) return query[1];
  if (h.isConstructed) {
    const { text } = await side.send('CSS.getStyleSheetText', { styleSheetId: h.styleSheetId });
    return /\.(c-[\w-]+)/.exec(text)?.[1] ?? '?';
  }
  if (h.ownerNode === undefined) return '?';
  const { node } = await side.send('DOM.describeNode', { backendNodeId: h.ownerNode });
  const attrs = node.attributes ?? [];
  if (attrs.includes('data-devtools-anywhere')) return 'ours-inspector';
  const at = attrs.indexOf('id');
  return (at < 0 ? undefined : attrs[at + 1]) ?? '?';
}

/** `isMutable` of every sheet, as enabling the CSS domain (again) tells, and the ids, by `label`. */
async function mutable(side: Side, count: number): Promise<{ values: Mutable; ids: Map<string, string> }> {
  await side.send('CSS.disable');
  await side.clear();
  await side.send('CSS.enable');
  const values: Mutable = {};
  const ids = new Map<string, string>();
  for (const { header } of await waitFor(side, 'CSS.styleSheetAdded', count)) {
    const key = await label(side, header);
    assert.equal(ids.has(key), false, `two sheets labelled ${key}`);
    values[key] = header.isMutable;
    ids.set(key, header.styleSheetId);
  }
  await side.clear();
  return { values, ids };
}

/** Chrome's values must be `expected`, and ours Chrome's. */
async function compare(t: TestPage, count: number, expected: Mutable, message: string) {
  const chrome = await mutable(t.chrome, count);
  assert.deepEqual(chrome.values, expected, `chrome: ${message}`);
  assert.deepEqual((await mutable(t.ours, count)).values, chrome.values, `ours: ${message}`);
}

function idOf(ids: Map<string, string>, key: string): string {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`no sheet labelled ${key}`);
  return id;
}

/** Set on the page by `setUpSheets`: the sheet labelled so. */
declare const sheetOf: (key: string) => CSSStyleSheet;

/** The style rules of a <style> in `setUpSheets`: `.a`, @media, @keyframes, nesting `.p { .b }`. */
const STYLE_TEXT =
  '.a { color: red; } @media screen { .m { color: red; } } @keyframes k { from { color: red; } } .p { .b { color: red; } }';

/** Labels a page step and the sheet it changes. */
type Step = [target: string, fn: () => unknown];

/** Changes: each makes its sheet mutable and is told. */
const STEPS: Step[] = [
  ['ins', () => sheetOf('ins').insertRule('.z { color: red; }', 0)],
  ['del', () => sheetOf('del').deleteRule(0)],
  ['prop', () => (sheetOf('prop').cssRules[0] as CSSStyleRule).style.setProperty('color', 'green')],
  ['prop-upper', () => (sheetOf('prop-upper').cssRules[0] as CSSStyleRule).style.setProperty('COLOR', 'green')],
  ['prio', () => (sheetOf('prio').cssRules[0] as CSSStyleRule).style.setProperty('color', 'green', 'IMPORTANT')],
  ['remove', () => (sheetOf('remove').cssRules[0] as CSSStyleRule).style.removeProperty('color')],
  // A property the rule does not have: mutable all the same.
  ['remove-absent', () => (sheetOf('remove-absent').cssRules[0] as CSSStyleRule).style.removeProperty('margin')],
  ['named', () => ((sheetOf('named').cssRules[0] as CSSStyleRule).style.color = 'green')],
  // `rule.style = …` forwards to the style's cssText.
  ['put-forwards', () => ((sheetOf('put-forwards').cssRules[0] as unknown as { style: string }).style = 'color: blue')],
  ['sel', () => ((sheetOf('sel').cssRules[0] as CSSStyleRule).selectorText = '.x')],
  // Rejected selector: mutable all the same.
  ['sel-bad', () => ((sheetOf('sel-bad').cssRules[0] as CSSStyleRule).selectorText = '!!!')],
  // Rejected key, which throws: mutable all the same.
  [
    'key-bad',
    () => {
      try {
        ((sheetOf('key-bad').cssRules[2] as CSSKeyframesRule).cssRules[0] as CSSKeyframeRule).keyText = 'nope';
      } catch {
        // SyntaxError.
      }
    },
  ],
  ['media-ins', () => (sheetOf('media-ins').cssRules[1] as CSSMediaRule).insertRule('.n {}', 0)],
  ['kf-append', () => (sheetOf('kf-append').cssRules[2] as CSSKeyframesRule).appendRule('50% { color: blue; }')],
  ['nest-ins', () => (sheetOf('nest-ins').cssRules[3] as CSSStyleRule).insertRule('.q {}', 0)],
  [
    'nest-prop',
    () =>
      ((sheetOf('nest-prop').cssRules[3] as CSSStyleRule).cssRules[0] as CSSStyleRule).style.setProperty(
        'color',
        'green'
      ),
  ],
  ['l-ins', () => sheetOf('l-ins').insertRule('.z {}', 0)],
  ['l-del', () => sheetOf('l-del').deleteRule(0)],
  ['l-prop', () => (sheetOf('l-prop').cssRules[0] as CSSStyleRule).style.setProperty('color', 'red')],
  ['l-named', () => ((sheetOf('l-named').cssRules[0] as CSSStyleRule).style.color = 'red')],
  // The @import's sheet alone: the sheet with the @import is unchanged.
  ['i-ins', () => sheetOf('i-ins').insertRule('.z {}', 0)],
  ['i-del', () => sheetOf('i-del').deleteRule(0)],
  ['i-prop', () => (sheetOf('i-prop').cssRules[0] as CSSStyleRule).style.setProperty('color', 'red')],
  ['i-named', () => ((sheetOf('i-named').cssRules[0] as CSSStyleRule).style.color = 'red')],
  ['c-ins', () => sheetOf('c-ins').insertRule('.z {}', 0)],
  ['c-del', () => sheetOf('c-del').deleteRule(1)],
  ['c-replace-sync', () => sheetOf('c-replace-sync').replaceSync('.c-replace-sync { color: blue; }')],
  ['c-replace', () => sheetOf('c-replace').replace('.c-replace { color: blue; }')],
];

/** Writes that change nothing: not mutable, not told. */
const NO_CHANGE: Step[] = [
  // A rule's cssText sets nothing.
  ['csstext', () => ((sheetOf('csstext').cssRules[0] as CSSStyleRule).cssText = '.q { color: blue; }')],
  ['prop-unknown', () => (sheetOf('prop-unknown').cssRules[0] as CSSStyleRule).style.setProperty('no-such', '1')],
  // Names are taken as written: not trimmed, not unescaped.
  ['prop-spaces', () => (sheetOf('prop-spaces').cssRules[0] as CSSStyleRule).style.setProperty(' color ', 'green')],
  ['prop-escaped', () => (sheetOf('prop-escaped').cssRules[0] as CSSStyleRule).style.setProperty('col\\or', 'green')],
  ['prio-bad', () => (sheetOf('prio-bad').cssRules[0] as CSSStyleRule).style.setProperty('color', 'green', 'foo')],
  ['remove-unknown', () => (sheetOf('remove-unknown').cssRules[0] as CSSStyleRule).style.removeProperty('no-such')],
  [
    'ins-bad',
    () => {
      try {
        sheetOf('ins-bad').insertRule('!!!', 0);
      } catch {
        // SyntaxError.
      }
    },
  ],
  [
    'del-out',
    () => {
      try {
        sheetOf('del-out').deleteRule(99);
      } catch {
        // IndexSizeError.
      }
    },
  ],
  // The sheet's own media list changes no rule: its text stays, and it is neither mutable nor told.
  ['media', () => (sheetOf('media').media.mediaText = 'print')],
  ['media-append', () => sheetOf('media-append').media.appendMedium('print')],
];

const STYLES = [...STEPS.map(([k]) => k).filter(k => !/^[lic]-/.test(k)), ...NO_CHANGE.map(([k]) => k), 'plain'];
const LINKS = ['l-ins', 'l-del', 'l-prop', 'l-named'];
const IMPORTS = ['i-ins', 'i-del', 'i-prop', 'i-named'];
const CONSTRUCTED = ['c-ins', 'c-del', 'c-replace', 'c-replace-sync', 'c-plain'];
const SHEETS = STYLES.length + LINKS.length + 1 + IMPORTS.length + CONSTRUCTED.length;

/** Waits for each @import of a sheet to load, then names their sheets by the query of the file. */
async function importsOf(sheet: CSSStyleSheet | null | undefined): Promise<Map<string, CSSStyleSheet>> {
  const out = new Map<string, CSSStyleSheet>();
  for (const rule of Array.from(sheet?.cssRules ?? [])) {
    const start = Date.now();
    let imported = (rule as CSSImportRule).styleSheet;
    while (!imported?.cssRules.length) {
      if (Date.now() - start > 5000) throw new Error(`${(rule as CSSImportRule).href} not loaded`);
      await new Promise(r => setTimeout(r, 10));
      imported = (rule as CSSImportRule).styleSheet;
    }
    out.set(/\?([\w-]+)/.exec((rule as CSSImportRule).href)?.[1] ?? '', imported);
  }
  return out;
}

/** <link>s to the same file, `?query` each, once loaded. */
const linked = (queries: string[]) =>
  Promise.all(
    queries.map(
      q =>
        new Promise((resolve, reject) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = `assets/frame.css?${q}`;
          const timer = setTimeout(() => reject(new Error(`${link.href} not loaded`)), 5000);
          link.onload = () => resolve(clearTimeout(timer));
          link.onerror = () => reject(new Error(`${link.href} failed`));
          document.head.append(link);
        })
    )
  );

async function setUpSheets(styles: string[], text: string, links: string[], imports: string[], made: string[]) {
  const add = (id: string, css: string) => {
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.append(style);
    return style;
  };
  for (const id of styles) add(id, text);
  const imp = add('imp', imports.map(q => `@import url(assets/frame.css?${q});`).join('\n'));
  await linked(links);
  const constructed = made.map(name => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`.${name} { color: red; } .b { color: red; }`);
    return [name, sheet] as const;
  });
  document.adoptedStyleSheets = constructed.map(([, sheet]) => sheet);
  const byName = new Map<string, CSSStyleSheet>([...constructed, ...(await importsOf(imp.sheet))]);
  for (const sheet of Array.from(document.styleSheets)) {
    const query = sheet.href && /\?(l-[\w-]+)/.exec(sheet.href)?.[1];
    if (query) byName.set(query, sheet);
  }
  Object.assign(window, {
    sheetOf: (key: string) => {
      const sheet = byName.get(key) ?? (document.getElementById(key) as HTMLStyleElement | null)?.sheet;
      if (!sheet) throw new Error(`no sheet ${key}`);
      return sheet;
    },
  });
}
// The page runs `setUpSheets` from its source: the helpers it calls must be there too.
const SET_UP = `${importsOf.toString()}\nconst linked = ${linked.toString()};\n(${setUpSheets.toString()})`;

/** Runs `body` on a page set up by `setUpSheets`. */
function withSheets(
  sheets: { styles: string[]; links: string[]; imports: string[]; constructed: string[] },
  body: (t: TestPage) => Promise<void>
) {
  return withPage(
    async () => {},
    async t => {
      await t.page.evaluate(
        `${SET_UP}(${JSON.stringify(sheets.styles)}, ${JSON.stringify(STYLE_TEXT)}, ${JSON.stringify(sheets.links)}, ${JSON.stringify(sheets.imports)}, ${JSON.stringify(sheets.constructed)})`
      );
      await body(t);
    }
  );
}

const initial: Mutable = {
  ...Object.fromEntries([...STYLES, ...LINKS, 'imp', ...IMPORTS].map(k => [k, false])),
  ...Object.fromEntries(CONSTRUCTED.map(k => [k, true])),
};

test('isMutable: true for constructed sheets, false for others until the page changes their rules', () =>
  withSheets({ styles: STYLES, links: LINKS, imports: IMPORTS, constructed: CONSTRUCTED }, async t => {
    const ids = { chrome: new Map<string, string>(), ours: new Map<string, string>() };
    for (const name of ['chrome', 'ours'] as const) {
      await t[name].send('CSS.enable');
      ids[name] = (await mutable(t[name], SHEETS)).ids;
    }
    await compare(t, SHEETS, initial, 'initial');

    let expected = initial;
    for (const [target, fn] of STEPS) {
      await t.page.evaluate(fn);
      // A property written by name is seen when the text is next used.
      await t.ours.send('CSS.getStyleSheetText', { styleSheetId: idOf(ids.ours, target) });
      // Told changed, with no new header.
      const changed = await both(t, 'CSS.styleSheetChanged', 1);
      assert.deepEqual(changed.chrome, [{ styleSheetId: idOf(ids.chrome, target) }], target);
      assert.deepEqual(changed.ours, [{ styleSheetId: idOf(ids.ours, target) }], target);
      for (const side of [t.chrome, t.ours]) {
        assert.deepEqual(await side.events('CSS.styleSheetAdded'), [], target);
        assert.deepEqual(await side.events('CSS.styleSheetRemoved'), [], target);
      }
      expected = { ...expected, [target]: true };
      await compare(t, SHEETS, expected, target);
    }

    for (const [target, fn] of NO_CHANGE) {
      await t.page.evaluate(fn);
      for (const [name, side] of [
        ['chrome', t.chrome],
        ['ours', t.ours],
      ] as const)
        await side.send('CSS.getStyleSheetText', { styleSheetId: idOf(ids[name], target) });
      await both(t, 'CSS.styleSheetChanged', 0);
      await compare(t, SHEETS, expected, target);
    }

    // New text for a <style> the page changed: a new sheet, not mutable.
    await t.page.evaluate(() => {
      (sheetOf('ins').ownerNode as HTMLStyleElement).textContent = '.q { color: red; }';
    });
    const removed = await both(t, 'CSS.styleSheetRemoved', 1);
    const added = await both(t, 'CSS.styleSheetAdded', 1);
    for (const name of ['chrome', 'ours'] as const) {
      assert.deepEqual(removed[name], [{ styleSheetId: idOf(ids[name], 'ins') }], name);
      assert.equal(added[name][0]?.header.isMutable, false, name);
      assert.deepEqual(await t[name].events('CSS.styleSheetChanged'), [], name);
    }
    await compare(t, SHEETS, { ...expected, ins: false }, 'new text');
  }));

test('isMutable: a property written by name and not read again counts once CSS is enabled again', () =>
  withSheets({ styles: ['named'], links: ['l-named'], imports: ['i-named'], constructed: [] }, async t => {
    for (const side of [t.chrome, t.ours]) await side.send('CSS.enable');
    await t.page.evaluate(() => {
      for (const key of ['named', 'l-named', 'i-named'])
        (sheetOf(key).cssRules[0] as CSSStyleRule).style.color = 'green';
    });
    // Straight to disable and enable: nothing read the texts in between.
    await compare(t, 4, { named: true, 'l-named': true, imp: false, 'i-named': true }, 'by name');
  }));

test("isMutable: names are checked with the CSS.supports the probe took, not the page's", () =>
  withPage(
    async () => {
      for (const id of ['unknown', 'known', 'empty']) {
        const style = document.createElement('style');
        style.id = id;
        style.textContent = '.a { color: red; }';
        document.head.append(style);
      }
    },
    async t => {
      for (const side of [t.chrome, t.ours]) await side.send('CSS.enable');
      // Other code of the bundle calls the page's CSS.supports when it loads (the panel's
      // viewport units): only the calls from here on, the writes below, are counted. Calls made
      // during and before CSS.enable are left out, whoever made them.
      const count = () => t.page.evaluate(() => (window as unknown as { supportsCalls: number }).supportsCalls);
      const before = await count();
      await t.page.evaluate(() => {
        const rule = (id: string) =>
          (document.getElementById(id) as HTMLStyleElement).sheet?.cssRules[0] as CSSStyleRule;
        rule('unknown').style.setProperty('no-such-name', '1');
        rule('known').style.setProperty('margin-left', '1px');
        // Not a custom property's name.
        rule('empty').style.setProperty('--', 'x');
      });
      await compare(t, 3, { unknown: false, known: true, empty: false }, 'replaced CSS');
      assert.equal(await count(), before);
    },
    // The probe first, as a page's first script, then the page's code replacing CSS.supports and
    // CSS before the CDP bundle loads (after the fixture): only the probe's copy is native.
    async page => {
      await page.evaluateOnNewDocument(await readFile(PROBE_BUNDLE, 'utf8'));
      await page.evaluateOnNewDocument(() => {
        const own = window as unknown as { supportsCalls: number };
        own.supportsCalls = 0;
        const fake = () => {
          own.supportsCalls++;
          return true;
        };
        CSS.supports = fake;
        Object.defineProperty(window, 'CSS', { configurable: true, value: { supports: fake } });
      });
    }
  ));

test('isMutable: names past the 1024 kept still count right', () =>
  withSheets({ styles: ['flood', 'known', 'unknown'], links: [], imports: [], constructed: [] }, async t => {
    for (const side of [t.chrome, t.ours]) await side.send('CSS.enable');
    await t.page.evaluate(() => {
      const style = (sheetOf('flood').cssRules[0] as CSSStyleRule).style;
      for (let i = 0; i < 1100; i++) style.setProperty(`no-such-${i}`, '1');
      (sheetOf('known').cssRules[0] as CSSStyleRule).style.setProperty('padding-left', '1px');
      (sheetOf('unknown').cssRules[0] as CSSStyleRule).style.setProperty('no-such-last', '1');
    });
    await compare(t, 4, { flood: false, known: true, unknown: false, imp: false }, 'many names');
  }));

/** Writes through the style of other kinds of rules, with whether Chrome counts each. */
const RULE_KINDS: [label: string, text: string, write: string, counts: boolean][] = (() => {
  const face = '@font-face { font-family: f; src: local(f); }';
  const page = '@page { margin: 1cm; @top-left { content: "x"; } }';
  const tryRule = '@position-try --t { top: 1px; }';
  const style = '.a { color: red; }';
  return [
    // Descriptors and properties alike, in any rule; names neither is, nowhere. A value the
    // descriptor rejects (`nope`) counts as a valid one would.
    ['ff-src', face, `r.style.setProperty('src', 'nope')`, true],
    ['ff-range', face, `r.style.setProperty('unicode-range', 'U+0-7F')`, true],
    ['ff-remove-src', face, `r.style.removeProperty('src')`, true],
    ['ff-color', face, `r.style.setProperty('color', 'red')`, true],
    ['ff-foo', face, `r.style.setProperty('foo', 'x')`, false],
    ['ff-remove-foo', face, `r.style.removeProperty('foo')`, false],
    // `size` is a property too: known through CSS.supports(), not the descriptors' list.
    ['page-size', page, `r.style.setProperty('size', 'A4')`, true],
    ['page-src', page, `r.style.setProperty('src', 'nope')`, true],
    ['page-color', page, `r.style.setProperty('color', 'red')`, true],
    ['page-foo', page, `r.style.setProperty('foo', 'x')`, false],
    ['page-remove-foo', page, `r.style.removeProperty('foo')`, false],
    // A margin rule's sheet is its @page's: styleSheetChanged names that sheet.
    ['margin-color', page, `r.cssRules[0].style.setProperty('color', 'red')`, true],
    ['margin-foo', page, `r.cssRules[0].style.setProperty('foo', 'x')`, false],
    ['margin-remove-foo', page, `r.cssRules[0].style.removeProperty('foo')`, false],
    ['style-src', style, `r.style.setProperty('src', 'nope')`, true],
    ['style-syntax', style, `r.style.setProperty('syntax', '"*"')`, true],
    ['style-types', style, `r.style.setProperty('types', 'x')`, true],
    ['style-navigation', style, `r.style.setProperty('navigation', 'auto')`, true],
    ['style-range', style, `r.style.setProperty('range', 'auto')`, true],
    // Not descriptors to Chrome.
    ['style-marks', style, `r.style.setProperty('marks', 'crop')`, false],
    ['style-bleed', style, `r.style.setProperty('bleed', '1px')`, false],
    // @position-try: setProperty() of the properties it takes only; removeProperty() of any.
    ['try-left', tryRule, `r.style.setProperty('left', '1px')`, true],
    ['try-margin', tryRule, `r.style.setProperty('MARGIN-LEFT', '1px')`, true],
    ['try-area', tryRule, `r.style.setProperty('position-area', 'top')`, true],
    ['try-bad-value', tryRule, `r.style.setProperty('left', 'nope')`, true],
    ['try-color', tryRule, `r.style.setProperty('color', 'red')`, false],
    ['try-display', tryRule, `r.style.setProperty('display', 'block')`, false],
    ['try-custom', tryRule, `r.style.setProperty('--x', '1')`, false],
    ['try-src', tryRule, `r.style.setProperty('src', 'nope')`, false],
    ['try-foo', tryRule, `r.style.setProperty('foo', 'x')`, false],
    ['try-remove-color', tryRule, `r.style.removeProperty('color')`, true],
    ['try-remove-src', tryRule, `r.style.removeProperty('src')`, true],
    ['try-remove-foo', tryRule, `r.style.removeProperty('foo')`, false],
  ];
})();

test('isMutable: writes through the style of @font-face, @page, margin and @position-try rules', () =>
  withPage(
    async () => {},
    async t => {
      await t.page.evaluate(
        (kinds: [string, string][]) => {
          for (const [id, css] of kinds) {
            const style = document.createElement('style');
            style.id = id;
            style.textContent = css;
            document.head.append(style);
          }
        },
        RULE_KINDS.map(([id, css]) => [id, css] as [string, string])
      );
      const count = RULE_KINDS.length;
      const ids = { chrome: new Map<string, string>(), ours: new Map<string, string>() };
      for (const name of ['chrome', 'ours'] as const) {
        await t[name].send('CSS.enable');
        ids[name] = (await mutable(t[name], count)).ids;
      }
      let expected: Mutable = Object.fromEntries(RULE_KINDS.map(([id]) => [id, false]));
      for (const [target, , write, counts] of RULE_KINDS) {
        await t.page.evaluate(
          `(() => { const r = document.getElementById(${JSON.stringify(target)}).sheet.cssRules[0]; ${write}; })()`
        );
        // No rule.style read before (that would be seen when compared): the write's own hook.
        const changed = await both(t, 'CSS.styleSheetChanged', counts ? 1 : 0);
        if (counts) {
          assert.deepEqual(changed.chrome, [{ styleSheetId: idOf(ids.chrome, target) }], target);
          assert.deepEqual(changed.ours, [{ styleSheetId: idOf(ids.ours, target) }], target);
          expected = { ...expected, [target]: true };
        }
        for (const side of [t.chrome, t.ours]) await side.clear();
      }
      await compare(t, count, expected, 'rule kinds');
    }
  ));

/** More rules than the 2048 watched (SUSPECTS_LIMIT in cssom-watch.ts). */
const manyRules = async () => {
  const style = document.createElement('style');
  style.id = 'many';
  style.textContent = Array.from({ length: 2100 }, (_, i) => `.r${i} { color: red; }`).join('\n');
  document.head.append(style);
};

test('isMutable: reading the styles of more rules than are watched does not count', () =>
  withPage(manyRules, async t => {
    const ids = { chrome: new Map<string, string>(), ours: new Map<string, string>() };
    for (const name of ['chrome', 'ours'] as const) {
      await t[name].send('CSS.enable');
      ids[name] = (await mutable(t[name], 1)).ids;
    }
    await t.page.evaluate(() => {
      const rules = (document.getElementById('many') as HTMLStyleElement).sheet?.cssRules ?? [];
      for (const rule of Array.from(rules)) void (rule as CSSStyleRule).style;
    });
    for (const [name, side] of [
      ['chrome', t.chrome],
      ['ours', t.ours],
    ] as const)
      await side.send('CSS.getStyleSheetText', { styleSheetId: idOf(ids[name], 'many') });
    // Past the limit, ours gives up watching them: the text is serialized anew (one
    // styleSheetChanged, which Chrome does not send) but the sheet is not taken as mutated.
    assert.deepEqual(await waitFor(t.chrome, 'CSS.styleSheetChanged', 0), []);
    assert.deepEqual(await waitFor(t.ours, 'CSS.styleSheetChanged', 1), [{ styleSheetId: idOf(ids.ours, 'many') }]);
    await compare(t, 1, { many: false }, 'read only');
  }));

test(
  'isMutable: a write through a style taken before ours gave up watching',
  { todo: 'unseen once more rules than are watched were taken (docs/limitations.md)' },
  () =>
    withPage(manyRules, async t => {
      for (const side of [t.chrome, t.ours]) await side.send('CSS.enable');
      await t.page.evaluate(() => {
        const rules = Array.from((document.getElementById('many') as HTMLStyleElement).sheet?.cssRules ?? []);
        const kept = (rules[0] as CSSStyleRule).style;
        for (const rule of rules) void (rule as CSSStyleRule).style;
        kept.color = 'green';
      });
      await compare(t, 1, { many: true }, 'written after giving up');
    })
);

test(
  'isMutable: a change the page made while CSS was disabled',
  { todo: 'unseen: the CSSOM is hooked only while CSS is enabled (docs/limitations.md)' },
  () =>
    withSheets({ styles: ['disabled'], links: [], imports: [], constructed: [] }, async t => {
      for (const side of [t.chrome, t.ours]) {
        await side.send('CSS.enable');
        await side.send('CSS.disable');
      }
      await t.page.evaluate(() => sheetOf('disabled').insertRule('.z {}', 0));
      await compare(t, 2, { disabled: true, imp: false }, 'disabled');
    })
);

test(
  'isMutable: a property written by name with a value it rejects',
  { todo: 'unseen: the rule text compared stays the same (docs/limitations.md)' },
  () =>
    withSheets({ styles: ['named-bad'], links: [], imports: [], constructed: [] }, async t => {
      for (const side of [t.chrome, t.ours]) await side.send('CSS.enable');
      await t.page.evaluate(() => {
        (sheetOf('named-bad').cssRules[0] as CSSStyleRule).style.color = 'nope';
      });
      await compare(t, 2, { 'named-bad': true, imp: false }, 'rejected value');
    })
);

const EDITED = ['texts', 'text', 'rule', 'sel', 'media', 'key'];

test('isMutable: true once a session edits a sheet, inspector sheets included', () =>
  // Each side edits sheets of its own.
  withSheets(
    {
      styles: ['chrome', 'ours'].flatMap(s => EDITED.map(k => `${s}-${k}`)),
      links: ['l-chrome', 'l-ours'],
      imports: ['i-chrome', 'i-ours'],
      constructed: ['c-chrome', 'c-ours'],
    },
    async t => {
      // 12 <style>s, the one with the @imports, the two @imported, two <link>s, two constructed.
      const PAGE_SHEETS = 19;
      const at = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 };
      const line = (n: number, from: number, to: number) => ({
        startLine: n,
        startColumn: from,
        endLine: n,
        endColumn: to,
      });
      for (const name of ['chrome', 'ours'] as const) {
        const side = t[name];
        await side.send('CSS.enable');
        await waitFor(side, 'CSS.styleSheetAdded', PAGE_SHEETS);
        await side.clear();
        const { frameTree } = await side.send('Page.getFrameTree');
        const { styleSheetId: inspector } = await side.send('CSS.createStyleSheet', { frameId: frameTree.frame.id });
        // Like Chrome, an inspector sheet is told immutable when made, and stays so until edited.
        const [created] = await waitFor(side, 'CSS.styleSheetAdded', 1);
        assert.equal(created?.header.styleSheetId, inspector, name);
        assert.equal(created?.header.isMutable, false, name);
        const { values, ids } = await mutable(side, PAGE_SHEETS + 1);
        assert.equal(values['inspector'], false, name);

        /** Runs an edit, then checks the sheet's text holds `expected`. */
        const edit = async (styleSheetId: string, run: () => Promise<unknown>, expected: string) => {
          await run();
          const { text } = await side.send('CSS.getStyleSheetText', { styleSheetId });
          assert.ok(text.includes(expected), `${name}: ${JSON.stringify(text)} lacks ${expected}`);
        };
        const own = (kind: string) => idOf(ids, `${name}-${kind}`);
        // <style>s have STYLE_TEXT on one line: `.a { color: red; } @media screen {` …
        const mediaAt = STYLE_TEXT.indexOf('screen');
        const keyAt = STYLE_TEXT.indexOf('from');
        await edit(
          own('texts'),
          () =>
            side.send('CSS.setStyleTexts', {
              edits: [{ styleSheetId: own('texts'), range: line(0, 4, 17), text: ' color: pink; ' }],
            }),
          'pink'
        );
        await edit(
          own('text'),
          () => side.send('CSS.setStyleSheetText', { styleSheetId: own('text'), text: '.b { color: red; }' }),
          '.b'
        );
        await edit(
          own('rule'),
          () => side.send('CSS.addRule', { styleSheetId: own('rule'), ruleText: '.c {}', location: at }),
          '.c'
        );
        await edit(
          own('sel'),
          () => side.send('CSS.setRuleSelector', { styleSheetId: own('sel'), range: line(0, 0, 2), selector: '.y' }),
          '.y'
        );
        await edit(
          own('media'),
          () =>
            side.send('CSS.setMediaText', {
              styleSheetId: own('media'),
              range: line(0, mediaAt, mediaAt + 6),
              text: 'print',
            }),
          'print'
        );
        await edit(
          own('key'),
          () =>
            side.send('CSS.setKeyframeKey', {
              styleSheetId: own('key'),
              range: line(0, keyAt, keyAt + 4),
              keyText: 'to',
            }),
          'to {'
        );
        for (const key of [`l-${name}`, `i-${name}`, `c-${name}`])
          await edit(
            idOf(ids, key),
            () => side.send('CSS.addRule', { styleSheetId: idOf(ids, key), ruleText: '.c {}', location: at }),
            '.c'
          );
        await edit(
          inspector,
          () => side.send('CSS.addRule', { styleSheetId: inspector, ruleText: '.c {}', location: at }),
          '.c'
        );
      }

      const edited = ['chrome', 'ours'].flatMap(s => [...EDITED.map(k => `${s}-${k}`), `l-${s}`, `i-${s}`]);
      const expected: Mutable = {
        ...Object.fromEntries(edited.map(k => [k, true])),
        imp: false,
        'c-chrome': true,
        'c-ours': true,
        inspector: true,
      };
      // Chrome sees our edits, made through the CSSOM, and our inspector sheet, a <style>.
      const chrome = await mutable(t.chrome, PAGE_SHEETS + 2);
      assert.deepEqual(chrome.values, { ...expected, 'ours-inspector': true });
      // Ours, for every sheet Chrome's session did not edit, as Chrome.
      const ours = await mutable(t.ours, PAGE_SHEETS + 1);
      const byChrome = edited.filter(k => k.startsWith('chrome-') || k.endsWith('-chrome'));
      const rest = (values: Mutable) =>
        Object.fromEntries(Object.entries(values).filter(([k]) => !byChrome.includes(k) && k !== 'ours-inspector'));
      assert.deepEqual(rest(ours.values), rest(chrome.values));
      // Known difference: our hooks do not see Chrome's own session's edits, which do not go
      // through the page's CSSOM, so those sheets stay immutable for us. Only Chrome's session
      // edits them that way, which does not happen in use.
      assert.deepEqual(
        byChrome.map(k => ours.values[k]),
        byChrome.map(() => false)
      );
    }
  ));
