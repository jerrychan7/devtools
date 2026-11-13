// written-blocks.ts in Chrome: what is kept of the texts the page writes its sheets and rules in, and that the
// functions put on the prototypes do what the browser's own do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { build } from 'esbuild';
import { launch, setUpAndTearDown } from '../../../../../../test-support/conformance.ts';
import type { ownCall, watchCssom } from './cssom-watch.ts';
import type { listBroken, wasInserted, writtenText } from './written-blocks.ts';
import type { Env } from '../../../../../../test-support/conformance.ts';

// Bundled for the page: the sources import each other without extensions.
const bundled = await build({
  stdin: {
    contents: `export { watchCssom, ownCall } from './cssom-watch.ts';
      export { listBroken, wasInserted, writtenText } from './written-blocks.ts';`,
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: '__written',
  platform: 'neutral',
  write: false,
});

interface Written {
  watchCssom: typeof watchCssom;
  ownCall: typeof ownCall;
  listBroken: typeof listBroken;
  wasInserted: typeof wasInserted;
  writtenText: typeof writtenText;
}

let env: Env | undefined;

setUpAndTearDown(
  async () => {
    env = await launch();
  },
  () => env?.close()
);

/** A page with the module loaded, as the agent loads it: before the page writes anything. */
async function freshPage(): Promise<Page> {
  if (!env) throw new Error('no browser');
  const page = await env.browser.newPage();
  await page.goto(`${env.baseUrl}/packages/devtools-anywhere/test-support/fixture.html`);
  await page.addScriptTag({ content: bundled.outputFiles[0]?.text ?? '' });
  return page;
}

test('the texts the page writes sheets and rules in are kept, whoever watches, and which lists still read as theirs', async () => {
  const page = await freshPage();
  const kept = await page.evaluate(async () => {
    const w = (globalThis as unknown as { __written: Written }).__written;
    const text = (target: object | undefined) => (target ? (w.writtenText(target)?.text ?? null) : undefined);
    const out: Record<string, unknown> = {};
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.a { padding: env(safe-area-inset-top) 2px; padding-left: 3px } @media all {} .z {}');
    out['replaceSync'] = text(sheet);
    const [a, media] = Array.from(sheet.cssRules) as [CSSStyleRule, CSSMediaRule];
    // An inserted rule: of a sheet, of a grouping rule, of a style rule. Each is noted as inserted, with its text
    // where that may call env(): in any case, or with an escape.
    const top = sheet.cssRules[sheet.insertRule('.b { margin: ENV(safe-area-inset-top) }', 2)];
    const plain = sheet.cssRules[sheet.insertRule('.c { color: red }', 0)];
    const grouped = media.cssRules[media.insertRule('.d { top: e\\6e v(safe-area-inset-top) }')];
    const nested = a.cssRules[a.insertRule('& { left: env(safe-area-inset-left) }')];
    sheet.addRule('.f', 'top: env(safe-area-inset-top)', 1);
    const added = sheet.cssRules[1];
    out['inserted'] = [top, plain, grouped, nested, added].map(rule => [text(rule), !!rule && w.wasInserted(rule)]);
    out['written'] = [w.wasInserted(a), text(a)];
    // A list is its text's while only inserted rules are deleted from it.
    sheet.deleteRule(0);
    media.deleteRule(0);
    out['intact'] = [w.listBroken(sheet), w.listBroken(media), w.listBroken(a)];
    sheet.removeRule(sheet.cssRules.length - 1);
    a.deleteRule(0);
    out['broken'] = [w.listBroken(sheet), w.listBroken(media), w.listBroken(a)];
    // The agent's own insertions are kept as the page's are, and its own deletions break a list as well.
    const own = new CSSStyleSheet();
    w.ownCall(own, 'replaceSync', '.a { top: env(safe-area-inset-top) } .b {}');
    const index = w.ownCall<number>(own, 'insertRule', '.e { top: env(safe-area-inset-top) }', 0);
    out['own'] = [text(own), text(own.cssRules[index]), !!own.cssRules[index] && w.wasInserted(own.cssRules[index])];
    w.ownCall(own, 'deleteRule', 0);
    const ownIntact = w.listBroken(own);
    w.ownCall(own, 'deleteRule', 0);
    out['ownBroken'] = [ownIntact, w.listBroken(own)];
    // A text with no env() forgets the one kept; a sheet written whole is its text's again.
    sheet.replaceSync('.a { color: red }');
    out['forgotten'] = [text(sheet), w.listBroken(sheet)];
    // Until replace() resolves, the sheet's text is not known.
    const replacing = sheet.replace('.a { top: env(safe-area-inset-top) } @keyframes k { from { top: 0 } }');
    out['replacing'] = [text(sheet), w.listBroken(sheet)];
    await replacing;
    out['replace'] = [text(sheet), w.listBroken(sheet)];
    const frames = sheet.cssRules[1] as CSSKeyframesRule;
    frames.appendRule('to { top: 1px }');
    out['keyframes'] = w.listBroken(frames);
    return out;
  });
  assert.deepEqual(kept, {
    replaceSync: '.a { padding: env(safe-area-inset-top) 2px; padding-left: 3px } @media all {} .z {}',
    inserted: [
      ['.b { margin: ENV(safe-area-inset-top) }', true],
      [null, true],
      ['.d { top: e\\6e v(safe-area-inset-top) }', true],
      ['& { left: env(safe-area-inset-left) }', true],
      ['.f { top: env(safe-area-inset-top) }', true],
    ],
    written: [false, null],
    intact: [false, false, false],
    broken: [true, false, false],
    own: ['.a { top: env(safe-area-inset-top) } .b {}', '.e { top: env(safe-area-inset-top) }', true],
    ownBroken: [false, true],
    forgotten: [null, false],
    replacing: [null, true],
    replace: ['.a { top: env(safe-area-inset-top) } @keyframes k { from { top: 0 } }', false],
    keyframes: true,
  });
  await page.close();
});

test('the functions that keep the texts behave as the browser has them', async () => {
  const page = await freshPage();
  const same = await page.evaluate(async () => {
    // The functions of a frame nobody watched are the browser's own.
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const native = frame.contentWindow as unknown as typeof globalThis;
    const shown = async (realm: typeof globalThis) => {
      const sheet = new realm.CSSStyleSheet();
      sheet.replaceSync('.a { top: 0 } @media all {} @keyframes k { from { top: 0 } }');
      const [a, media, frames] = Array.from(sheet.cssRules) as [CSSStyleRule, CSSMediaRule, CSSKeyframesRule];
      const caught = (run: () => unknown) => {
        try {
          return String(run());
        } catch (e) {
          return `${(e as Error).name}: ${(e as Error).message}`;
        }
      };
      const functions = [
        realm.CSSStyleSheet.prototype.insertRule,
        realm.CSSStyleSheet.prototype.deleteRule,
        realm.CSSStyleSheet.prototype.addRule,
        realm.CSSStyleSheet.prototype.removeRule,
        realm.CSSStyleSheet.prototype.replaceSync,
        realm.CSSStyleSheet.prototype.replace,
        realm.CSSGroupingRule.prototype.insertRule,
        realm.CSSGroupingRule.prototype.deleteRule,
        realm.CSSStyleRule.prototype.insertRule,
        realm.CSSStyleRule.prototype.deleteRule,
        realm.CSSKeyframesRule.prototype.appendRule,
        realm.CSSKeyframesRule.prototype.deleteRule,
      ] as ((...args: unknown[]) => unknown)[];
      const results = [
        caught(() => sheet.insertRule('.b {}', 1)),
        caught(() => sheet.insertRule('.b {}')),
        caught(() => sheet.insertRule('!')),
        caught(() => sheet.insertRule('.b {}', 9)),
        caught(() => (sheet.insertRule as () => number)()),
        caught(() => media.insertRule('.c {}')),
        caught(() => media.insertRule('}')),
        caught(() => a.insertRule('& {}', 0)),
        caught(() => a.insertRule('.x {}', 5)),
        caught(() => sheet.addRule('.q', 'top: 0')),
        caught(() => sheet.addRule('.q', 'top: 0', 99)),
        caught(() => sheet.deleteRule(0)),
        caught(() => sheet.deleteRule(99)),
        caught(() => sheet.removeRule()),
        caught(() => media.deleteRule(0)),
        caught(() => media.deleteRule(0)),
        caught(() => a.deleteRule(0)),
        caught(() => frames.appendRule('to { top: 1px }')),
        caught(() => frames.deleteRule('from')),
        caught(() => realm.CSSStyleSheet.prototype.replaceSync.call({}, '')),
        Array.from(sheet.cssRules, rule => rule.cssText).join(' '),
        caught(() => sheet.replaceSync('.z {}')),
        String((await sheet.replace('.y {}')) === sheet),
        Array.from(sheet.cssRules, rule => rule.cssText).join(' '),
      ];
      return {
        shape: functions.map(f => [
          f.name,
          f.length,
          typeof f,
          'prototype' in f,
          caught(() => Reflect.construct(f, [])),
        ]),
        results,
      };
    };
    const out = { ours: await shown(globalThis), browser: await shown(native) };
    frame.remove();
    return out;
  });
  assert.deepEqual(same.ours, same.browser);
  assert.deepEqual(same.browser.shape[0]?.slice(0, 4), ['insertRule', 1, 'function', false]);
  await page.close();
});
