/**
 * Declarations edited one after another in a large sheet, as CSS.setStyleTexts does
 * (../../text/splice.ts `respliced`), in headless Chrome (puppeteer-core, the installed Chrome):
 *
 *   node splice.bench.ts [--rev <git revision>]... [--rules <n>] [--edits <n>] [--warmup <n>]
 *
 * For each sheet (flat, wrapped in one @media, in @layer and @media) and each splice.ts (the
 * working tree's, then each `--rev`'s, bundled with the working tree's other modules), the sheet is
 * paired once, then `--warmup` declarations spread over it are edited unmeasured and `--edits`
 * more measured, each in the CSSOM and then in the source, whose text is checked after each.
 *
 * Reports the total time of the measured edits, giving up (`respliced` returning null) included
 * with what it costs, the text paired anew (`pair`) as SheetTexts does once it is next used; that
 * total per edit; how many edits returned null; and the median and 90th percentile of one `respliced`
 * call. An edit changes the source, so it cannot be repeated to time it more finely: the total is
 * the figure to compare, the per-call ones are at Chrome's timer resolution here (0.1 ms).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { showAt } from './load-lexer.ts';
import { cacheDir } from './materials.ts';

const { values } = parseArgs({
  options: {
    rev: { type: 'string', multiple: true, default: [] },
    rules: { type: 'string', default: '20000' },
    edits: { type: 'string', default: '200' },
    warmup: { type: 'string', default: '20' },
  },
});
const RULES = Number(values.rules);
const EDITS = Number(values.edits);
const WARMUP = Number(values.warmup);
if (!(RULES >= 10 && EDITS >= 1 && WARMUP >= 0)) throw new Error('--rules wants 10 or more, --edits 1 or more');

const here = fileURLToPath(new URL('.', import.meta.url));
const splicePath = fileURLToPath(new URL('../../text/splice.ts', import.meta.url));
const ENTRY = "export { respliced } from '../../text/splice';\nexport { pair } from '../../text/pair';";

const { build } = await import('esbuild');
mkdirSync(cacheDir, { recursive: true });
/** The bundle with splice.ts as it is at `rev`, or in the working tree. */
async function bundle(rev: string | undefined): Promise<string> {
  const outfile = `${cacheDir}splice-${rev ? rev.replace(/[^\w.-]/g, '_') : 'worktree'}.iife.js`;
  await build({
    stdin: { contents: ENTRY, resolveDir: here, loader: 'ts' },
    bundle: true,
    format: 'iife',
    globalName: '__B',
    platform: 'browser',
    outfile,
    logLevel: 'error',
    plugins: rev
      ? [
          {
            name: 'splice-at-rev',
            setup(b) {
              b.onLoad({ filter: /[\\/]splice\.ts$/ }, args =>
                args.path === splicePath ? { contents: showAt(rev, splicePath), loader: 'ts' } : undefined
              );
            },
          },
        ]
      : [],
  });
  return readFileSync(outfile, 'utf8');
}

const body = Array.from({ length: RULES }, (_, i) => `.w${i} { color: red; top: ${i}px }`);
const SHEETS: [string, string][] = [
  ['flat', `${body.join('\n')}\n`],
  ['@media', `@media screen {\n${body.map(r => `  ${r}`).join('\n')}\n}\n`],
  ['@layer @media', `@layer base {\n  @media screen {\n${body.map(r => `    ${r}`).join('\n')}\n  }\n}\n`],
];

interface Result {
  median: number;
  p90: number;
  nulls: number;
  total: number;
}

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const out = [
  `${RULES} rules, ${EDITS} edits after ${WARMUP} unmeasured; Node ${process.version}, ${await browser.version()}`,
  '| Sheet | splice.ts | total ms | ms per edit | returned null | median ms | p90 ms |',
  '| --- | --- | --: | --: | --: | --: | --: |',
];
for (const rev of [undefined, ...values.rev]) {
  const code = await bundle(rev);
  for (const [name, text] of SHEETS) {
    const page = await browser.newPage();
    await page.evaluate(`${code};globalThis.__B = __B;`);
    const r = (await page.evaluate(
      (text: string, rules: number, edits: number, warmup: number) => {
        type B = {
          respliced: (s: unknown, start: number, end: number, insert: string) => unknown;
          pair: (text: string, rules: CSSRule[]) => { text: string } | null;
        };
        const B = (globalThis as unknown as { __B: B }).__B;
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        let styleRules: CSSRule[] = [...sheet.cssRules];
        while (styleRules.length === 1 && 'cssRules' in (styleRules[0] as CSSRule))
          styleRules = [...(styleRules[0] as CSSGroupingRule).cssRules];
        type Source = { text: string };
        const first = B.pair(text, [...sheet.cssRules]);
        if (!first) throw new Error('the sheet did not pair');
        let source: Source = first;
        const times: number[] = [];
        const repaired: number[] = [];
        let nulls = 0;
        for (let e = 0; e < warmup + edits; e++) {
          // Spread over the sheet, each declaration edited in turn to a longer, then shorter value.
          const i = (e * 7919) % rules;
          const color = e % 2 ? 'red' : 'navy';
          const was = source.text;
          const at = was.indexOf(`.w${i} { color: `) + `.w${i} { color: `.length;
          const end = was.indexOf(';', at);
          const want = was.slice(0, at) + color + was.slice(end);
          (styleRules[i] as CSSStyleRule).style.setProperty('color', color);
          const a = performance.now();
          let next = B.respliced(source, at, end, color) as Source | null;
          const b = performance.now();
          if (!next) {
            if (e >= warmup) nulls++;
            next = B.pair(want, [...sheet.cssRules]);
            if (!next) throw new Error('the edited sheet did not pair');
          }
          const c = performance.now();
          if (next.text !== want) throw new Error(`edit ${e}: the text is not the one edited`);
          if (e >= warmup) {
            times.push(b - a);
            repaired.push(c - a);
          }
          source = next;
        }
        const median = (t: number[]) => [...t].sort((x, y) => x - y)[t.length >> 1] as number;
        const sorted = [...times].sort((x, y) => x - y);
        return {
          median: median(times),
          p90: sorted[Math.floor(sorted.length * 0.9)] as number,
          nulls,
          total: repaired.reduce((x, y) => x + y, 0),
        };
      },
      text,
      RULES,
      EDITS,
      WARMUP
    )) as Result;
    await page.close();
    out.push(
      `| ${name} | ${rev ?? 'worktree'} | ${r.total.toFixed(1)} | ${(r.total / EDITS).toFixed(3)} | ${r.nulls} | ${r.median.toFixed(1)} | ${r.p90.toFixed(1)} |`
    );
  }
}
console.log(out.join('\n'));
await browser.close();
