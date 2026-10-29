// Keeps source files to a size one can read through (pre-commit, and `pnpm lint` with `--all`).
//
// Checks the staged content of the files a commit adds or changes; with `--all`, of every file in
// the index, so a commit that skipped the hook is caught too. Past WARN_LINES it warns, and
// the next commit is to split or restructure the file; past MAX_LINES it rejects the commit.
// Upstream files of the devtools-frontend checkout are not ours to split, and are skipped.
import { execFileSync } from 'node:child_process';

const WARN_LINES = 1100;
const MAX_LINES = 1500;
const SOURCE = /\.(ts|mts|cts|js|mjs|cjs)$/;
const SKIP = /^(packages\/devtools-frontend\/(src|patches)\/|experiments\/)/;

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });

const all = process.argv.includes('--all');
const staged = (
  all ? git('ls-files', '--cached', '-z') : git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z')
)
  .split('\0')
  .filter(file => file && SOURCE.test(file) && !SKIP.test(file));

const warned: string[] = [];
const rejected: string[] = [];
for (const file of staged) {
  const text = git('show', `:${file}`);
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines > MAX_LINES) rejected.push(`  ${file}: ${lines} lines`);
  else if (lines > WARN_LINES) warned.push(`  ${file}: ${lines} lines`);
}

if (warned.length) {
  console.warn(
    `Warning: over ${WARN_LINES} lines (the limit is ${MAX_LINES}):\n${warned.join('\n')}\n` +
      'Agent: make your next commit one that splits or restructures these files.'
  );
}
if (rejected.length) {
  console.error(
    `Error: over ${MAX_LINES} lines, commit rejected:\n${rejected.join('\n')}\n` +
      'Split or restructure these files before committing.'
  );
  process.exit(1);
}
