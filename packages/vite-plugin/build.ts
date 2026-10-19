// Bundles the plugin for Node with esbuild. Type declarations are emitted separately by tsc.
import { build } from 'esbuild'
import { rmSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'dist',
  packages: 'external',
  logLevel: 'info',
})
