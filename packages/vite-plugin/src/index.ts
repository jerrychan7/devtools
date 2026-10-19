import { createReadStream, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin } from 'vite'

export interface DevtoolsAnywhereOptions {
  /**
   * Directory of a built DevTools frontend to serve (e.g. a Chii build's `public/front_end`).
   * It is served under `/@devtools-anywhere/front_end/`.
   */
  frontendDir?: string
  /** Entry page inside `frontendDir`. Default: `chii_app.html`. */
  frontendEntry?: string
  /** URL of a frontend hosted elsewhere; used instead of `frontendDir`. */
  frontendUrl?: string
  /** Open DevTools as soon as it is mounted. Default: false. */
  open?: boolean
  /** Use the Service Worker in shell mode to inject the probe into iframe pages. Default: false. */
  serviceWorker?: boolean
}

const BASE = '/@devtools-anywhere/'
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.avif': 'image/avif',
  '.wasm': 'application/wasm',
}

/**
 * Injects devtools-anywhere into every page during development (`vite serve` only):
 * the probe becomes the first script in <head>, and DevTools mounts after the page loads.
 * Production builds are left untouched.
 */
export default function devtoolsAnywhere(options: DevtoolsAnywhereOptions = {}): Plugin {
  const require = createRequire(import.meta.url)
  const dist = path.dirname(require.resolve('devtools-anywhere/probe.iife.js'))
  const frontendDir = options.frontendDir && path.resolve(options.frontendDir)
  const frontend = options.frontendUrl ?? (frontendDir ? `${BASE}front_end/${options.frontendEntry ?? 'chii_app.html'}` : undefined)

  /** Maps a request path under BASE to a file on disk, or null. */
  function resolveFile(urlPath: string): string | null {
    const [dir, rel] = urlPath.startsWith('front_end/') ? [frontendDir, urlPath.slice('front_end/'.length)] : [dist, urlPath]
    if (!dir) return null
    const file = path.resolve(dir, decodeURIComponent(rel))
    if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) return null
    return file
  }

  return {
    name: 'devtools-anywhere',
    apply: 'serve',

    configResolved(config) {
      if (!frontend) config.logger.warn('[devtools-anywhere] Set `frontendDir` or `frontendUrl`; DevTools will not mount.')
    },

    configureServer(server) {
      server.middlewares.use(BASE, (req, res, next) => {
        const file = resolveFile((req.url ?? '').split('?')[0].replace(/^\//, ''))
        if (!file) return next()
        res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
        // Lets the Service Worker control the whole site from under BASE.
        if (file.endsWith('-sw.js')) res.setHeader('service-worker-allowed', '/')
        createReadStream(file).pipe(res)
      })
    },

    transformIndexHtml: {
      order: 'pre',
      handler() {
        const attrs: Record<string, string | boolean> = { src: `${BASE}probe.iife.js` }
        if (frontend) attrs['data-frontend'] = frontend
        if (options.open) attrs['data-open'] = true
        if (options.serviceWorker) attrs['data-sw'] = true
        return [{ tag: 'script', attrs, injectTo: 'head-prepend' }]
      },
    },
  }
}
