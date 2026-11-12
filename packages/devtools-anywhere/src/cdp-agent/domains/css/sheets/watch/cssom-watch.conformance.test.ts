// cssom-watch.ts in Chrome: where in its sheet each change the page makes through the CSSOM is
// reported to be, for a text serialized from the CSSOM to be changed there alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { build } from 'esbuild';
import { launch, setUpAndTearDown } from '../../../../../../test-support/conformance.ts';
import type { RuleChange, ownCall, ownSet, ownStyle, recordPageChanges, settle, watchCssom } from './cssom-watch.ts';
import type { Env } from '../../../../../../test-support/conformance.ts';

// Bundled for the page: the sources import each other without extensions.
const bundled = await build({
  stdin: {
    contents:
      "export { watchCssom, recordPageChanges, ownCall, ownEdit, ownSet, ownStyle, settle, forgetSheet } from './cssom-watch.ts';",
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: '__cssomWatch',
  platform: 'neutral',
  write: false,
});

let env: Env | undefined;
let page: Page;

setUpAndTearDown(
  async () => {
    env = await launch();
    page = await env.browser.newPage();
    await page.addScriptTag({ content: bundled.outputFiles[0]?.text ?? '' });
  },
  () => env?.close()
);

/**
 * What is reported for each step run in the page on a sheet of `css`, as text: `rule N` (the
 * top-level rule at N), `insert N`, `delete N`, `text` (a new text) or `none` (no place told);
 * nothing for a step reported nothing. The styles' writes by name are seen past each step
 * (`settle`), once the page ran (a microtask later). With `inStyle`, the sheet is a <style>'s.
 */
async function reports(css: string, steps: string[], inStyle = false): Promise<string[][]> {
  return page.evaluate(
    async (css, steps, inStyle) => {
      const w = (
        globalThis as unknown as {
          __cssomWatch: {
            recordPageChanges: typeof recordPageChanges;
            watchCssom: typeof watchCssom;
            ownStyle: typeof ownStyle;
            settle: typeof settle;
          };
        }
      ).__cssomWatch;
      let sheet = new CSSStyleSheet();
      if (inStyle) {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.append(style);
        sheet = style.sheet as CSSStyleSheet;
      } else sheet.replaceSync(css);
      let seen: string[] = [];
      w.recordPageChanges((s: CSSStyleSheet, text: string | undefined, change: RuleChange | undefined) => {
        if (s !== sheet) return;
        if (text !== undefined) seen.push('text');
        else if (!change) seen.push('none');
        else if (change.kind === 'rule') seen.push(`rule ${Array.prototype.indexOf.call(sheet.cssRules, change.rule)}`);
        else seen.push(`${change.kind} ${change.index}`);
      });
      const stop = w.watchCssom(
        () => {},
        () => [window]
      );
      const out: string[][] = [];
      try {
        for (const step of steps) {
          seen = [];
          try {
            new Function('sheet', 'ownStyle', step)(sheet, w.ownStyle);
          } catch {
            // A call the browser refused: reported or not, as it is.
          }
          await Promise.resolve();
          w.settle();
          out.push(seen);
        }
      } finally {
        stop();
      }
      return out;
    },
    css,
    steps,
    inStyle
  );
}

test('rules inserted and deleted at the top: their index', async () => {
  assert.deepEqual(
    await reports('.a{} .b{} .c{}', [
      "sheet.insertRule('.x{}', 1)",
      "sheet.insertRule('.y{}')",
      "sheet.addRule('.z', 'top: 1px')",
      "sheet.addRule('.w', '', 2)",
      'sheet.deleteRule(3)',
      'sheet.removeRule()',
      'sheet.deleteRule(99)',
    ]),
    [['insert 1'], ['insert 0'], ['insert 5'], ['insert 2'], ['delete 3'], ['delete 0'], []]
  );
});

test('changes in a rule: the top-level rule they are in', async () => {
  assert.deepEqual(
    await reports('.a{top:1px} @media screen{.m{left:1px}} .n{.inner{color:red}} @keyframes k{from{top:0}} .s{}', [
      "sheet.cssRules[0].style.setProperty('top', '2px')",
      "sheet.cssRules[1].cssRules[0].style.removeProperty('left')",
      "sheet.cssRules[1].insertRule('.m2{}')",
      "sheet.cssRules[2].cssRules[0].style.cssText = 'color: blue'",
      "sheet.cssRules[2].cssRules[0].selectorText = '.inner2'",
      "sheet.cssRules[2].insertRule('&:hover{}', 1)",
      'sheet.cssRules[2].deleteRule(0)',
      "sheet.cssRules[3].appendRule('to{top:1px}')",
      "sheet.cssRules[3].cssRules[0].keyText = '10%'",
      "sheet.cssRules[4].selectorText = '.s2'",
    ]),
    [
      ['rule 0'],
      ['rule 1'],
      ['rule 1'],
      ['rule 2'],
      ['rule 2'],
      ['rule 2'],
      ['rule 2'],
      ['rule 3'],
      ['rule 3'],
      ['rule 4'],
    ]
  );
});

test('a new text, and a rule out of the sheet: no place', async () => {
  assert.deepEqual(
    await reports('.a{top:1px} .b{}', [
      "sheet.replaceSync('.c{}')",
      "const r = sheet.cssRules[0]; sheet.deleteRule(0); r.style.setProperty('top', '1px')",
      "document.body.style.setProperty('top', '1px')",
    ]),
    [['text'], ['delete 0'], []]
  );
});

// In a <style>, which may have @import (replaceSync() leaves it out).
test("a rule's media list changed: the top-level rule it is in", async () => {
  assert.deepEqual(
    await reports(
      '@import url(x.css) print; .a{} @media screen{.m{}} @supports (top:0){@media print{.n{}}}',
      [
        // Forwarded to the list's `mediaText`, through the rule's getter: first, the list not seen before.
        "sheet.cssRules[2].media = 'screen'",
        "sheet.cssRules[2].media.mediaText = 'print'",
        "sheet.cssRules[2].media.appendMedium('tv')",
        "sheet.cssRules[2].media.deleteMedium('print')",
        "sheet.cssRules[3].cssRules[0].media.appendMedium('screen')",
        "sheet.cssRules[0].media.mediaText = 'screen'",
        "sheet.cssRules[0].media.appendMedium('tv')",
        "sheet.cssRules[2].media.deleteMedium('nope')",
        // The sheet's own list, which belongs to no rule.
        "sheet.media.appendMedium('print')",
      ],
      true
    ),
    [['rule 2'], ['rule 2'], ['rule 2'], ['rule 2'], ['rule 3'], ['rule 0'], ['rule 0'], [], []]
  );
});

test("a sheet's own media list is told to the listeners as media, with no text and no rule", async () => {
  const told = await page.evaluate(() => {
    const w = (globalThis as unknown as { __cssomWatch: { watchCssom: typeof watchCssom } }).__cssomWatch;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.a{top:1px} @media print{.b{top:2px}}');
    const told: string[] = [];
    const stop = w.watchCssom(
      (s, text, _by, change) => {
        if (s === sheet) told.push(`${text === undefined ? 'no text' : 'text'} ${change?.kind ?? 'none'}`);
      },
      () => [window]
    );
    try {
      sheet.media.mediaText = 'print';
      sheet.media.appendMedium('screen');
      sheet.media.deleteMedium('print');
    } finally {
      stop();
    }
    return told;
  });
  assert.deepEqual(told, ['no text media', 'no text media', 'no text media']);
});

test("a style's properties written by name: its top-level rule, once the page ran", async () => {
  assert.deepEqual(
    await reports(
      '.a{top:1px} @media screen{.m{left:1px}} .n{.inner{color:red}} @keyframes k{from{top:0}} @page{margin:1px} @font-face{font-family:f}',
      [
        "sheet.cssRules[0].style.color = 'red'",
        "sheet.cssRules[1].cssRules[0].style.marginTop = '1px'",
        "sheet.cssRules[2].cssRules[0].style.color = 'blue'",
        "sheet.cssRules[3].cssRules[0].style.top = '2px'",
        "sheet.cssRules[4].style.marginLeft = '2px'",
        "sheet.cssRules[5].style.fontStyle = 'italic'",
        // Read, or written the same: nothing changed.
        'sheet.cssRules[0].style.color',
        "sheet.cssRules[0].style.color = 'red'",
        // Kept, then written later.
        'globalThis.kept = sheet.cssRules[2].style',
        "globalThis.kept.left = '3px'",
        // Written by name, and through setProperty() (told at once): told once.
        "sheet.cssRules[0].style.left = '1px'; sheet.cssRules[0].style.setProperty('right', '1px')",
      ]
    ),
    [['rule 0'], ['rule 1'], ['rule 2'], ['rule 3'], ['rule 4'], ['rule 5'], [], [], [], ['rule 2'], ['rule 0']]
  );
});

test("the CSS domain's own reading of a style: not taken by the page", async () => {
  assert.deepEqual(
    await reports('.a{top:1px} .b{}', [
      'globalThis.ours = ownStyle(sheet.cssRules[0])',
      "globalThis.ours.color = 'red'",
      "sheet.cssRules[1].media; sheet.cssRules[1].style.color = 'red'",
    ]),
    [[], [], ['rule 1']]
  );
});

test('the hooked getters: as the native ones while watching, the native ones after', async () => {
  const seen = await page.evaluate(() => {
    const w = (globalThis as unknown as { __cssomWatch: { watchCssom: typeof watchCssom } }).__cssomWatch;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.a{top:1px} @media print{}');
    const style = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'style');
    const media = Object.getOwnPropertyDescriptor(CSSMediaRule.prototype, 'media');
    const shown = () => {
      const s = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'style')?.get;
      const m = Object.getOwnPropertyDescriptor(CSSMediaRule.prototype, 'media')?.get;
      const [a, b] = Array.from(sheet.cssRules) as [CSSStyleRule, CSSMediaRule];
      let threw = '';
      try {
        s?.call(b);
      } catch (e) {
        threw = (e as Error).constructor.name;
      }
      return [
        s?.name,
        s?.length,
        Function.prototype.toString.call(s).includes('[native code]'),
        m?.name,
        a.style === a.style,
        b.media === b.media,
        threw,
      ];
    };
    const stop = w.watchCssom(
      () => {},
      () => [window]
    );
    const watching = [...shown(), Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'style')?.get !== style?.get];
    stop();
    const after = [
      Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'style')?.get === style?.get,
      Object.getOwnPropertyDescriptor(CSSMediaRule.prototype, 'media')?.get === media?.get,
      Object.getOwnPropertyDescriptor(CSSMediaRule.prototype, 'media')?.set === media?.set,
    ];
    return { watching, after };
  });
  assert.deepEqual(seen, {
    watching: ['get style', 0, true, 'get media', true, true, 'TypeError', true],
    after: [true, true, true],
  });
});

