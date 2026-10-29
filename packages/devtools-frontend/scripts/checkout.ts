// The devtools-frontend checkout and how it compares with what the build makes of it: REVISION
// plus every patch in ../patches. Shared by build.ts and check-checkout.ts (the pre-commit gate).
//
// Environment:
//   DEVTOOLS_FRONTEND_SRC  checkout of devtools-frontend (`fetch devtools-frontend`)
//                          default: <repo>/devtools-frontend.ignore/devtools-frontend
//   DEPOT_TOOLS            depot_tools directory, default: <repo>/depot_tools.ignore

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repo = path.resolve(pkg, '../..');
export const src = path.resolve(
  process.env['DEVTOOLS_FRONTEND_SRC'] ?? path.join(repo, 'devtools-frontend.ignore/devtools-frontend')
);
const depotTools = path.resolve(process.env['DEPOT_TOOLS'] ?? path.join(repo, 'depot_tools.ignore'));
// A git hook runs with variables that point git at this repository (a commit with paths passes
// its own index in GIT_INDEX_FILE): left in, git in the checkout would read and write ours.
const OUR_REPOSITORY = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
];
export const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !OUR_REPOSITORY.includes(name))),
  PATH: `${depotTools}${path.delimiter}${process.env['PATH']}`,
  DEPOT_TOOLS_UPDATE: '0',
};
/** Runs a command in the checkout and returns its output; its errors go into the exception, not to the terminal. */
export const read = (cmd: string, argv: string[]) =>
  execFileSync(cmd, argv, { cwd: src, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export const hasCheckout = () => fs.existsSync(path.join(src, '.git'));

export const patches = fs
  .readdirSync(path.join(pkg, 'patches'))
  .filter(f => f.endsWith('.patch'))
  .sort()
  .map(f => path.join(pkg, 'patches', f));

/** Upstream files that differ from HEAD (staged or not; untracked files are ours, copied in). */
export const changed = () => read('git', ['diff', 'HEAD', '--name-only']).split('\n').filter(Boolean);

/**
 * Upstream files where the checkout differs from HEAD plus every patch (compared with a scratch
 * index built that way), or null if the patches do not apply to HEAD.
 */
export function unexpectedEdits(): string[] | null {
  const index = path.join(src, '.git', 'anywhere-expected-index');
  const scratch = { ...env, GIT_INDEX_FILE: index };
  try {
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: src, env: scratch, stdio: 'ignore' });
    for (const patch of patches)
      execFileSync('git', ['apply', '--cached', patch], { cwd: src, env: scratch, stdio: 'ignore' });
    const patched = read('git', ['apply', '--numstat', ...patches])
      .split('\n')
      .map(line => line.split('\t')[2] ?? '')
      .filter(Boolean);
    const paths = [...new Set([...changed(), ...patched])];
    if (paths.length === 0) return [];
    const differ = execFileSync('git', ['diff', '--name-only', '--', ...paths], {
      cwd: src,
      env: scratch,
      encoding: 'utf8',
    });
    return differ.split('\n').filter(Boolean);
  } catch {
    return null;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/**
 * Upstream files the checkout has edits in that no patch holds: they differ both from HEAD and
 * from what the patches make of it (a file still as in HEAD only lacks its patch). Null if the
 * patches do not apply to HEAD.
 */
export function editsWithoutPatch(): string[] | null {
  const unexpected = unexpectedEdits();
  if (unexpected === null) return null;
  const edited = changed();
  return unexpected.filter(file => edited.includes(file));
}

/** The patches each file is touched by. */
export function patchesByFile(): Map<string, string[]> {
  const files = new Map<string, string[]>();
  for (const patch of patches) {
    for (const line of read('git', ['apply', '--numstat', patch]).split('\n')) {
      const file = line.split('\t')[2];
      if (file) files.set(file, [...(files.get(file) ?? []), patch]);
    }
  }
  return files;
}

/** The patches that do not apply to HEAD on their own. */
export function failingPatches(): string[] {
  const index = path.join(src, '.git', 'anywhere-check-index');
  const scratch = { ...env, GIT_INDEX_FILE: index };
  try {
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: src, env: scratch, stdio: 'ignore' });
    return patches.filter(patch => {
      try {
        execFileSync('git', ['apply', '--cached', '--check', patch], { cwd: src, env: scratch, stdio: 'ignore' });
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    fs.rmSync(index, { force: true });
  }
}
