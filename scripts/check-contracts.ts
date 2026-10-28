// Checks that each contract literal is written in one source file only (`pnpm lint`, pre-commit).
//
// The strings the packages agree on (relay methods, shell mode's messages, storage keys, globals)
// carry a prefix of ours: `DevtoolsAnywhere.`, `devtools-anywhere:`, `devtools-anywhere-`,
// `__devtoolsAnywhere`. One spelled out in two files is two copies to keep in step by hand: it
// belongs in the file that owns it, which the others import from (DEV.md, "Where contracts
// live"). A lint rule could not tell: it sees one file at a time.
//
// Not checked: comments; tests (their literals stand in for a page, or guard a persisted format
// on purpose); names checked by the type checker against the contract, such as the probe
// script's data-* attributes (keyof ProbeScriptAttributes); and built file names, which the
// packages' exports and require.resolve check. Strings are found line by line with a regular
// expression, outside lines that start a comment: a block comment in the middle of a line is
// not recognized as one.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A string literal, or a template literal without substitutions, starting with a prefix of ours. */
const LITERAL = /(['"`])((?:DevtoolsAnywhere\.|devtools-anywhere[:-]|__devtoolsAnywhere)[^'"`\s$]*)\1/g;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'etc', 'test-support']);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.endsWith('.ignore')) sources(file, out);
    } else if (entry.name.endsWith('.ts') && !/\.(test|d)\.ts$/.test(entry.name)) {
      out.push(file);
    }
  }
  return out;
}

/** Each literal, and the files it is written in (relative to the root). */
const found = new Map<string, Set<string>>();
for (const file of sources(path.join(root, 'packages'))) {
  const rel = path.relative(root, file);
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(\/\/|\/?\*)/.test(line)) continue;
    for (const [, , value] of line.matchAll(LITERAL)) {
      if (value === undefined) continue;
      const files = found.get(value) ?? new Set();
      files.add(rel);
      found.set(value, files);
    }
  }
}

const repeated = [...found].filter(([, files]) => files.size > 1);
if (repeated.length > 0) {
  console.error('Contract literals written in more than one file:\n');
  for (const [value, files] of repeated) console.error(`  '${value}'\n${[...files].map(f => `    ${f}`).join('\n')}\n`);
  console.error(
    'Define each in the file that owns it and import it from there: relay messages in\n' +
      'packages/relay-core/src/protocol.ts, the frontend contract in\n' +
      'packages/devtools-anywhere/src/embedder.ts, shell mode messages in\n' +
      'packages/devtools-anywhere/src/shell-messages.ts (see "Where contracts live" in DEV.md).'
  );
  process.exit(1);
}
console.log(`Contract literals: ${found.size}, each written once.`);