test('past the limit of styles taken: their sheet, as changed everywhere', async () => {
  const css = Array.from({ length: 2100 }, (_, i) => `.r${i} { top: 0px; }`).join(' ');
  assert.deepEqual(await reports(css, ['for (const r of sheet.cssRules) r.style.top', 'sheet.cssRules[0].style.top']), [
    ['none'],
    [],
  ]);
});

test('styles kept from earlier rounds: watched up to the limit, then their sheet as changed', async () => {
  const css = Array.from({ length: 2100 }, (_, i) => `.r${i} { top: 0px; }`).join(' ');
  assert.deepEqual(
    await reports(css, [
      // 1500 styles kept, under the limit: a write through the first, two rounds later, is seen.
      'globalThis.kept = Array.from(sheet.cssRules).slice(0, 1500).map(r => r.style)',
      'sheet.cssRules[1600].style.top',
      "globalThis.kept[0].top = '1px'",
      // 600 more: 2100 watched in all, past the limit.
      'for (const r of Array.from(sheet.cssRules).slice(1500)) r.style.top',
    ]),
    [[], [], ['rule 0'], ['none']]
  );
});

test('a sheet serialized anew: what was written is dropped, the styles taken still watched', async () => {
  assert.deepEqual(
    await reports('.a { top: 0px; } .b { top: 0px; }', [
      'globalThis.kept = sheet.cssRules[0].style',
      "globalThis.kept.top = '1px'",
      'globalThis.__cssomWatch.forgetSheet(sheet)',
      "globalThis.kept.top = '2px'; globalThis.kept.left = '1px'; __cssomWatch.forgetSheet(sheet)",
      "globalThis.kept.top = '3px'",
    ]),
    [[], ['rule 0'], [], [], ['rule 0']]
  );
});

