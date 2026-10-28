// Entry of devtools-anywhere's probe.iife.js: the probe plus zero-config mounting.
//
//   <script src="…/devtools-anywhere/dist/probe.iife.js" data-frontend="…/anywhere_app.html"></script>
//
// As the first script in <head>, it captures from the very start. With `data-frontend`, it
// loads devtools-anywhere.iife.js (from `data-bundle`, by default next to this file) after
// the page has loaded and mounts <devtools-anywhere>. `data-open` opens DevTools right away;
// `data-sw` is passed on as the element's `sw` attribute (see shell mode).
//
// With `data-remote` instead, it connects the page to a remote debugging server
// (@devtools-anywhere/remote-server) at that URL, by default the one this file is served from,
// where DevTools on another machine inspects it. No <devtools-anywhere> is mounted then.
// `data-single-path` connects to that URL itself, the target in the query, for a server whose
// host routes WebSocket upgrades by exact path (remote-server's `singlePath`).
//
// Outside shell mode it unregisters the shell's Service Worker if one is left over (shell mode
// ended without exitShell): recognized by its script URL, which the shell gives `probe` (ending
// in probe.iife.js) and `shell` query parameters, and kept while it answers that a shell in
// another tab still uses it. The page's own workers are left alone.
import { installProbe, readShellConfig, setShellScriptUrl } from './cdp-agent/probe';
import type { DevtoolsAnywhereApi } from './api';

const script = document.currentScript as HTMLScriptElement | null;
// Shell configs must come from this script's origin.
if (script?.src) setShellScriptUrl(script.src);
const probe = installProbe();
// The probe's own request is DevTools', not the page's: left out of the Network panel.
if (script?.src) probe.ownUrls.add(script.src);

/** True for a devtools-anywhere-sw.js script URL as the shell registers it. */
const isShellWorker = (scriptUrl: string | undefined) => {
  if (!scriptUrl) return false;
  const params = new URL(scriptUrl).searchParams;
  return !!params.get('probe')?.endsWith('/probe.iife.js') && params.has('shell');
};
/**
 * Asks the worker whether a shell (maybe in another tab) still uses it. No answer within a
 * second (an older or stuck worker) counts as no.
 */
const shellOpen = (worker: ServiceWorker) =>
  new Promise<boolean>(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 1000);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      resolve(event.data === true);
    };
    worker.postMessage({ type: 'devtools-anywhere:shell-open' }, [channel.port2]);
  });
if (!readShellConfig() && navigator.serviceWorker) {
  navigator.serviceWorker
    .getRegistrations()
    .then(registrations =>
      Promise.all(
        registrations.map(async r => {
          const worker = r.active || r.waiting || r.installing;
          if (!worker || !isShellWorker(worker.scriptURL)) return;
          if (r.active && (await shellOpen(r.active))) return;
          await r.unregister();
        })
      )
    )
    .catch(() => {});
}

/** The bundle's API (src/api.ts), once the bundle has run: checked, since it is built separately. */
const isApi = (api: unknown): api is Pick<DevtoolsAnywhereApi, 'connectRemote'> =>
  typeof api === 'object' && api !== null && 'connectRemote' in api && typeof api.connectRemote === 'function';

const frontend = script?.dataset['frontend'];
const remote = script?.dataset['remote'];
// In the shell's top window the probe has replaced the document with the shell already.
if (script && (frontend || remote !== undefined) && !(readShellConfig() && window === top)) {
  const bundle = new URL(script.dataset['bundle'] || 'devtools-anywhere.iife.js', script.src).href;
  const open = script.hasAttribute('data-open');
  probe.ownUrls.add(bundle);

  const mount = () => {
    const loader = document.createElement('script');
    loader.src = bundle;
    loader.onload = () => {
      if (remote !== undefined) {
        const api: unknown = Reflect.get(window, 'DevtoolsAnywhere');
        if (isApi(api)) {
          api.connectRemote(new URL(remote || '.', script.src).href, {
            singlePath: script.hasAttribute('data-single-path'),
          });
        }
        return;
      }
      if (!frontend || document.querySelector('devtools-anywhere')) return;
      const element = document.createElement('devtools-anywhere');
      element.setAttribute('frontend', new URL(frontend, location.href).href);
      if (open) element.setAttribute('open', '');
      if (script.dataset['sw'] !== undefined) element.setAttribute('sw', script.dataset['sw']);
      document.body.appendChild(element);
    };
    document.head.appendChild(loader);
  };
  // Load the larger bundle only after the page itself has loaded.
  if (document.readyState === 'complete') mount();
  else addEventListener('load', mount, { once: true });
}
