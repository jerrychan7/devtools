// Bundles the package with esbuild. Type declarations are emitted separately by tsc.
// `--watch` rebuilds on every change (`pnpm dev`).
import { context, type BuildOptions } from 'esbuild'
import { rmSync } from 'node:fs'

const watch = process.argv.includes('--watch')
// In watch mode the other packages' watchers read this dist/: keep it in place.
if (!watch) rmSync('dist', { recursive: true, force: true })

const common: BuildOptions = { bundle: true, target: 'es2020', sourcemap: true, logLevel: 'info' }

const builds: BuildOptions[] = [
  // The ESM build leaves the CDP server to the consumer's bundler.
  {
    ...common,
    entryPoints: { index: 'src/index.ts' },
    format: 'esm',
    outdir: 'dist',
    external: ['@devtools-anywhere/cdp-server'],
  },
  {
    ...common,
    entryPoints: {
      'devtools-anywhere.iife': 'src/iife.ts',
      'probe.iife': 'src/probe.ts',
      'devtools-anywhere-sw': 'src/sw.ts',
    },
    format: 'iife',
    minify: true,
    outdir: 'dist',
  },
]

const contexts = await Promise.all(builds.map(options => context(options)))
if (watch) {
  await Promise.all(contexts.map(ctx => ctx.watch()))
} else {
  await Promise.all(contexts.map(ctx => ctx.rebuild()))
  await Promise.all(contexts.map(ctx => ctx.dispose()))
}
