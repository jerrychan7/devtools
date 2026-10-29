/**
 * Vite plugin that injects devtools-anywhere into every page during development.
 *
 * @packageDocumentation
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';
import type { ProbeScriptAttributes } from 'devtools-anywhere';

/**
 * Options of the devtools-anywhere Vite plugin.
 *
 * @public
 */
export interface DevtoolsAnywhereOptions {
  /**
   * Directory of a built DevTools frontend to serve, under `/@devtools-anywhere/front_end/`.
   * Default: the build of `@devtools-anywhere/devtools-frontend`.
   */
  devtoolsFrontendDir?: string;
  /** Entry page inside `devtoolsFrontendDir`. Default: `anywhere_app.html`. */
  devtoolsFrontendEntry?: string;
  /** URL of a frontend hosted elsewhere; used instead of `devtoolsFrontendDir`. */
  devtoolsFrontendUrl?: string;
  /** Open DevTools as soon as it is mounted (`data-open-immediately`). Default: false. */
  openImmediately?: boolean;
  /**
   * Shell mode, where the page runs in an iframe next to DevTools, which stays open across
   * reloads: `off` leaves it off unless the user turns it on in DevTools
   * (`data-default-shell-mode`). Default: `on`.
   */
  defaultShellMode?: 'on' | 'off';
  /**
   * Keeps shell mode as `defaultShellMode` says, whatever the user chose: DevTools offers no
   * switch (`data-shell-mode-locked`). Default: false.
   */
  shellModeLocked?: boolean;
  /** Hides the element's toggler button (`data-no-toggler`). Default: false. */
  noToggler?: boolean;
  /** Use the Service Worker in shell mode to inject the probe into iframe pages. Default: false. */
  serviceWorker?: boolean;
  /**
   * URL of a remote debugging server (`@devtools-anywhere/remote-server`), such as
   * `http://192.168.1.2:8080/`: pages connect to it, to be inspected from another machine,
   * instead of mounting DevTools in the page.
   */
  remote?: string;
}

const BASE = '/@devtools-anywhere/';
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
};

/** Directory of an installed package's file, or undefined if the package is not installed. */
function packageDir(require: NodeJS.Require, file: string): string | undefined {
  try {
    return path.dirname(require.resolve(file));
  } catch {
    return undefined;
  }
}

/**
 * Injects devtools-anywhere into every page during development (`vite serve` only):
 * the probe becomes the first script in <head>, and DevTools mounts after the page loads.
 * Production builds are left untouched.
 *
 * @public
 */
export default function devtoolsAnywhere(options: DevtoolsAnywhereOptions = {}): Plugin {
  const require = createRequire(import.meta.url);
  const dist = path.dirname(require.resolve('devtools-anywhere/probe.iife.js'));
  const dir = options.devtoolsFrontendUrl
    ? undefined
    : (options.devtoolsFrontendDir ?? packageDir(require, '@devtools-anywhere/devtools-frontend/anywhere_app.html'));
  const frontendDir = dir && path.resolve(dir);
  const frontend =
    options.devtoolsFrontendUrl ??
    (frontendDir ? `${BASE}front_end/${options.devtoolsFrontendEntry ?? 'anywhere_app.html'}` : undefined);

  // Optional: translations beyond English and Chinese, laid out like the frontend.
  const localesDir = frontendDir && packageDir(require, '@devtools-anywhere/devtools-frontend-locales/REVISION');

  /** `rel` inside `dir`, if it is a file there. */
  function fileIn(dir: string | undefined, rel: string): string | null {
    if (!dir) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return null; // Malformed escape such as `%E0`: not a file of ours.
    }
    const file = path.resolve(dir, decoded);
    if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) return null;
    return file;
  }

  /** Maps a request path under BASE to a file on disk, or null. */
  function resolveFile(urlPath: string): string | null {
    if (!urlPath.startsWith('front_end/')) return fileIn(dist, urlPath);
    const rel = urlPath.slice('front_end/'.length);
    return fileIn(frontendDir, rel) ?? fileIn(localesDir, rel);
  }

  return {
    name: 'devtools-anywhere',
    apply: 'serve',

    configResolved(config) {
      if (!frontend)
        config.logger.warn(
          '[devtools-anywhere] No DevTools frontend found: install @devtools-anywhere/devtools-frontend, or set `devtoolsFrontendDir` or `devtoolsFrontendUrl`.'
        );
    },

    configureServer(server) {
      server.middlewares.use(BASE, (req, res, next) => {
        const file = resolveFile(((req.url ?? '').split('?')[0] ?? '').replace(/^\//, ''));
        if (!file) return next();
        res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
        // Lets the Service Worker control the whole site from under BASE.
        if (file.endsWith('-sw.js')) res.setHeader('service-worker-allowed', '/');
        // The file can vanish between the check and the read (e.g. a rebuild of dist);
        // an unhandled stream error would crash the dev server.
        createReadStream(file)
          .on('error', err => (res.headersSent ? res.destroy(err) : next(err)))
          .pipe(res);
      });
    },

    transformIndexHtml: {
      order: 'pre',
      handler() {
        const attrs: { src: string } & ProbeScriptAttributes = { src: `${BASE}probe.iife.js` };
        if (options.remote) attrs['data-remote'] = options.remote;
        else if (frontend) attrs['data-devtools-frontend-url'] = frontend;
        if (options.openImmediately) attrs['data-open-immediately'] = true;
        if (options.defaultShellMode) attrs['data-default-shell-mode'] = options.defaultShellMode;
        if (options.shellModeLocked) attrs['data-shell-mode-locked'] = true;
        if (options.noToggler) attrs['data-no-toggler'] = true;
        if (options.serviceWorker) attrs['data-sw'] = true;
        return [{ tag: 'script', attrs, injectTo: 'head-prepend' }];
      },
    },
  };
}
