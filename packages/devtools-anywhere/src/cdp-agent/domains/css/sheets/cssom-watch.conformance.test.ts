// cssom-watch.ts in Chrome: where in its sheet each change the page makes through the CSSOM is
// reported to be, for a text serialized from the CSSOM to be changed there alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { build } from 'esbuild';
import { launch, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { CssomChange, ownStyle, recordPageChanges, settle, watchCssom } from './cssom-watch.ts';
import type { Env } from '../../../../../test-support/conformance.ts';

// Bundled for the page: the sources import each other without extensions.
const bundled = await build({
  stdin: {
    contents:
      "export { watchCssom, recordPageChanges, ownEdit, ownStyle, settle, forgetSheet } from './cssom-watch.ts';",
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
      w.recordPageChanges((s: CSSStyleSheet, text: string | undefined, change: CssomChange | undefined) => {
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
