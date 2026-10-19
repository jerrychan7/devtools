// Bundles the package with esbuild. Type declarations are emitted separately by tsc.
import { build, type BuildOptions } from 'esbuild'
import { rmSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })

const common: BuildOptions = { bundle: true, target: 'es2020', sourcemap: true, logLevel: 'info' }

await Promise.all([
  build({ ...common, entryPoints: { index: 'src/index.ts', probe: 'src/probe/index.ts' }, format: 'esm', outdir: 'dist' }),
  build({ ...common, entryPoints: { 'probe.iife': 'src/probe/iife.ts' }, format: 'iife', minify: true, outdir: 'dist' }),
  build({ ...common, entryPoints: { 'cdp-server.iife': 'src/iife.ts' }, format: 'iife', minify: true, outdir: 'dist' }),
])
