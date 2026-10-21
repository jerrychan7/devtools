// Builds the DevTools frontend from the official devtools-frontend sources:
//   checks out the pinned revision, applies the patches, adds the anywhere_app entrypoint,
//   builds with gn + autoninja, and bundles the release files into dist/ (scripts/bundle.ts; the
//   locales beyond en-US and zh go to ../devtools-frontend-locales/dist/).
//
// Environment:
//   DEVTOOLS_FRONTEND_SRC  checkout of devtools-frontend (`fetch devtools-frontend`)
//                          default: <repo>/devtools-frontend.ignore/devtools-frontend
//   DEPOT_TOOLS            depot_tools directory, default: <repo>/depot_tools.ignore
//
// Flags:
//   --latest     build the tip of origin/main instead of REVISION, and pin it on success
//                (with --no-sync: pin the checkout's HEAD)
//   --no-sync    skip `git checkout` + `gclient sync` (iterate on a prepared checkout): builds
//                and labels the checkout's HEAD, whatever REVISION says
//   --reset      discard edits to upstream files in the checkout that the patches do not
//                account for, instead of stopping (see "Patches" below)
//   --copy-only  implies --no-sync and also skips the build: only bundle the last build's
//                output into dist/
//
// locales/<locale>.json translates anywhere_app's own UI strings (keys of its UIStrings),
// which upstream's translations do not have; other locales show them in English.

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './bundle.ts';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(pkg, '../..');
const src = path.resolve(
  process.env['DEVTOOLS_FRONTEND_SRC'] ?? path.join(repo, 'devtools-frontend.ignore/devtools-frontend')
);
const depotTools = path.resolve(process.env['DEPOT_TOOLS'] ?? path.join(repo, 'depot_tools.ignore'));
const out = path.join(src, 'out/Anywhere');
const dist = path.join(pkg, 'dist');
/** The release files anywhere_app can load, one bundle per module, before bundle.ts. */
const release = path.join(out, 'release');
/** The locales Chrome bundles stay in this package; the others go to the locales package. */
const localesDist = path.join(pkg, '../devtools-frontend-locales/dist');
const BUNDLED_LOCALES = ['en-US', 'zh'];
const revisionFile = path.join(pkg, 'REVISION');

const args = new Set(process.argv.slice(2));
/** --copy-only reuses the last build, so syncing (or moving to --latest) would mislabel it. */
const noSync = args.has('--no-sync') || args.has('--copy-only');
const env = { ...process.env, PATH: `${depotTools}${path.delimiter}${process.env['PATH']}`, DEPOT_TOOLS_UPDATE: '0' };
const run = (cmd: string, argv: string[], opts: ExecFileSyncOptions = {}) =>
  execFileSync(cmd, argv, { cwd: src, env, stdio: 'inherit', ...opts });
const read = (cmd: string, argv: string[]) => execFileSync(cmd, argv, { cwd: src, env, encoding: 'utf8' }).trim();

if (!fs.existsSync(path.join(src, '.git'))) {
  console.error(`No devtools-frontend checkout at ${src}. Run \`fetch devtools-frontend\` (depot_tools) first.`);
  process.exit(1);
}

let revision = fs.readFileSync(revisionFile, 'utf8').trim();
if (noSync) {
  // What is built is the checkout as it stands, e.g. upstream's tip left by a failed --latest.
  const head = read('git', ['rev-parse', 'HEAD']);
  if (head !== revision && !args.has('--latest'))
    console.warn(`The checkout is at ${head}, not REVISION ${revision}: add --latest to pin it.`);
  revision = head;
} else {
  run('git', ['fetch', 'origin', 'main']);
  if (args.has('--latest')) revision = read('git', ['rev-parse', 'origin/main']);
  run('git', ['checkout', '--force', '--detach', revision]);
  run('git', ['clean', '-fd', 'front_end']);
  run('gclient', ['sync', '--force', '--delete_unversioned_trees'], { cwd: path.dirname(src) });
}

