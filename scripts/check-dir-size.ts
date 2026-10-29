// Keeps directories to a number of files one can take in at a glance (pre-commit).
//
// Counts the files directly in each directory a commit adds files to, as staged. Past WARN_FILES
// it warns, and the next commit is to sort the directory into subdirectories by concern; past
// MAX_FILES it rejects the commit. Upstream files of the devtools-frontend checkout are not ours
// to sort, and are skipped.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const WARN_FILES = 20;
const MAX_FILES = 30;
const SKIP = /^(packages\/devtools-frontend\/(src|patches)\/|experiments\/)/;

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
const list = (...args: string[]) =>
  git(...args, '-z')
    .split('\0')
    .filter(Boolean);

const dirs = new Set(
  list('diff', '--cached', '--name-only', '--diff-filter=ACR')
    .filter(file => !SKIP.test(file))
    .map(file => path.posix.dirname(file))
);
if (dirs.size) {
  const counts = new Map<string, number>();
  for (const file of list('ls-files', '--cached')) {
    const dir = path.posix.dirname(file);
    if (dirs.has(dir)) counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }

  const warned: string[] = [];
  const rejected: string[] = [];
  for (const [dir, count] of counts) {
    if (count > MAX_FILES) rejected.push(`  ${dir}/: ${count} files`);
    else if (count > WARN_FILES) warned.push(`  ${dir}/: ${count} files`);
  }

  if (warned.length) {
    console.warn(
      `Warning: over ${WARN_FILES} files in a directory (the limit is ${MAX_FILES}):\n${warned.join('\n')}\n` +
        'Agent: make your next commit one that sorts these directories into subdirectories by concern, ' +
        'decoupling what does not belong together.'
    );
  }
  if (rejected.length) {
    console.error(
      `Error: over ${MAX_FILES} files in a directory, commit rejected:\n${rejected.join('\n')}\n` +
        'Sort these directories into subdirectories by concern before committing.'
    );
    process.exit(1);
  }
}
