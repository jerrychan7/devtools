// Builds the DevTools frontend from the official devtools-frontend sources:
//   checks out the pinned revision, applies the patches, adds the anywhere_app entrypoint,
//   builds with gn + autoninja, and bundles the release files into dist/ (scripts/bundle.ts; the
//   locales beyond en-US and zh go to ../devtools-frontend-locales/dist/).
//
// Environment: see checkout.ts.
//
// Flags:
//   --latest     build the devtools-frontend of the current stable Chrome instead of REVISION, and
//                pin it on success (with --no-sync: pin the checkout's HEAD)
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
import { bundle } from './bundle.ts';
import { changed, env, hasCheckout, patches, pkg, read, repo, src, unexpectedEdits } from './checkout.ts';

const out = path.join(src, 'out/Anywhere');
const dist = path.join(pkg, 'dist');
/** The release files anywhere_app can load, one bundle per module, before bundle.ts. */
const release = path.join(out, 'release');
/** The locales Chrome bundles stay in this package; the others go to the locales package. */
const localesDist = path.join(pkg, '../devtools-frontend-locales/dist');
const BUNDLED_LOCALES = ['en-US', 'zh'];
const revisionFile = path.join(pkg, 'REVISION');

const UPSTREAM = 'https://chromium.googlesource.com/devtools/devtools-frontend.git';
// gclient's configuration, rewritten on every sync. The hooks turned off fetch what only upstream's
// own tests and tooling use: emscripten (0.8 GB, for the C++ debugging extension and the e2e tests'
// wasm), the permissions of the Chrome its tests run in, and VS Code settings. That Chrome itself
// (0.5 GB) is still downloaded: gclient offers no way to skip a dependency stored in GCS.
const GCLIENT = `solutions = [{
  "name": "${path.basename(src)}",
  "url": "${UPSTREAM}",
  "deps_file": "DEPS",
  "custom_hooks": [{"name": "emscripten"}, {"name": "fix_cft_permissions"}, {"name": "VS Code settings"}],
}]
`;

const args = new Set(process.argv.slice(2));
/** --copy-only reuses the last build, so syncing (or moving to --latest) would mislabel it. */
const noSync = args.has('--no-sync') || args.has('--copy-only');
const run = (cmd: string, argv: string[], opts: ExecFileSyncOptions = {}) =>
  execFileSync(cmd, argv, { cwd: src, env, stdio: 'inherit', ...opts });

if (!hasCheckout()) {
  if (noSync) {
    console.error(`No devtools-frontend checkout at ${src}: run without --no-sync or --copy-only first.`);
    process.exit(1);
  }
  // A new checkout is an empty repository: the sync below fetches the one commit it builds.
  fs.mkdirSync(src, { recursive: true });
  run('git', ['init', '--quiet']);
  run('git', ['remote', 'add', 'origin', UPSTREAM]);
}

// Upstream versions: the frontend follows stable Chrome, as most users' Chrome is: the commit the
// current stable release ships, on its milestone's branch (`chromium/<branch>`, the third part of
// Chrome's version), not upstream's main. Chromium Dash knows which commit that is; its JSON
// endpoint has no documentation nor promise, so its answer is checked. Without it, write the
// commit into REVISION by hand and build, and Chrome's version into the packages' `chrome` field.
const STABLE_RELEASE = 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1';
async function stableRelease(): Promise<{ devtools: string; chrome: string }> {
  const failed = `No devtools commit in ${STABLE_RELEASE}: write the stable one into REVISION by hand.`;
  let releases: unknown;
  try {
    const response = await fetch(STABLE_RELEASE);
    releases = response.ok ? await response.json() : undefined;
  } catch (e) {
    throw new Error(failed, { cause: e });
  }
  const release: unknown = Array.isArray(releases) ? releases[0] : undefined;
  const hashes: unknown = release instanceof Object ? Reflect.get(release, 'hashes') : undefined;
  const devtools: unknown = hashes instanceof Object ? Reflect.get(hashes, 'devtools') : undefined;
  const chrome: unknown = release instanceof Object ? Reflect.get(release, 'version') : undefined;
  if (typeof devtools !== 'string' || !/^[0-9a-f]{40}$/.test(devtools)) throw new Error(failed);
  if (typeof chrome !== 'string' || !/^\d+(\.\d+){3}$/.test(chrome)) throw new Error(failed);
  console.log(`Stable Chrome ${chrome}: devtools ${devtools}`);
  return { devtools, chrome };
}

/**
 * Records the Chrome version the frontend comes from in every published package's package.json, as
 * `chrome` (last, where the formatter keeps it): npm versions say how the library changed, this
 * which Chrome it shows.
 */
function pinChromeVersion(chrome: string) {
  const packages = path.join(pkg, '..');
  for (const dir of fs.readdirSync(packages)) {
    const file = path.join(packages, dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const json: Record<string, unknown> = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (json['private']) continue;
    delete json['chrome'];
    fs.writeFileSync(file, JSON.stringify({ ...json, chrome }, null, 2) + '\n');
  }
}

let revision = fs.readFileSync(revisionFile, 'utf8').trim();
let chrome: string | null = null;
if (noSync) {
  // What is built is the checkout as it stands, e.g. the stable commit left by a failed --latest.
  const head = read('git', ['rev-parse', 'HEAD']);
  if (head !== revision && !args.has('--latest'))
    console.warn(`The checkout is at ${head}, not REVISION ${revision}: add --latest to pin it.`);
  revision = head;
} else {
  if (args.has('--latest')) ({ devtools: revision, chrome } = await stableRelease());
  // The commit is on a branch of its own, not on main: it is fetched by its hash, without history
  // (the build needs none, and it is most of the download).
  run('git', ['fetch', '--depth=1', 'origin', revision]);
  run('git', ['checkout', '--force', '--detach', revision]);
  run('git', ['clean', '-fd', 'front_end']);
  fs.writeFileSync(path.join(path.dirname(src), '.gclient'), GCLIENT);
  const solution = path.basename(src);
  run(
    'gclient',
    [
      'sync',
      '--force',
      '--delete_unversioned_trees',
      '--no-history',
      '--shallow',
      '--revision',
      `${solution}@${revision}`,
    ],
    {
      cwd: path.dirname(src),
    }
  );
}

// Patches: small edits to upstream files, kept as reviewable diffs. The checkout must end up
// as exactly REVISION plus every patch, so that a build depends on nothing else: a patch that
// was removed or changed must not linger. Edits made in the checkout to write a patch are not
// thrown away silently, though: if the checkout holds changes the patches do not account for,
// the build stops, unless --reset is given (check-checkout.ts stops a commit on the same edits).
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
// The contract between anywhere_app and its embedder is written once, in devtools-anywhere.
fs.copyFileSync(
  path.join(pkg, '../devtools-anywhere/src/embedder.ts'),
  path.join(src, 'front_end/entrypoints/anywhere_app/embedder.ts')
);

if (!args.has('--copy-only')) {
  run('gn', ['gen', out, '--args=is_debug=false']);
  // Only what the release files need: building everything would build upstream's tests too.
  run('autoninja', ['-C', out, 'generate_devtools_grd']);
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
if (args.has('--latest')) {
  fs.writeFileSync(revisionFile, revision + '\n');
  if (chrome) pinChromeVersion(chrome);
  else console.warn("Pinned the checkout's HEAD: set the packages' `chrome` field to its Chrome version by hand.");
}
console.log(
  `Built devtools-frontend ${revision} → ${path.relative(repo, dist)} (${kept.length} of ${files.length} files, ` +
    `bundled into ${fs.readdirSync(path.join(dist, 'bundle')).length})`
);
