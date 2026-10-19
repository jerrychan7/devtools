// Builds the DevTools frontend from the official devtools-frontend sources:
//   checks out the pinned revision, applies the patches, adds the anywhere_app entrypoint,
//   builds with gn + autoninja and copies the release files to dist/ (and the locales
//   beyond en-US and zh to ../devtools-frontend-locales/dist/).
//
// Environment:
//   DEVTOOLS_FRONTEND_SRC  checkout of devtools-frontend (`fetch devtools-frontend`)
//                          default: <repo>/devtools-frontend.ignore/devtools-frontend
//   DEPOT_TOOLS            depot_tools directory, default: <repo>/depot_tools.ignore
//
// Flags:
//   --latest     build the tip of origin/main instead of REVISION, and pin it on success
//   --no-sync    skip `git checkout` + `gclient sync` (iterate on a prepared checkout)
//   --copy-only  implies --no-sync and also skips the build: only copy the last build's
//                output to dist/
//
// locales/<locale>.json translates anywhere_app's own UI strings (keys of its UIStrings),
// which upstream's translations do not have; other locales show them in English.

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(pkg, '../..');
const src = path.resolve(
  process.env['DEVTOOLS_FRONTEND_SRC'] ?? path.join(repo, 'devtools-frontend.ignore/devtools-frontend')
);
const depotTools = path.resolve(process.env['DEPOT_TOOLS'] ?? path.join(repo, 'depot_tools.ignore'));
const out = path.join(src, 'out/Anywhere');
const dist = path.join(pkg, 'dist');
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
if (!noSync) {
  run('git', ['fetch', 'origin', 'main']);
  if (args.has('--latest')) revision = read('git', ['rev-parse', 'origin/main']);
  run('git', ['checkout', '--force', '--detach', revision]);
  run('git', ['clean', '-fd', 'front_end']);
  run('gclient', ['sync', '--force', '--delete_unversioned_trees'], { cwd: path.dirname(src) });
}

// Patches: small edits to upstream files, kept as reviewable diffs.
const patches = fs
  .readdirSync(path.join(pkg, 'patches'))
  .filter(f => f.endsWith('.patch'))
  .sort();
for (const patch of patches) {
  const file = path.join(pkg, 'patches', patch);
  try {
    run('git', ['apply', '--check', '--reverse', file], { stdio: 'ignore' });
    continue; // already applied (--no-sync)
  } catch {}
  console.log(`Applying ${patch}`);
  run('git', ['apply', '--3way', file]);
}

// Our own sources are copied, not patched in.
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

fs.rmSync(dist, { recursive: true, force: true });
const copy = (file: string, content?: string) => {
  fs.mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
  if (content === undefined) fs.copyFileSync(path.join(gen, file), path.join(dist, file));
  else fs.writeFileSync(path.join(dist, file), content);
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
  const target = BUNDLED_LOCALES.includes(name.slice(0, -'.json'.length)) ? dist : localesDist;
  fs.mkdirSync(path.join(target, LOCALES), { recursive: true });
  fs.writeFileSync(path.join(target, LOCALES, name), JSON.stringify(used));
}
fs.writeFileSync(path.join(localesDist, 'REVISION'), revision + '\n');

fs.writeFileSync(path.join(dist, 'REVISION'), revision + '\n');
if (args.has('--latest')) fs.writeFileSync(revisionFile, revision + '\n');
console.log(
  `Built devtools-frontend ${revision} → ${path.relative(repo, dist)} (${kept.length} of ${files.length} files)`
);