// Patches: small edits to upstream files, kept as reviewable diffs. The checkout must end up
// as exactly REVISION plus every patch, so that a build depends on nothing else: a patch that
// was removed or changed must not linger. Edits made in the checkout to write a patch are not
// thrown away silently, though: if the checkout holds changes the patches do not account for,
// the build stops, unless --reset is given.
const patches = fs
  .readdirSync(path.join(pkg, 'patches'))
  .filter(f => f.endsWith('.patch'))
  .sort()
  .map(f => path.join(pkg, 'patches', f));
/** Upstream files that differ from HEAD (staged or not; untracked files are ours, copied below). */
const changed = () => read('git', ['diff', 'HEAD', '--name-only']).split('\n').filter(Boolean);
/**
 * Upstream files where the checkout differs from HEAD plus every patch (compared with a scratch
 * index built that way), or null if the patches do not apply to HEAD.
 */
function unexpectedEdits(): string[] | null {
  const index = path.join(src, '.git', 'anywhere-expected-index');
  const scratch = { ...env, GIT_INDEX_FILE: index };
  try {
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: src, env: scratch });
    for (const patch of patches) execFileSync('git', ['apply', '--cached', patch], { cwd: src, env: scratch });
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
const unexpected = unexpectedEdits();
if (unexpected === null) throw new Error('The patches do not apply to REVISION: regenerate them (see DEV.md).');
if (unexpected.length > 0) {
  // A file still as in HEAD only lacks its patch. One that differs from both holds edits not in
  // a patch yet, or an outdated or removed patch: they could be work in progress, so ask first.
  const edited = unexpected.filter(file => changed().includes(file));
  if (!args.has('--reset') && edited.length > 0) {
    console.error(
      `The checkout has edits the patches do not account for:\n  ${edited.join('\n  ')}\n` +
        'Regenerate the patch from them (see DEV.md), or run with --reset to discard them.'
    );
    process.exit(1);
  }
  console.log('Reapplying the patches to REVISION');
  run('git', ['reset', '--quiet']);
  const dirty = changed();
  if (dirty.length > 0) run('git', ['checkout', 'HEAD', '--', ...dirty]);
  for (const patch of patches) {
    console.log(`Applying ${path.basename(patch)}`);
    run('git', ['apply', patch]);
  }
}

// Our own sources are copied, not patched in; the old copy goes first, so that a file removed
// from src/ does not stay behind.
fs.rmSync(path.join(src, 'front_end/entrypoints/anywhere_app'), { recursive: true, force: true });
fs.cpSync(path.join(pkg, 'src'), path.join(src, 'front_end/entrypoints'), { recursive: true });

if (!args.has('--copy-only')) {
  run('gn', ['gen', out, '--args=is_debug=false']);
  run('autoninja', ['-C', out]);
}

// The release files (the ones Chrome ships, listed in devtools_resources.grd) serve every
// DevTools app. Only what anywhere_app can load is kept: the modules reachable from its
// entrypoint through imports and `new URL(…, import.meta.url)`, the assets next to them,
// and the UI strings of those modules.
const gen = path.join(out, 'gen/front_end');
const grd = fs.readFileSync(path.join(gen, 'devtools_resources.grd'), 'utf8');
const files = [...grd.matchAll(/<include [^>]*file="([^"]+)"/g)]
  .flatMap(([, file]) => (file ? [file.replace(/\.compressed$/, '')] : []))
  .filter(file => fs.existsSync(path.join(gen, file)));
const released = new Set(files);

