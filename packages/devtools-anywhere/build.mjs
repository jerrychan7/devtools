// Bundles the package with esbuild. Type declarations are emitted separately by tsc.
import { build } from 'esbuild'
import { rmSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })

const common = { bundle: true, target: 'es2020', sourcemap: true, logLevel: 'info' }

await Promise.all([
  // The ESM build leaves the CDP server to the consumer's bundler.
  build({
    ...common,
    entryPoints: { index: 'src/index.ts' },
    format: 'esm',
    outdir: 'dist',
    external: ['@devtools-anywhere/cdp-server'],
  }),
  build({
    ...common,
    entryPoints: {
      'devtools-anywhere.iife': 'src/iife.ts',
      'probe.iife': 'src/probe.ts',
      'devtools-anywhere-sw': 'src/sw.ts',
    },
    format: 'iife',
    minify: true,
    outdir: 'dist',
  }),
])