test("a counter style's setters: the rule", async () => {
  assert.deepEqual(
    await reports('.a{} @counter-style c { system: cyclic; symbols: a b; }', [
      'sheet.cssRules[1].prefix = \'"x"\'',
      "sheet.cssRules[1].symbols = 'c d'",
      "sheet.cssRules[1].name = 'd'",
    ]),
    [['rule 1'], ['rule 1'], ['rule 1']]
  );
});

test("the page's objects as arguments: converted once, by the browser alone", async () => {
  assert.deepEqual(
    await reports('.a{} .b{} .c{}', [
      'globalThis.n = 0; sheet.deleteRule({ valueOf() { n++; return 1; } }); if (n !== 1) throw 0; globalThis.ok = 1',
      "globalThis.n = 0; sheet.replaceSync({ toString() { n++; return '.d{}'; } }); if (n !== 1) sheet.insertRule('.bad{}')",
      "sheet.addRule('.e', '', { valueOf() { throw new Error('again'); } })",
    ]),
    // No place known, nor the text; the last call refused by the browser itself.
    [['none'], ['none'], []]
  );
});

test("replace() and then replaceSync(): the text of replace() not taken, it is no longer the sheet's", async () => {
  const seen = await page.evaluate(async () => {
    const w = (
      globalThis as unknown as {
        __cssomWatch: { recordPageChanges: typeof recordPageChanges; watchCssom: typeof watchCssom };
      }
    ).__cssomWatch;
    const sheet = new CSSStyleSheet();
    // No text (serialized anew) as null: undefined in an array crosses evaluate() as null.
    const texts: (string | null)[] = [];
    w.recordPageChanges((s: CSSStyleSheet, text: string | undefined) => {
      if (s === sheet) texts.push(text ?? null);
    });
    const stop = w.watchCssom(
      () => {},
      () => [window]
    );
    try {
      const done = sheet.replace('.a{}');
      sheet.replaceSync('.b{}');
      await done;
      await new Promise(r => setTimeout(r, 0));
      // Alone, it is.
      await sheet.replace('.c{}');
      await new Promise(r => setTimeout(r, 0));
    } finally {
      stop();
    }
    return texts;
  });
  assert.deepEqual(seen, ['.b{}', null, '.c{}']);
});

