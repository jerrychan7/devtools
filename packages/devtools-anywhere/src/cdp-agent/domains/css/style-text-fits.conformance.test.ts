// style.ts `styleTextFits` in Chrome, after the page replaced what it could read: the interfaces'
// getters and methods, and `Symbol.toStringTag`, which `isCssom` reads. It decides as with them
// untouched: as Chrome does (edits.conformance.test.ts compares those texts with Chrome).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { build } from 'esbuild';
import { launch, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env } from '../../../../test-support/conformance.ts';

const bundled = await build({
  stdin: {
    contents: "export { styleTextFits } from './style.ts';",
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: '__fits',
  platform: 'neutral',
  write: false,
});

let env: Env | undefined;
let page: Page;

setUpAndTearDown(
  async () => {
    env = await launch();
    page = await env.browser.newPage();
    // Loaded first, as the agent is: what it takes of the CSSOM is the native.
    await page.addScriptTag({ content: bundled.outputFiles[0]?.text ?? '' });
  },
  () => env?.close()
);

const REFUSED = [' color: blue }', ' color: red; } ', ' color: blue; /* open', 'color:red } .x {'];
const TAKEN = ['', ' color: green ', ' content: "}" ', ' color: red; & i { top: 1px } ', 'a{top:0} color:red'];

test('styleTextFits decides as before once the page replaced the CSSOM it reads', async () => {
  const fits = (texts: string[]) =>
    page.evaluate(
      texts =>
        texts.map(t =>
          (globalThis as unknown as { __fits: { styleTextFits(t: string): boolean } }).__fits.styleTextFits(t)
        ),
      texts
    );
  const before = await fits([...REFUSED, ...TAKEN]);
  assert.deepEqual(before, [...REFUSED.map(() => false), ...TAKEN.map(() => true)]);
  type Restore = { restore?: () => void };
  try {
    await page.evaluate(() => {
      // What to put back, kept before anything is replaced.
      const saved: [object, PropertyKey, PropertyDescriptor | undefined][] = [];
      (globalThis as Restore).restore = () => {
        for (const [target, name, d] of saved.reverse())
          if (d) Object.defineProperty(target, name, d);
          else Reflect.deleteProperty(target, name);
      };
      const lie = (target: object, name: PropertyKey, d: PropertyDescriptor) => {
        saved.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
        Object.defineProperty(target, name, { configurable: true, ...d });
      };
      lie(CSSStyleRule.prototype, Symbol.toStringTag, { value: 'CSSPageRule' });
      lie(CSSStyleRule.prototype, 'selectorText', { get: () => 'p' });
      lie(CSSStyleDeclaration.prototype, 'length', { get: () => 0 });
      lie(CSSStyleDeclaration.prototype, 'getPropertyValue', { value: () => '' });
      lie(CSSRuleList.prototype, 'item', { value: () => null });
      lie(CSSRuleList.prototype, 'length', { get: () => 2 });
      lie(CSSStyleSheet.prototype, 'cssRules', { get: () => [] });
      lie(CSSStyleSheet.prototype, 'replaceSync', { value: () => undefined });
      lie(globalThis, 'CSSStyleSheet', { value: class {} });
    });
    assert.deepEqual(await fits([...REFUSED, ...TAKEN]), before);
  } finally {
    await page.evaluate(() => (globalThis as Restore).restore?.());
  }
  // Put back: the page's CSSOM is its own again.
  assert.equal(
    await page.evaluate(() => Object.prototype.toString.call(new CSSStyleSheet())),
    '[object CSSStyleSheet]'
  );
});
