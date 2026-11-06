// sheet-text.ts in Chrome: the page's changes to a sheet whose text is serialized from the CSSOM
// change that text where they are, and give what serializing and pairing it anew gives: the same
// text, and each rule at the same offsets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { build } from 'esbuild';
import { launch, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env } from '../../../../../test-support/conformance.ts';

// Bundled for the page: the sources import each other without extensions.
const bundled = await build({
  stdin: {
    contents: [
      "export { SheetTexts } from './sheet-text.ts';",
      "export { watchCssom, recordPageChanges } from './cssom-watch.ts';",
      "export { ruleObject } from './css-outline.ts';",
    ].join('\n'),
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: '__sheetText',
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

interface Outcome {
  /** The source was changed in place, rather than serialized and paired anew. */
  inPlace: boolean[];
  /** Each round's source, then the one serialized anew: text, top-level rules, every rule's node. */
  got: string[];
  want: string[];
}

/**
 * Runs each round of steps on a sheet of `css` (serialized from the CSSOM first, unless `authored`,
 * when its text is the one replace() gave), then asks for its source.
 */
async function run(css: string, rounds: string[][], authored = false): Promise<Outcome> {
  return page.evaluate(
    (css, rounds, authored) => {
      type Source = {
        text: string;
        lines: number[];
        outline: unknown;
        nodes: Map<CSSRule, number>;
        top: [CSSRule, number][];
      };
      const m = (globalThis as unknown as { __sheetText: Record<string, never> }).__sheetText as unknown as {
        SheetTexts: new () => { source(s: CSSStyleSheet, f: (s: CSSStyleSheet) => CSSRule[]): Source | null };
        watchCssom(l: () => void, r: () => Window[]): () => void;
        recordPageChanges(f: unknown): void;
        ruleObject(text: string, o: unknown, r: number): unknown;
      };
      const rulesOf = (s: CSSStyleSheet) => Array.from(s.cssRules);
      const texts = new m.SheetTexts();
      m.recordPageChanges((s: CSSStyleSheet, text: string | undefined, change: unknown) =>
        text === undefined
          ? (texts as unknown as { pageChanged(s: CSSStyleSheet, c: unknown): void }).pageChanged(s, change)
          : (texts as unknown as { set(s: CSSStyleSheet, t: string): void }).set(s, text)
      );
      // Made before watching, its text unseen: serialized when first asked for, unless `authored`.
      const sheet = new CSSStyleSheet();
      if (!authored) sheet.replaceSync(css);
      const stop = m.watchCssom(
        () => {},
        () => [window]
      );
      /** The source as text: what a full pairing gives must be the same. */
      const shown = (source: Source | null) => {
        if (!source) return 'null';
        const rules: unknown[] = [];
        const walk = (list: CSSRuleList, path: string) =>
          Array.from(list).forEach((rule, i) => {
            const node = source.nodes.get(rule);
            rules.push([`${path}${i}`, node === undefined ? null : m.ruleObject(source.text, source.outline, node)]);
            if ('cssRules' in rule) walk(rule.cssRules as CSSRuleList, `${path}${i}.`);
          });
        walk(sheet.cssRules, '');
        const top = source.top.map(([rule, node]) => [
          Array.prototype.indexOf.call(sheet.cssRules, rule),
          (m.ruleObject(source.text, source.outline, node) as { start: number }).start,
        ]);
        return JSON.stringify({ text: source.text, lines: source.lines, top, rules }, null, 1);
      };
      const out = { inPlace: [] as boolean[], got: [] as string[], want: [] as string[] };
      try {
        if (authored) void sheet.replace(css);
        return Promise.resolve().then(async () => {
          let before = texts.source(sheet, rulesOf);
          for (const steps of rounds) {
            for (const step of steps) new Function('sheet', step)(sheet);
            // The page ran: what it wrote by name is seen (cssom-watch.ts, `settle`).
            await Promise.resolve();
            const after = texts.source(sheet, rulesOf);
            out.inPlace.push(!!before && !!after && after.outline === before.outline);
            out.got.push(shown(after));
            out.want.push(shown(new m.SheetTexts().source(sheet, rulesOf)));
            before = after;
          }
          stop();
          return out;
        });
      } catch (e) {
        stop();
        throw e;
      }
    },
    css,
    rounds,
    authored
  );
}

const CSS = [
  '.a { color: red; }',
  '@media screen { .m { left: 1px; } .n { top: 2px; } }',
  '.b { margin: 0 auto; .inner { color: blue; } }',
  '@keyframes k { from { top: 0px; } to { top: 9px; } }',
  '.c, .d > span::before { padding: 1px 2px; }',
  '@supports (display: grid) { .g { display: grid; } }',
  '.e { width: calc(100% - 2px); }',
].join('\n');

async function check(rounds: string[][], inPlace: boolean[], css = CSS, authored = false) {
  const out = await run(css, rounds, authored);
  out.got.forEach((got, i) => assert.equal(got, out.want[i], `round ${i}`));
  assert.deepEqual(out.inPlace, inPlace);
}

test('a value changed: setProperty, removeProperty, style.cssText', async () => {
  await check(
    [
      ["sheet.cssRules[0].style.setProperty('color', 'green')"],
      ["sheet.cssRules[6].style.removeProperty('width')"],
      ["sheet.cssRules[4].style.cssText = 'border: 1px solid; float: left'"],
      ["sheet.cssRules[1].cssRules[1].style.setProperty('top', '3px', 'important')"],
      ["sheet.cssRules[2].cssRules[0].style.color = 'navy'; sheet.cssRules[2].style.cssText = ''"],
    ],
    [true, true, true, true, true]
  );
});

test('a selector changed, a keyframe key changed', async () => {
  await check(
    [
      ["sheet.cssRules[4].selectorText = '.z:hover'"],
      ["sheet.cssRules[2].cssRules[0].selectorText = '.deeper .inner'"],
      ["sheet.cssRules[3].cssRules[0].keyText = '10%'"],
    ],
    [true, true, true]
  );
});

test('top-level rules inserted and deleted: first, in the middle, last', async () => {
  await check(
    [
      ["sheet.insertRule('.first { top: 1px; }', 0)"],
      ["sheet.insertRule('@media print { .p { color: black; } }', 4)"],
      ["sheet.insertRule('.last { left: 2px; }', sheet.cssRules.length)"],
      ['sheet.deleteRule(0)'],
      ['sheet.deleteRule(3)'],
      ['sheet.deleteRule(sheet.cssRules.length - 1)'],
      ["sheet.addRule('.added', 'top: 1px', 2)", 'sheet.removeRule(0)'],
    ],
    [true, true, true, true, true, true, true]
  );
});

test('rules inserted in @media, @supports, a style rule, appended to @keyframes', async () => {
  await check(
    [
      ["sheet.cssRules[1].insertRule('.m0 { color: red; }', 0)"],
      ["sheet.cssRules[5].insertRule('.g2 { gap: 1px; }', 1)", 'sheet.cssRules[1].deleteRule(2)'],
      ["sheet.cssRules[3].appendRule('50% { top: 4px; }')"],
      ["sheet.cssRules[3].deleteRule('to')"],
    ],
    [true, true, true, true]
  );
  // Apart: the records the rounds above left behind are about to have the outline made anew.
  await check(
    [["sheet.cssRules[2].insertRule('&:hover { color: red; }', 1)", 'sheet.cssRules[2].deleteRule(0)']],
    [true]
  );
});

test('many changes in one round: inserted then deleted, a new rule changed, moved indices', async () => {
  await check(
    [
      [
        "sheet.insertRule('.x1 { top: 1px; }', 1)",
        "sheet.cssRules[3].style.setProperty('margin', '1px')",
        'sheet.deleteRule(0)',
        "sheet.insertRule('.x2 { top: 2px; }', sheet.cssRules.length)",
        "sheet.cssRules[0].style.setProperty('top', '5px')",
        'sheet.deleteRule(sheet.cssRules.length - 1)',
        "sheet.insertRule('.x3 {}', 3)",
        "sheet.cssRules[3].selectorText = '.x3b'",
        'sheet.deleteRule(4)',
        "sheet.cssRules[1].cssRules[0].style.setProperty('left', '7px')",
      ],
      [
        // The same rule changed again and again, around others inserted and deleted.
        ...Array.from({ length: 50 }, (_, i) => `sheet.cssRules[2].style.setProperty('top', '${i}px')`),
        "sheet.insertRule('.y {}', 2)",
        "sheet.cssRules[3].style.setProperty('top', '99px')",
        'sheet.deleteRule(2)',
        'sheet.deleteRule(2)',
        "sheet.insertRule('.z { color: red; }', 2)",
      ],
      [
        // Every rule deleted, others inserted.
        ...Array.from({ length: 7 }, () => 'sheet.deleteRule(0)'),
        "sheet.insertRule('.only { top: 0px; }')",
        "sheet.insertRule('.before { top: 0px; }')",
      ],
    ],
    [true, true, true]
  );
});

test('past the limit of pending changes: serialized anew', async () => {
  const css = Array.from({ length: 60 }, (_, i) => `.r${i} { top: ${i}px; }`).join('\n');
  await check(
    [
      Array.from({ length: 32 }, (_, i) => `sheet.cssRules[${i}].style.setProperty('left', '1px')`),
      Array.from({ length: 33 }, (_, i) => `sheet.cssRules[${i}].style.setProperty('left', '2px')`),
      Array.from({ length: 33 }, () => "sheet.insertRule('.n {}', 0)"),
    ],
    [true, false, false],
    css
  );
});

test('a sheet in the text it was written in: serialized anew when first changed, then in place', async () => {
  await check(
    [["sheet.cssRules[0].style.setProperty('color', 'green')"], ["sheet.insertRule('.n {}', 1)"]],
    [false, true],
    '.a{color:red}\n\n  .b { top: 1px }',
    true
  );
});

test('a rule changed once out of its sheet, and a new text: in place, then serialized anew', async () => {
  await check(
    [
      ["const r = sheet.cssRules[0]; sheet.deleteRule(0); r.style.setProperty('top', '1px')"],
      ["sheet.replaceSync('.q { top: 1px }  .r{}')", "sheet.cssRules[1].style.setProperty('top', '1px')"],
    ],
    [true, false]
  );
});

test('properties written by name: in a rule, nested, in @media, a keyframe, @page, @font-face', async () => {
  const css = [
    CSS,
    '@page :first { margin: 1px; }',
    '@font-face { font-family: f; src: local(x); }',
    '.f { color: red; & .g { top: 1px; } top: 2px; }',
  ].join('\n');
  await check(
    [
      ["sheet.cssRules[0].style.color = 'green'"],
      ["sheet.cssRules[6].style.marginTop = '3px'"],
      ["sheet.cssRules[2].cssRules[0].style.color = 'red'"],
      ["sheet.cssRules[1].cssRules[1].style.top = '5px'"],
      ["sheet.cssRules[3].cssRules[1].style.top = '8px'"],
      ["sheet.cssRules[7].style.marginLeft = '4px'"],
      ["sheet.cssRules[8].style.fontStyle = 'italic'"],
      // The declarations after a nested rule.
      ["sheet.cssRules[9].cssRules[1].style.left = '1px'"],
      // Read, and written the same: unchanged.
      ['void sheet.cssRules[0].style.color', "sheet.cssRules[4].style.padding = '1px 2px'"],
    ],
    [true, true, true, true, true, true, true, true, true],
    css
  );
});

test('properties written by name and through setProperty() in one round, a style kept for later', async () => {
  await check(
    [
      [
        "sheet.cssRules[0].style.color = 'green'",
        "sheet.cssRules[6].style.setProperty('left', '1px')",
        "sheet.cssRules[6].style.marginTop = '2px'",
        "sheet.insertRule('.x { top: 1px; }', 1)",
        "sheet.cssRules[1].style.left = '3px'",
        "sheet.cssRules[2].cssRules[0].style.marginLeft = '9px'",
        'sheet.deleteRule(0)',
      ],
      // Kept now, written in the rounds after (a rule and a keyframe).
      ['globalThis.kept = sheet.cssRules[2].style; globalThis.keptKey = sheet.cssRules[3].cssRules[0].style'],
      ["globalThis.kept.marginRight = '7px'", "globalThis.keptKey.top = '1px'"],
      ["globalThis.kept.marginRight = '8px'"],
    ],
    [true, true, true, true]
  );
});