test("a frame's prototypes made unhookable: left alone, the others watched and given back", async () => {
  const seen = await page.evaluate(() => {
    const w = (
      globalThis as unknown as {
        __cssomWatch: { recordPageChanges: typeof recordPageChanges; watchCssom: typeof watchCssom };
      }
    ).__cssomWatch;
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const realm = frame.contentWindow as Window & typeof globalThis;
    Object.freeze(realm.CSSStyleSheet.prototype);
    const sheet = new CSSStyleSheet();
    let reported = 0;
    w.recordPageChanges(s => {
      if (s === sheet) reported++;
    });
    const native = CSSStyleSheet.prototype.insertRule;
    const stop = w.watchCssom(
      () => {},
      () => [realm, window]
    );
    sheet.insertRule('.a{}');
    const hooked = CSSStyleSheet.prototype.insertRule !== native;
    stop();
    frame.remove();
    return { reported, hooked, back: CSSStyleSheet.prototype.insertRule === native };
  });
  assert.deepEqual(seen, { reported: 1, hooked: true, back: true });
});

test("the CSS domain's own changes: the native functions, past the hooks and the page's, in every realm", async () => {
  const seen = await page.evaluate(() => {
    const w = (
      globalThis as unknown as {
        __cssomWatch: {
          recordPageChanges: typeof recordPageChanges;
          watchCssom: typeof watchCssom;
          ownCall: typeof ownCall;
          ownSet: typeof ownSet;
          ownStyle: typeof ownStyle;
        };
      }
    ).__cssomWatch;
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const inner = frame.contentWindow as Window & typeof globalThis;
    // A sheet of each realm, made before the page replaced the functions.
    const sheets = [new CSSStyleSheet(), new inner.CSSStyleSheet()];
    for (const sheet of sheets) sheet.replaceSync('.f{top:0} @media print{.m{}} @keyframes k{from{top:0}}');
    let reported = 0;
    w.recordPageChanges(() => reported++);
    const stop = w.watchCssom(
      () => {},
      () => [window, inner]
    );
    // The page puts its own functions over the hooks: our changes do not call them.
    let calls = 0;
    for (const realm of [window, inner]) {
      for (const [proto, name] of [
        [realm.CSSStyleSheet.prototype, 'insertRule'],
        [realm.CSSStyleSheet.prototype, 'deleteRule'],
        [realm.CSSStyleSheet.prototype, 'replaceSync'],
        [realm.CSSGroupingRule.prototype, 'insertRule'],
      ] as unknown as [Record<string, unknown>, string][]) {
        const f = proto[name] as (...args: unknown[]) => unknown;
        proto[name] = function (this: unknown, ...args: unknown[]) {
          calls++;
          return Reflect.apply(f, this, args);
        };
      }
      for (const [proto, name] of [
        [realm.CSSStyleRule.prototype, 'selectorText'],
        [realm.CSSStyleDeclaration.prototype, 'cssText'],
        [realm.MediaList.prototype, 'mediaText'],
        [realm.CSSKeyframeRule.prototype, 'keyText'],
      ] as [object, string][]) {
        const d = Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor;
        Object.defineProperty(proto, name, {
          ...d,
          set(this: unknown, v: unknown) {
            calls++;
            d.set?.call(this, v);
          },
        });
      }
      const style = Object.getOwnPropertyDescriptor(realm.CSSStyleRule.prototype, 'style') as PropertyDescriptor;
      Object.defineProperty(realm.CSSStyleRule.prototype, 'style', {
        ...style,
        get(this: unknown) {
          calls++;
          return style.get?.call(this) as unknown;
        },
      });
    }
    const out: string[] = [];
    try {
      for (const sheet of sheets) {
        for (let i = 0; i < 1000; i++) w.ownCall(sheet, 'insertRule', `.n${i}{}`, sheet.cssRules.length);
        while (sheet.cssRules.length > 3) w.ownCall(sheet, 'deleteRule', sheet.cssRules.length - 1);
        const [rule, media, keyframes] = Array.from(sheet.cssRules) as [CSSStyleRule, CSSMediaRule, CSSKeyframesRule];
        w.ownSet(rule, 'selectorText', '.g');
        w.ownSet(w.ownStyle(rule), 'cssText', 'left: 1px');
        w.ownSet(keyframes.cssRules[0] as CSSKeyframeRule, 'keyText', '50%');
        w.ownSet(media.media, 'mediaText', 'screen');
        w.ownCall(media, 'insertRule', '.i{}', 0);
        out.push(Array.from(sheet.cssRules, r => r.cssText).join(' '));
        w.ownCall(sheet, 'replaceSync', '.r{}');
        out.push(Array.from(sheet.cssRules, r => r.cssText).join(' '));
      }
      // The page's own call is still seen, through its function.
      (sheets[1] as CSSStyleSheet).insertRule('.p{}');
    } finally {
      stop();
      frame.remove();
    }
    return { out, calls, reported };
  });
  const text = '.g { left: 1px; } @media screen {\n  .i { }\n  .m { }\n} @keyframes k { \n  50% { top: 0px; }\n}';
  assert.deepEqual(seen, { out: [text, '.r { }', text, '.r { }'], calls: 1, reported: 1 });
});

