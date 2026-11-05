// Keeps the CDP agent from depending more on the top page's realm (`pnpm lint`).
//
// A same-origin iframe's nodes are not instances of the top page's `Element`, `Node`, …, and
// their document is not the global `document` (docs/roadmap.md, "iframes"). New code checks
// node types and uses the node's own window (cdp-agent/core/realm.ts, core/frames/frames.ts) instead.
// The uses already there are counted per file in scripts/check-realms.json: a file may have
// fewer, not more. Run with `--update` after removing some, to lower the counts.
//
// Found line by line with regular expressions, outside lines that start a comment.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = path.join(root, 'packages/devtools-anywhere/src/cdp-agent');
const baselineFile = path.join(root, 'scripts/check-realms.json');
const PATTERNS = [
  /\binstanceof\s+(Node|Element|(HTML|SVG)\w*Element|Document|DocumentFragment|ShadowRoot|Text|Comment|CharacterData|Attr|Window)\b/g,
  /(?<![.\w$])(document|window|getComputedStyle)\b(?!\s*:)/g,
];
/** Where the top page's realm is meant. */
const EXEMPT = new Set(['core/realm.ts', 'core/frames/frames.ts']);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(file, out);
    else if (entry.name.endsWith('.ts') && !/\.(test|d)\.ts$/.test(entry.name)) out.push(file);
  }
  return out;
}

const counts: Record<string, number> = {};
for (const file of sources(agent)) {
  const rel = path.relative(agent, file).split(path.sep).join('/');
  if (EXEMPT.has(rel)) continue;
  let count = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(\/\/|\/?\*)/.test(line)) continue;
    for (const pattern of PATTERNS) count += line.match(pattern)?.length ?? 0;
  }
  if (count) counts[rel] = count;
}

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselineFile, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Realm uses: ${Object.values(counts).reduce((a, b) => a + b, 0)}, written to scripts/check-realms.json.`);
  process.exit(0);
}

const baseline: Record<string, number> = JSON.parse(readFileSync(baselineFile, 'utf8'));
const over = Object.entries(counts).filter(([file, count]) => count > (baseline[file] ?? 0));
if (over.length) {
  console.error("More uses of the top page's realm than in scripts/check-realms.json:\n");
  for (const [file, count] of over) console.error(`  cdp-agent/${file}: ${count}, was ${baseline[file] ?? 0}`);
  console.error(
    "\nUse the node's own realm instead of `instanceof Element`, the global `document`, … " +
      '(cdp-agent/core/realm.ts). Where the top page is meant, say so and run\n' +
      '`node scripts/check-realms.ts --update`.'
  );
  process.exit(1);
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);
const allowed = Object.values(baseline).reduce((a, b) => a + b, 0);
console.log(
  `Realm uses: ${total}${total < allowed ? `, down from ${allowed}: run with --update to lower the counts` : ''}.`
);
