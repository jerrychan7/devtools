// The CSS domain's own edits go through the native CSSOM functions: not through functions the
// page put over them (nor our hooks), and not reported as the page's changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { launch, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env } from '../../../../../test-support/conformance.ts';

let env: Env | undefined;
let page: Page;

setUpAndTearDown(
  async () => {
    env = await launch();
    page = await env.browser.newPage();
    await page.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
    await page.evaluate(() => {
      const s = document.createElement('style');
      s.id = 'own';
      s.textContent = Array.from({ length: 40 }, (_, i) => `.own${i} { top: ${i}px; }`).join('\n');
      document.head.append(s);
    });
    await page.addScriptTag({ url: env.baseUrl + '/packages/devtools-anywhere/dist/devtools-anywhere.iife.js' });
  },
  () => env?.close()
);

test("the CSS domain's edits call none of the page's CSSOM functions, and report nothing", async () => {
  const seen = await page.evaluate(async () => {
    const session = window.DevtoolsAnywhere.createCdpSession();
    const changed: string[] = [];
    const added: { styleSheetId: string; ownerNode?: number; length: number }[] = [];
    session.onMessage(m => {
      const msg = JSON.parse(m) as { method?: string; params?: { header?: (typeof added)[number] } };
      if (msg.method === 'CSS.styleSheetChanged') changed.push(msg.method);
      if (msg.method === 'CSS.styleSheetAdded' && msg.params?.header) added.push(msg.params.header);
    });
    const call = (method: string, params: object = {}) => session.call(method, params) as Promise<{ text?: string }>;
    await call('DOM.enable');
    await call('DOM.getDocument', { depth: -1 });
    await call('CSS.enable');
    await new Promise(r => setTimeout(r, 0));
    const sheet = (document.getElementById('own') as HTMLStyleElement).sheet as CSSStyleSheet;
    const styleSheetId = [...added].sort((a, b) => b.length - a.length)[0]?.styleSheetId as string;
    const original = (await call('CSS.getStyleSheetText', { styleSheetId })).text ?? '';

    // The page's functions over the CSSOM's (and our hooks), counting their calls.
    let calls = 0;
    for (const [proto, name] of [
      [CSSStyleSheet.prototype, 'insertRule'],
      [CSSStyleSheet.prototype, 'deleteRule'],
      [CSSStyleSheet.prototype, 'replaceSync'],
      [CSSGroupingRule.prototype, 'insertRule'],
      [CSSGroupingRule.prototype, 'deleteRule'],
    ] as unknown as [Record<string, unknown>, string][]) {
      const f = proto[name] as (...args: unknown[]) => unknown;
      proto[name] = function (this: unknown, ...args: unknown[]) {
        calls++;
        return Reflect.apply(f, this, args);
      };
    }
    for (const [proto, name] of [
      [CSSStyleRule.prototype, 'selectorText'],
      [CSSStyleDeclaration.prototype, 'cssText'],
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

    // A rule changed in the middle: only it is replaced (the others stay the same objects).
    const first = sheet.cssRules[0];
    const middle = original.replace('.own20 { top: 20px; }', '.own20 { top: 21px; }\n.added { left: 0px; }');
    await call('CSS.setStyleSheetText', { styleSheetId, text: middle });
    const kept = sheet.cssRules[0] === first;
    // Back, then a style and a selector edited.
    await call('CSS.setStyleSheetText', { styleSheetId, text: original });
    const line = original.split('\n').indexOf('.own3 { top: 3px; }');
    await call('CSS.setStyleTexts', {
      edits: [
        {
          styleSheetId,
          range: { startLine: line, startColumn: 7, endLine: line, endColumn: 18 },
          text: ' left: 1px; ',
        },
      ],
    });
    await call('CSS.setRuleSelector', {
      styleSheetId,
      range: { startLine: line, startColumn: 0, endLine: line, endColumn: 5 },
      selector: '.mine',
    });
    const text = Array.from(sheet.cssRules, r => r.cssText);
    await new Promise(r => setTimeout(r, 0));
    const ours = { calls, changed: changed.length };

    // The page's own change is still seen.
    sheet.insertRule('.page {}');
    await new Promise(r => setTimeout(r, 0));
    return { kept, rules: text.length, third: text[3], ours, page: { calls, changed: changed.length } };
  });
  assert.deepEqual(seen, {
    kept: true,
    rules: 40,
    third: '.mine { left: 1px; }',
    ours: { calls: 0, changed: 0 },
    page: { calls: 1, changed: 1 },
  });
});