test("the CSS domain's own changes: done still when the page renames the interfaces", async () => {
  const seen = await page.evaluate(() => {
    const w = (
      globalThis as unknown as {
        __cssomWatch: { ownCall: typeof ownCall; ownSet: typeof ownSet; ownStyle: typeof ownStyle };
      }
    ).__cssomWatch;
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const inner = frame.contentWindow as Window & typeof globalThis;
    const sheets = [new CSSStyleSheet(), new inner.CSSStyleSheet()];
    // Each prototype named as another interface with the same members, whose functions refuse it.
    const renamed: [object, string][] = [];
    for (const realm of [window, inner])
      for (const [proto, tag] of [
        [realm.CSSStyleSheet.prototype, 'CSSGroupingRule'],
        [realm.CSSMediaRule.prototype, 'CSSStyleSheet'],
        [realm.CSSStyleRule.prototype, 'CSSPageRule'],
        [realm.CSSStyleDeclaration.prototype, 'CSSStyleRule'],
      ] as [object, string][]) {
        renamed.push([proto, Object.getOwnPropertyDescriptor(proto, Symbol.toStringTag)?.value as string]);
        Object.defineProperty(proto, Symbol.toStringTag, { value: tag, configurable: true });
      }
    const out: string[] = [];
    try {
      for (const sheet of sheets) {
        w.ownCall(sheet, 'replaceSync', '.a{} @media print{}');
        w.ownCall(sheet, 'insertRule', '.b{}', 0);
        const [, rule, media] = Array.from(sheet.cssRules) as [CSSRule, CSSStyleRule, CSSMediaRule];
        w.ownCall(media, 'insertRule', '.c{}', 0);
        w.ownSet(w.ownStyle(rule), 'cssText', 'top: 1px');
        w.ownCall(sheet, 'deleteRule', 0);
        out.push(Array.from(sheet.cssRules, r => r.cssText).join(' '));
      }
    } finally {
      for (const [proto, tag] of renamed)
        Object.defineProperty(proto, Symbol.toStringTag, { value: tag, configurable: true });
      frame.remove();
    }
    return out;
  });
  const text = '.a { top: 1px; } @media print {\n  .c { }\n}';
  assert.deepEqual(seen, [text, text]);
});
