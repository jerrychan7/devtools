// `isMutable` in style sheet headers. As in Chrome (StyleSheetContents::IsMutable(), set by
// CSSStyleSheet::WillMutateRules): constructed sheets are mutable from the start; the others,
// inspector sheets included, once their rules were changed through the CSSOM, by the page or by
// an edit of a session, and from then on. An @import's sheet counts on its own. A <style> whose
// text changes gets a new, immutable sheet. Only the next styleSheetAdded (enabling again) tells
// the new value: styleSheetChanged has no header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown, waitForBoth } from '../../../../../../test-support/conformance.ts';
import type { Env, EventName, Side, TestPage } from '../../../../../../test-support/conformance.ts';

let env: Env | undefined;

setUpAndTearDown(
  async () => {
    env = await launch();
  },
  () => env?.close()
);

type Mutable = Record<string, boolean>;

/** A page with no sheets but those `setUp` adds. */
async function open(setUp: () => Promise<void>): Promise<TestPage> {
  if (!env) throw new Error('no browser');
  const t = await openPage(env, ['CSS.styleSheetAdded', 'CSS.styleSheetChanged', 'CSS.styleSheetRemoved']);
  await t.page.evaluate(() => document.querySelectorAll('style, link[rel=stylesheet]').forEach(e => e.remove()));
  await t.page.evaluate(setUp);
  for (const side of [t.chrome, t.ours]) await side.send('DOM.enable');
  return t;
}

/** Waits until `side` has told `count` events `method` since it was last cleared. */
async function waitFor<E extends EventName>(side: Side, method: E, count: number) {
  const start = Date.now();
  for (;;) {
    const events = await side.events(method);
    if (events.length >= count) return events;
    if (Date.now() - start > 5000) throw new Error(`${events.length} of ${count} ${method}`);
    await new Promise(r => setTimeout(r, 20));
  }
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

function idOf(ids: Map<string, string>, key: string): string {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`no sheet labelled ${key}`);
  return id;
}

/** Set on the page by `setUpSheets`: the sheet labelled so. */
declare const sheetOf: (key: string) => CSSStyleSheet;

const STYLES = [
  'ins',
  'del',
  'prop',
  'named',
  'sel',
  'sel-bad',
  'prop-unknown',
  'key-bad',
  'csstext',
  'media-ins',
  'kf-append',
  'plain',
] as const;
const LINKS = ['l-ins', 'l-del', 'l-prop', 'l-named'] as const;
const IMPORTS = ['i-ins', 'i-del', 'i-prop', 'i-named'] as const;
const CONSTRUCTED = ['c-ins', 'c-del', 'c-replace', 'c-replace-sync', 'c-plain'] as const;
const SHEETS = STYLES.length + LINKS.length + 1 + IMPORTS.length + CONSTRUCTED.length;

async function setUpSheets() {
  const add = (id: string, css: string) => {
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.append(style);
  };
  for (const id of [
    'ins',
    'del',
    'prop',
    'named',
    'sel',
    'sel-bad',
    'prop-unknown',
    'key-bad',
    'csstext',
    'media-ins',
    'kf-append',
    'plain',
  ])
    add(id, '.a { color: red; } @media screen { .m { color: red; } } @keyframes k { from { color: red; } }');
  const files = (prefix: string) => ['ins', 'del', 'prop', 'named'].map(k => `assets/frame.css?${prefix}-${k}`);
  add(
    'imp',
    files('i')
      .map(f => `@import url(${f});`)
      .join('\n')
  );
  await Promise.all(
    files('l').map(
      href =>
        new Promise(r => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          link.onload = r;
          document.head.append(link);
        })
    )
  );
  const constructed = ['c-ins', 'c-del', 'c-replace', 'c-replace-sync', 'c-plain'].map(name => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`.${name} { color: red; } .b { color: red; }`);
    return [name, sheet] as const;
  });
  document.adoptedStyleSheets = constructed.map(([, sheet]) => sheet);
  const byName = new Map<string, CSSStyleSheet>(constructed);
  const imp = (document.getElementById('imp') as HTMLStyleElement).sheet;
  for (const rule of Array.from(imp?.cssRules ?? [])) {
    const sheet = (rule as CSSImportRule).styleSheet;
    while (!sheet?.cssRules.length) await new Promise(r => setTimeout(r, 10));
    byName.set(/\?([\w-]+)/.exec((rule as CSSImportRule).href)?.[1] ?? '', sheet);
  }
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

/** A step of the page: what it does to the sheet labelled `target`. */
type Step = [target: string, fn: () => unknown];

