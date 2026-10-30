// Bundles the package with esbuild. Type declarations are emitted separately by tsc.
// `--watch` rebuilds on every change (`pnpm dev`).
import { context, type BuildOptions } from 'esbuild';
import { rmSync } from 'node:fs';
import { BUNDLE_SCRIPT, PROBE_SCRIPT, SNAPDOM_SCRIPT } from './src/embedder.ts';

const watch = process.argv.includes('--watch');
// In watch mode the other packages' watchers read this dist/: keep it in place.
if (!watch) rmSync('dist', { recursive: true, force: true });

/** An entry point's name, for the file it is built to. */
const entry = (file: string) => file.replace(/\.js$/, '');

const common: BuildOptions = { bundle: true, target: 'es2020', sourcemap: true, logLevel: 'info' };

const builds: BuildOptions[] = [
  // No ESM build: the package's runtime is the two scripts, and its index only types.
  {
    ...common,
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
];

const contexts = await Promise.all(builds.map(options => context(options)));
if (watch) {
  await Promise.all(contexts.map(ctx => ctx.watch()));
} else {
  await Promise.all(contexts.map(ctx => ctx.rebuild()));
  await Promise.all(contexts.map(ctx => ctx.dispose()));
}