const reachable = new Set<string>();
const queue = ['entrypoints/anywhere_app/anywhere_app.js'];
for (let file; (file = queue.pop());) {
  if (reachable.has(file) || !released.has(file)) continue;
  reachable.add(file);
  const code = fs.readFileSync(path.join(gen, file), 'utf8');
  for (const [, spec] of code.matchAll(/["'`](\.{1,2}\/[^"'`\s]*?\.js)["'`]/g)) {
    if (spec) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
  }
}
const moduleDirs = new Set([...reachable].map(file => path.posix.dirname(file)));
const inModule = (file: string) => {
  for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) {
    if (moduleDirs.has(dir)) return true;
  }
  return false;
};
const LOCALES = 'core/i18n/locales/';
/** UI strings anywhere_app borrows from modules it does not include. */
const BORROWED_STRINGS = ['panels/browser_debugger/browser_debugger-meta.ts'];
/** The file anywhere_app's own UI strings are registered under. */
const OWN_STRINGS = 'entrypoints/anywhere_app/anywhere_app.ts';
// Both are the paths anywhere_app registers its strings under: if they drift apart, the strings
// would be dropped below and every locale would show English.
{
  const source = fs.readFileSync(path.join(pkg, 'src/anywhere_app/anywhere_app.ts'), 'utf8');
  for (const file of [...BORROWED_STRINGS, OWN_STRINGS]) {
    if (!source.includes(`registerUIStrings('${file}'`)) {
      throw new Error(`anywhere_app.ts does not register UI strings under ${file}: update build.ts`);
    }
  }
}
const keep = (file: string) => {
  if (file.endsWith('.js')) return reachable.has(file);
  if (file.endsWith('.html')) return file === 'anywhere_app.html';
  if (file.startsWith(LOCALES)) return false; // written below
  return !file.includes('/') || file.startsWith('Images/') || inModule(file);
};

fs.rmSync(release, { recursive: true, force: true });
const copy = (file: string) => {
  fs.mkdirSync(path.dirname(path.join(release, file)), { recursive: true });
  fs.copyFileSync(path.join(gen, file), path.join(release, file));
};
const kept = files.filter(keep);
kept.forEach(file => copy(file));

// Every translated locale, minus the strings of modules that are not included. Chrome bundles
// en-US and zh and fetches the others from its own servers; here the others go to
// @devtools-anywhere/devtools-frontend-locales, at the same paths, so that the two packages
// can be served from one directory. A missing locale falls back to en-US.
fs.rmSync(localesDist, { recursive: true, force: true });
for (const name of fs.readdirSync(path.join(gen, LOCALES)).filter(f => f.endsWith('.json'))) {
  const strings = JSON.parse(fs.readFileSync(path.join(gen, LOCALES, name), 'utf8'));
  const used = Object.fromEntries(
    Object.entries(strings).filter(([key]) => {
      const file = key.split(' | ')[0] ?? '';
      return inModule(file) || BORROWED_STRINGS.includes(file);
    })
  );
  // anywhere_app's own strings, which upstream does not translate (locales/<locale>.json).
  const own = path.join(pkg, 'locales', name);
  if (fs.existsSync(own)) {
    for (const [key, message] of Object.entries(JSON.parse(fs.readFileSync(own, 'utf8')))) {
      used[`${OWN_STRINGS} | ${key}`] = { message };
    }
  }
  const target = BUNDLED_LOCALES.includes(name.slice(0, -'.json'.length)) ? release : localesDist;
  fs.mkdirSync(path.join(target, LOCALES), { recursive: true });
  fs.writeFileSync(path.join(target, LOCALES, name), JSON.stringify(used));
}
fs.writeFileSync(path.join(localesDist, 'REVISION'), revision + '\n');

fs.writeFileSync(path.join(release, 'REVISION'), revision + '\n');
// Which third_party libraries end up in dist/, for scripts/third-party-licenses.ts. Next to
// dist/ rather than in it: it is not part of the package.
const thirdParty = await bundle(release, dist);
fs.writeFileSync(path.join(pkg, 'dist-third-party.ignore.json'), JSON.stringify(thirdParty, null, 2) + '\n');
if (args.has('--latest')) fs.writeFileSync(revisionFile, revision + '\n');
console.log(
  `Built devtools-frontend ${revision} → ${path.relative(repo, dist)} (${kept.length} of ${files.length} files, ` +
    `bundled into ${fs.readdirSync(path.join(dist, 'bundle')).length})`
);