const STEPS: Step[] = [
  ['ins', () => sheetOf('ins').insertRule('.z { color: red; }', 0)],
  ['del', () => sheetOf('del').deleteRule(0)],
  ['prop', () => (sheetOf('prop').cssRules[0] as CSSStyleRule).style.setProperty('color', 'green')],
  ['named', () => ((sheetOf('named').cssRules[0] as CSSStyleRule).style.color = 'green')],
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

const initial: Mutable = {
  ...Object.fromEntries([...STYLES, ...LINKS, 'imp', ...IMPORTS].map(k => [k, false])),
  ...Object.fromEntries(CONSTRUCTED.map(k => [k, true])),
};

test('isMutable: true for constructed sheets, false for others until the page changes their rules', async () => {
  const t = await open(setUpSheets);
  const ids = { chrome: new Map<string, string>(), ours: new Map<string, string>() };
  for (const name of ['chrome', 'ours'] as const) {
    await t[name].send('CSS.enable');
    const { values, ids: own } = await mutable(t[name], SHEETS);
    ids[name] = own;
    assert.deepEqual(values, initial, name);
  }

  let expected = initial;
  for (const [target, fn] of STEPS) {
    await t.page.evaluate(fn);
    // A property written by name is seen when the text is next used.
    await t.ours.send('CSS.getStyleSheetText', { styleSheetId: idOf(ids.ours, target) });
    const [ours, chrome] = await waitForBoth(t, 'CSS.styleSheetChanged');
    // Told changed, with no new header.
    assert.deepEqual(chrome, [{ styleSheetId: idOf(ids.chrome, target) }], target);
    assert.deepEqual(ours, [{ styleSheetId: idOf(ids.ours, target) }], target);
    for (const side of [t.chrome, t.ours]) {
      assert.deepEqual(await side.events('CSS.styleSheetAdded'), [], target);
      assert.deepEqual(await side.events('CSS.styleSheetRemoved'), [], target);
    }
    expected = { ...expected, [target]: true };
    const chromeNow = await mutable(t.chrome, SHEETS);
    assert.deepEqual(chromeNow.values, expected, target);
    assert.deepEqual((await mutable(t.ours, SHEETS)).values, chromeNow.values, target);
  }

  // Not changed: a rule's cssText sets nothing, nor does setProperty() of no property.
  await t.page.evaluate(() => {
    (sheetOf('csstext').cssRules[0] as CSSStyleRule).cssText = '.q { color: blue; }';
    (sheetOf('prop-unknown').cssRules[0] as CSSStyleRule).style.setProperty('no-such-property', '1');
  });
  const chromeNow = await mutable(t.chrome, SHEETS);
  assert.deepEqual(chromeNow.values, expected, 'no change');
  assert.deepEqual((await mutable(t.ours, SHEETS)).values, chromeNow.values, 'no change');

  // New text for a <style> the page changed: a new sheet, not mutable.
  const before = { chrome: (await mutable(t.chrome, SHEETS)).ids, ours: (await mutable(t.ours, SHEETS)).ids };
  await t.page.evaluate(() => {
    (sheetOf('ins').ownerNode as HTMLStyleElement).textContent = '.q { color: red; }';
  });
  const [oursRemoved, chromeRemoved] = await waitForBoth(t, 'CSS.styleSheetRemoved');
  const [oursAdded, chromeAdded] = await waitForBoth(t, 'CSS.styleSheetAdded');
  for (const [name, removed, added] of [
    ['chrome', chromeRemoved, chromeAdded],
    ['ours', oursRemoved, oursAdded],
  ] as const) {
    assert.deepEqual(removed, [{ styleSheetId: idOf(before[name], 'ins') }], name);
    assert.equal(added.length, 1, name);
    assert.equal(added[0]?.header.isMutable, false, name);
    assert.deepEqual(await t[name].events('CSS.styleSheetChanged'), [], name);
  }
  const last = await mutable(t.chrome, SHEETS);
  assert.deepEqual(last.values, { ...expected, ins: false }, 'new text');
  assert.deepEqual((await mutable(t.ours, SHEETS)).values, last.values, 'new text');
  await t.page.close();
});

test('isMutable: a property written by name and not read again counts once CSS is enabled again', async () => {
  const t = await open(async () => {
    const style = document.createElement('style');
    style.id = 'named';
    style.textContent = '.a { color: red; }';
    document.head.append(style);
  });
  for (const side of [t.chrome, t.ours]) await side.send('CSS.enable');
  await t.page.evaluate(() => {
    const sheet = (document.getElementById('named') as HTMLStyleElement).sheet;
    const rule = sheet?.cssRules[0] as CSSStyleRule | undefined;
    if (rule) rule.style.color = 'green';
  });
  // Straight to disable and enable: nothing read the text in between.
  const chrome = await mutable(t.chrome, 1);
  assert.deepEqual(chrome.values, { named: true });
  assert.deepEqual((await mutable(t.ours, 1)).values, chrome.values);
  await t.page.close();
});

test(
  'isMutable: a change the page made while CSS was disabled',
  { todo: 'unseen: the CSSOM is hooked only while CSS is enabled (docs/limitations.md)' },
  async () => {
    const t = await open(async () => {
      const style = document.createElement('style');
      style.id = 'disabled';
      style.textContent = '.a { color: red; }';
      document.head.append(style);
    });
    for (const side of [t.chrome, t.ours]) {
      await side.send('CSS.enable');
      await side.send('CSS.disable');
    }
    await t.page.evaluate(() =>
      (document.getElementById('disabled') as HTMLStyleElement).sheet?.insertRule('.z {}', 0)
    );
    const chrome = await mutable(t.chrome, 1);
    assert.deepEqual(chrome.values, { disabled: true });
    try {
      assert.deepEqual((await mutable(t.ours, 1)).values, chrome.values);
    } finally {
      await t.page.close();
    }
  }
);

test(
  'isMutable: a property written by name with a value it rejects',
  { todo: 'unseen: the rule text compared stays the same (docs/limitations.md)' },
  async () => {
    const t = await open(async () => {
      const style = document.createElement('style');
      style.id = 'named-bad';
      style.textContent = '.a { color: red; }';
      document.head.append(style);
    });
    for (const side of [t.chrome, t.ours]) await side.send('CSS.enable');
    await t.page.evaluate(() => {
      const sheet = (document.getElementById('named-bad') as HTMLStyleElement).sheet;
      const rule = sheet?.cssRules[0] as CSSStyleRule | undefined;
      if (rule) rule.style.color = 'nope';
    });
    const chrome = await mutable(t.chrome, 1);
    assert.deepEqual(chrome.values, { 'named-bad': true });
    try {
      assert.deepEqual((await mutable(t.ours, 1)).values, chrome.values);
    } finally {
      await t.page.close();
    }
  }
);

const EDITED = ['texts', 'text', 'rule', 'sel', 'media', 'key'] as const;

test('isMutable: true once a session edits a sheet, inspector sheets included', async () => {
  // Each side edits sheets of its own.
  const t = await open(async () => {
    for (const side of ['chrome', 'ours'])
      for (const kind of ['texts', 'text', 'rule', 'sel', 'media', 'key']) {
        const style = document.createElement('style');
        style.id = `${side}-${kind}`;
        style.textContent =
          '.a { color: red; }\n@media screen { .m { color: red; } }\n@keyframes k { from { color: red; } }';
        document.head.append(style);
      }
    const imp = document.createElement('style');
    imp.id = 'imp';
    imp.textContent = '@import url(assets/frame.css?i-chrome); @import url(assets/frame.css?i-ours);';
    document.head.append(imp);
    await Promise.all(
      ['l-chrome', 'l-ours'].map(
        q =>
          new Promise(r => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = `assets/frame.css?${q}`;
            link.onload = r;
            document.head.append(link);
          })
      )
    );
    const rules = (imp.sheet?.cssRules ?? []) as CSSRuleList;
    for (const rule of Array.from(rules))
      while (!(rule as CSSImportRule).styleSheet?.cssRules.length) await new Promise(r => setTimeout(r, 10));
  });
  // Sheets: 12 <style>s, the one with the @imports, the two @imported, two <link>s.
  const PAGE_SHEETS = 17;
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

    const own = (kind: string) => idOf(ids, `${name}-${kind}`);
    await side.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: own('texts'), range: line(0, 4, 17), text: ' color: pink; ' }],
    });
    await side.send('CSS.setStyleSheetText', { styleSheetId: own('text'), text: '.b { color: red; }' });
    await side.send('CSS.addRule', { styleSheetId: own('rule'), ruleText: '.c {}', location: at });
    await side.send('CSS.setRuleSelector', { styleSheetId: own('sel'), range: line(0, 0, 2), selector: '.y' });
    await side.send('CSS.setMediaText', { styleSheetId: own('media'), range: line(1, 7, 13), text: 'print' });
    await side.send('CSS.setKeyframeKey', { styleSheetId: own('key'), range: line(2, 15, 19), keyText: 'to' });
    await side.send('CSS.addRule', { styleSheetId: idOf(ids, `l-${name}`), ruleText: '.c {}', location: at });
    await side.send('CSS.addRule', { styleSheetId: idOf(ids, `i-${name}`), ruleText: '.c {}', location: at });
    await side.send('CSS.addRule', { styleSheetId: inspector, ruleText: '.c {}', location: at });
  }

  const both = (value: boolean) =>
    Object.fromEntries(
      ['chrome', 'ours'].flatMap(s => [...EDITED.map(k => `${s}-${k}`), `l-${s}`, `i-${s}`]).map(k => [k, value])
    );
  // Chrome sees our edits, made through the CSSOM, and our inspector sheet, a <style>.
  const chrome = await mutable(t.chrome, PAGE_SHEETS + 2);
  assert.deepEqual(chrome.values, { ...both(true), imp: false, inspector: true, 'ours-inspector': true });
  // Our hooks do not see Chrome's edits, which do not go through the page's CSSOM: its sheets
  // stay immutable for us (only Chrome's own session edits them, so this does not happen in use).
  const ours = await mutable(t.ours, PAGE_SHEETS + 1);
  const chromeEdited = Object.fromEntries(
    Object.keys(both(true))
      .filter(k => k.startsWith('chrome') || k.endsWith('-chrome'))
      .map(k => [k, false])
  );
  assert.deepEqual(ours.values, { ...both(true), ...chromeEdited, imp: false, inspector: true });
  await t.page.close();
});
