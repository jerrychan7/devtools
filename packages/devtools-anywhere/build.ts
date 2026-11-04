// Bundles the package with esbuild. Type declarations are emitted separately by tsc.
// `--watch` rebuilds on every change (`pnpm dev`).
import { context, type BuildOptions } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { ACCESSIBILITY_SCRIPT, BUNDLE_SCRIPT, PROBE_SCRIPT, SNAPDOM_SCRIPT } from './src/embedder.ts';

const watch = process.argv.includes('--watch');
// In watch mode the other packages' watchers read this dist/: keep it in place.
if (!watch) for (const dir of ['dist', 'dist-test']) rmSync(dir, { recursive: true, force: true });

/** An entry point's name, for the file it is built to. */
const entry = (file: string) => file.replace(/\.js$/, '');

const common: BuildOptions = { bundle: true, target: 'es2020', sourcemap: true, logLevel: 'info' };

const builds: BuildOptions[] = [
  // No ESM build: the package's runtime is the two scripts, and its index only types.
  {
    ...common,
    define: { DEVTOOLS_ANYWHERE_TEST: 'false' },
    entryPoints: {
      [entry(BUNDLE_SCRIPT)]: 'src/iife.ts',
      [entry(PROBE_SCRIPT)]: 'src/probe.ts',
      'devtools-anywhere-service-worker': 'src/service-worker.ts',
    },
    format: 'iife',
    minify: true,
    outdir: 'dist',
    // snapDOM is loaded from next to the bundle (snapdom.js, below), on demand.
    external: ['@zumer/snapdom'],
  },
  // The screencast's renderer, for the IIFE build to load on demand.
  {
    ...common,
    entryPoints: { [entry(SNAPDOM_SCRIPT)]: '@zumer/snapdom' },
    format: 'esm',
    minify: true,
    outdir: 'dist',
  },
  // The accessibility tree's computation, for the Accessibility domain to load on demand.
  {
    ...common,
    entryPoints: { [entry(ACCESSIBILITY_SCRIPT)]: 'src/cdp-agent/domains/accessibility/ax-node.ts' },
    format: 'esm',
    minify: true,
    outdir: 'dist',
  },
  // The two scripts again for the tests, in dist-test/ (not published): the bundle also exposes
  // internals the tests read in the page, as `window.__devtoolsAnywhereTest`.
  {
    ...common,
    entryPoints: { [entry(BUNDLE_SCRIPT)]: 'src/iife.ts', [entry(PROBE_SCRIPT)]: 'src/probe.ts' },
    define: { DEVTOOLS_ANYWHERE_TEST: 'true' },
    format: 'iife',
    minify: true,
    outdir: 'dist-test',
    external: ['@zumer/snapdom'],
  },
];

// Chromium's user agent style sheet, which the bundle loads from next to it on demand
// (src/cdp-agent/domains/css/user-agent/README.md); it must be that of the pinned Chrome.
const userAgent = 'src/cdp-agent/domains/css/user-agent';
mkdirSync('dist', { recursive: true });
copyFileSync(`${userAgent}/html.css`, 'dist/chromium-html.css');
const pinned: unknown = JSON.parse(readFileSync('package.json', 'utf8')).chrome;
if (readFileSync(`${userAgent}/CHROME_VERSION`, 'utf8').trim() !== pinned)
  console.warn(`${userAgent}/html.css is not Chrome ${String(pinned)}'s: run scripts/sync-user-agent-css.ts`);

const contexts = await Promise.all(builds.map(options => context(options)));
if (watch) {
  await Promise.all(contexts.map(ctx => ctx.watch()));
} else {
  await Promise.all(contexts.map(ctx => ctx.rebuild()));
  await Promise.all(contexts.map(ctx => ctx.dispose()));
}
