// Bundles the server and its CLI for Node with esbuild. Type declarations are emitted
// separately by tsc. `--watch` rebuilds on every change (`pnpm dev`).
import { context, type BuildOptions, type Plugin } from 'esbuild';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');
// In watch mode the other packages' watchers read this dist/: keep it in place.
if (!watch) rmSync('dist', { recursive: true, force: true });

// Packages stay imports, but the relay core is internal (never published): it is bundled in.
const relayCore: Plugin = {
  name: 'relay-core',
  setup(build) {
    build.onResolve({ filter: /^@devtools-anywhere\/relay-core$/ }, () => ({
      path: fileURLToPath(import.meta.resolve('@devtools-anywhere/relay-core')),
    }));
  },
};

const common: BuildOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'dist',
  packages: 'external',
  plugins: [relayCore],
  logLevel: 'info',
};
const builds: BuildOptions[] = [
  { ...common, entryPoints: ['src/index.ts'] },
  { ...common, entryPoints: ['src/cli.ts'], banner: { js: '#!/usr/bin/env node' } },
];

const contexts = await Promise.all(builds.map(options => context(options)));
if (watch) {
  await Promise.all(contexts.map(ctx => ctx.watch()));
} else {
  await Promise.all(contexts.map(ctx => ctx.rebuild()));
  await Promise.all(contexts.map(ctx => ctx.dispose()));
}
