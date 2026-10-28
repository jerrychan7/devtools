// Bundles the package with esbuild. Type declarations are emitted separately by tsc.
// `--watch` rebuilds on every change (`pnpm dev`).
import { context, type BuildOptions } from 'esbuild';
import { rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
// In watch mode the other packages' watchers read this dist/: keep it in place.
if (!watch) rmSync('dist', { recursive: true, force: true });

const common: BuildOptions = { bundle: true, target: 'es2020', sourcemap: true, logLevel: 'info' };

const builds: BuildOptions[] = [
  { ...common, entryPoints: { index: 'src/index.ts', probe: 'src/probe/entry.ts' }, format: 'esm', outdir: 'dist' },
  { ...common, entryPoints: { 'probe.iife': 'src/probe/iife.ts' }, format: 'iife', minify: true, outdir: 'dist' },
  { ...common, entryPoints: { 'cdp-server.iife': 'src/iife.ts' }, format: 'iife', minify: true, outdir: 'dist' },
];

const contexts = await Promise.all(builds.map(options => context(options)));
if (watch) {
  await Promise.all(contexts.map(ctx => ctx.watch()));
} else {
  await Promise.all(contexts.map(ctx => ctx.rebuild()));
  await Promise.all(contexts.map(ctx => ctx.dispose()));
}
