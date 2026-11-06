// sheet-text.ts in Chrome: a sheet given a new text (`retext`, as CSS.setStyleSheetText does)
// changes only the top-level rules whose text changed, and must give what replacing its text and
// pairing it anew gives: the same rules, the same text, and each rule at the same offsets. Here
// with what the CSSOM has no rule for (@charset, CDO and CDC, invalid rules, bad strings) around
// the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { build } from 'esbuild';
import { launch, setUpAndTearDown } from '../../../../../../test-support/conformance.ts';
import type { Env } from '../../../../../../test-support/conformance.ts';

const bundled = await build({
  stdin: {
    contents: [
      "export { SheetTexts } from './sheet-text.ts';",
      "export { ruleObject } from '../parse/css-outline.ts';",
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

interface Round {
  /** retext() changed the rules in place. */
  retexted: boolean;
  /** How many of the rules before are still in the sheet. */
  kept: number;
  /** How many top-level rules there were before. */
  rules: number;
  /** The CSSOM and the source, then those of the text replaced and paired anew. */
  got: string;
  want: string;
}

/** Gives a sheet of `css` each text in turn, comparing it with the text replaced and paired anew. */
async function run(css: string, texts: string[]): Promise<Round[]> {
  return page.evaluate(
    (css, texts) => {
      type Source = { text: string; lines: number[]; outline: unknown; nodes: Map<CSSRule, number> };
      type Texts = {
        set(s: CSSStyleSheet, t: string): void;
        source(s: CSSStyleSheet, f: (s: CSSStyleSheet) => CSSRule[]): Source | null;
        retext(s: CSSStyleSheet, t: string, f: (s: CSSStyleSheet) => CSSRule[]): boolean;
      };
      const m = (globalThis as unknown as { __sheetText: unknown }).__sheetText as {
        SheetTexts: new () => Texts;
        ruleObject(text: string, o: unknown, r: number): unknown;
      };
      const rulesOf = (s: CSSStyleSheet) => Array.from(s.cssRules);
      const shown = (sheet: CSSStyleSheet, source: Source | null) => {
        if (!source) return 'null';
        const rules: unknown[] = [];
        const walk = (list: CSSRuleList, at: string) =>
          Array.from(list).forEach((rule, i) => {
            const node = source.nodes.get(rule);
            const object = node === undefined ? null : m.ruleObject(source.text, source.outline, node);
            rules.push([`${at}${i}`, rule.cssText, object]);
            if ('cssRules' in rule) walk(rule.cssRules as CSSRuleList, `${at}${i}.`);
          });
        walk(sheet.cssRules, '');
        return JSON.stringify({ text: source.text, lines: source.lines, rules }, null, 1);
      };
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      const store = new m.SheetTexts();
      store.set(sheet, css);
      store.source(sheet, rulesOf);
      return texts.map(text => {
        const before = rulesOf(sheet);
        const retexted = store.retext(sheet, text, rulesOf);
        if (!retexted) {
          sheet.replaceSync(text);
          store.set(sheet, text);
        }
        const after = rulesOf(sheet);
        const got = shown(sheet, store.source(sheet, rulesOf));
        const fresh = new CSSStyleSheet();
        fresh.replaceSync(text);
        const anew = new m.SheetTexts();
        anew.set(sheet, text);
        const want = shown(sheet, anew.source(sheet, rulesOf));
        const same =
          rulesOf(fresh)
            .map(r => r.cssText)
            .join('\n') === after.map(r => r.cssText).join('\n');
        return {
          retexted,
          kept: before.filter(r => after.includes(r)).length,
          rules: before.length,
          got,
          want: same ? want : 'CSSOM differs',
        };
      });
    },
    css,
    texts
  );
}

/** What the CSSOM has no rule for around three rules, three times, as in the bench's `mixed`. */
const unit = (i: number) =>
  `@charset "utf-8";\n<!-- .a\\31 b${i} { content: "q\\"uo\\\nte"; } -->\n.é\\E9 x${i}{background:url( a\\(b.png ) ;b:url(bad"x)}\n` +
  `/* ★ */#\\31 23${i}{width:1.5e3px;height:-.5em}\n--var:{a};@-moz-x u+1?? ;"bad\nstr" 'unterminated\n\u0000 😀 \r\n\f\t!important\\\n.n${i}{x:${i}}\n`;
const MIXED = [0, 1, 2].map(unit).join('');
const JUNK = `--var:{a};@-moz-x u+1?? ;"bad\nstr" 'unterminated\n\u0000 😀 \r\n\f\t!important\\\n.n1{x:1}\n`;

/** Each text given to a sheet of MIXED, then back to MIXED: in place, as replacing it gives. */
async function check(cases: [text: string, kept: number][]) {
  const texts = cases.flatMap(([text]) => [text, MIXED]);
  const rounds = await run(MIXED, texts);
  rounds.forEach((r, i) => {
    const text = texts[i] as string;
    assert.equal(r.got, r.want, JSON.stringify(text));
    assert.ok(r.retexted, JSON.stringify(text));
    if (i % 2 === 0) assert.equal(r.kept, (cases[i / 2] as [string, number])[1], JSON.stringify(text));
  });
}

test('a rule changed next to what has no rule: first, in the middle, last', async () => {
  await check([
    [MIXED.replace('#\\31 230{width:1.5e3px', '#\\31 230{width:2px'), 8],
    [MIXED.replace('#\\31 231{width:1.5e3px', '#\\31 231{width:7px'), 8],
    [MIXED.replace('.a\\31 b1 { content', '.a\\31 b1 { color: red; content'), 8],
    [MIXED.replace('x1{background', 'x1{top:0;background'), 8],
    [MIXED.replace('.a\\31 b0 { content', '.a\\31 b0 { top: 0; content'), 8],
    [MIXED.replace('#\\31 232{width:1.5e3px', '#\\31 232{width:3px'), 8],
  ]);
});

test('@charset, CDO and CDC, bad strings and invalid rules added, removed and changed', async () => {
  await check([
    [MIXED.replace('@charset "utf-8";\n<!-- .a\\31 b1', '<!-- .a\\31 b1'), 9],
    [MIXED.replace('/* ★ */#\\31 231', '@charset "x";\n@charset "y";\n#\\31 231'), 9],
    [MIXED.replace('@charset "utf-8"', '@charset "latin1"'), 9],
    [MIXED.replace('/* ★ */#\\31 231', '<!-- --> <!--\n#\\31 231'), 9],
    [MIXED.replace(' -->\n.é\\E9 x1', '\n.é\\E9 x1'), 9],
    [MIXED.replace('/* ★ */#\\31 231', '"bad\nstr" ;\n:::x{top:0}\n@nope;\n#\\31 231'), 9],
    [MIXED.replace(JUNK, ''), 9],
    [MIXED.replace('.n2{x:2}', '.n2{x:3}'), 9],
    [MIXED.replace('.n0{x:0}', '.n0{x:0} --w:{b}'), 9],
    [`<!-- ${MIXED}`, 9],
    [`${MIXED}-->`, 9],
    [`--top:{x}\n${MIXED}`, 9],
  ]);
});

test('rules added and removed among what has no rule', async () => {
  await check([
    // After `--var:{a};`: part of the invalid rule the `;` starts.
    [MIXED.replace('.n1{x:1}\n', '.n1{x:1}\n.v{top:1px}\n'), 9],
    [MIXED.replace('@charset "utf-8";\n<!-- .a\\31 b1', '@charset "utf-8";\n.v{top:1px}\n<!-- .a\\31 b1'), 9],
    [MIXED.replace('/* ★ */#\\31 231', '/* ★ */.v{top:1px}\n@charset "x";\n.w{top:2px}\n#\\31 231'), 9],
    [MIXED.replace('/* ★ */#\\31 231{width:1.5e3px;height:-.5em}\n--var:{a};', '--var:{a};'), 8],
    [MIXED.replace(`#\\31 231{width:1.5e3px;height:-.5em}\n${JUNK}`, ''), 8],
  ]);
});

test('edits one after another, without going back', async () => {
  const texts: string[] = [];
  let text = MIXED;
  for (let i = 0; i < 12; i++) {
    text =
      i % 3 === 0
        ? text
            .replace(`x${(i / 3) % 3}{background`, `x${(i / 3) % 3}{top:${i}px;background`)
            .replace('1.5e3px', `${i}px`)
        : i % 3 === 1
          ? text.replace('/* ★ */', `@charset "${i}";\n.v${i}{top:${i}px}\n"bad${i}\n`)
          : text.replace('<!-- ', '');
    texts.push(text);
  }
  (await run(MIXED, texts)).forEach((r, i) => {
    assert.equal(r.got, r.want);
    assert.ok(r.retexted);
    // Dropping a CDO changes no rule; the other edits change, add or end up to two.
    if (i % 3 === 2) assert.equal(r.kept, r.rules, `${i}`);
    else assert.ok(r.kept >= r.rules - 2, `${i}: ${r.kept} of ${r.rules}`);
  });
});

test('many comments before what has no rule: in linear time', async () => {
  // The comments between two rules, then an @charset: each split of them tried, they took
  // seconds (24 comments, 3 s).
  const css = `.a{top:1px}\n${'/**/ '.repeat(40)}@charset "x";\n.b{top:2px}\n`;
  const started = Date.now();
  const [r] = await run(css, [css.replace('top:1px', 'top:3px')]);
  assert.ok(Date.now() - started < 2000);
  assert.equal(r?.got, r?.want);
  assert.equal(r?.kept, 1);
});
