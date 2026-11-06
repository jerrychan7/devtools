// cssom-watch.ts in Chrome: where in its sheet each change the page makes through the CSSOM is
// reported to be, for a text serialized from the CSSOM to be changed there alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { build } from 'esbuild';
import { launch, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { CssomChange, recordPageChanges, watchCssom } from './cssom-watch.ts';
import type { Env } from '../../../../../test-support/conformance.ts';

// Bundled for the page: the sources import each other without extensions.
const bundled = await build({
  stdin: {
    contents: "export { watchCssom, recordPageChanges, ownEdit } from './cssom-watch.ts';",
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
 * nothing for a step reported nothing.
 */
async function reports(css: string, steps: string[]): Promise<string[][]> {
  return page.evaluate(
    (css, steps) => {
      const w = (
        globalThis as unknown as {
          __cssomWatch: { recordPageChanges: typeof recordPageChanges; watchCssom: typeof watchCssom };
        }
      ).__cssomWatch;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
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
            new Function('sheet', step)(sheet);
          } catch {
            // A call the browser refused: reported or not, as it is.
          }
          out.push(seen);
        }
      } finally {
        stop();
      }
      return out;
    },
    css,
    steps
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
      "sheet.cssRules[3].appendRule('to{top:1px}')",
      "sheet.cssRules[3].cssRules[0].keyText = '10%'",
      "sheet.cssRules[4].selectorText = '.s2'",
    ]),
    [['rule 0'], ['rule 1'], ['rule 1'], ['rule 2'], ['rule 2'], ['rule 3'], ['rule 3'], ['rule 4']]
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
