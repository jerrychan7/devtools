// Brings html.css here in line with the Chrome devtools-anywhere is pinned to (the `chrome` field
// of packages/devtools-anywhere/package.json): run it whenever that field changes.
//   node scripts/sync-user-agent-css.ts [--check]
// --check only tells whether the copy is that version's, failing if not.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = path.join(root, 'packages/devtools-anywhere/package.json');
const here = path.join(root, 'packages/devtools-anywhere/src/cdp-agent/domains/css/user-agent');
const sheet = path.join(here, 'html.css');
const versionFile = path.join(here, 'CHROME_VERSION');

const chrome: unknown = JSON.parse(readFileSync(pkg, 'utf8')).chrome;
if (typeof chrome !== 'string') throw new Error(`No "chrome" version in ${pkg}`);
const have = readFileSync(versionFile, 'utf8').trim();

if (process.argv.includes('--check')) {
  if (have !== chrome) {
    console.error(`html.css is Chrome ${have}'s, the pinned Chrome is ${chrome}: run scripts/sync-user-agent-css.ts`);
    process.exit(1);
  }
  console.log(`html.css is Chrome ${chrome}'s.`);
} else {
  // Gitiles gives a file's raw content in base64.
  const url =
    `https://chromium.googlesource.com/chromium/src/+/refs/tags/${chrome}` +
    '/third_party/blink/renderer/core/html/resources/html.css?format=TEXT';
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  writeFileSync(sheet, Buffer.from(await response.text(), 'base64'));
  writeFileSync(versionFile, chrome + '\n');
  console.log(`html.css: Chrome ${have} → ${chrome}; update the link in ${path.relative(root, here)}/README.md`);
}
