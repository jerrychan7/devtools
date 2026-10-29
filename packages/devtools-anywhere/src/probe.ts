// Entry of devtools-anywhere's probe.iife.js: the probe plus zero-config mounting.
//
//   <script src="…/devtools-anywhere/dist/probe.iife.js" data-frontend="…/anywhere_app.html"></script>
//
// As the first script in <head>, it captures from the very start. With `data-frontend`, it
// loads devtools-anywhere.iife.js (from `data-bundle`, by default next to this file) after
// the page has loaded and mounts <devtools-anywhere>. `data-open-immediately` opens DevTools right away; `data-sw` is passed on as the element's `sw`
// attribute (see shell mode), `data-no-toggler` as its `no-toggler`.
//
// With `data-frontend`, the top-level page enters shell mode by default, on its first load: the
// probe stores the shell config itself before the page's scripts run, so the page is not
// loaded twice over. It does not when `data-default-shell-mode="off"`, when the user turned shell
// mode off in DevTools (or on again, whatever `data-default-shell-mode` says), when the page
// cannot be framed (SHELL_REFUSED_KEY), or when the frontend, bundle or Service Worker is on
// another origin. `data-shell-mode-locked` ignores the user's choice (it stays stored) and has
// DevTools offer none; a page that cannot be framed still leaves shell mode.
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
import {
  SHELL_KEY,
  SHELL_MODE_KEY,
  SHELL_REFUSED_KEY,
  installProbe,
  readShellConfig,
  setShellScriptUrl,
  storeShellConfig,
} from './cdp-agent/probe';
import type { DevtoolsAnywhereApi } from './api';
import { BUNDLE_SCRIPT, PROBE_SCRIPT } from './embedder';
import type { ProbeScriptAttributes } from './probe-script';
import { SHELL_QUERY } from './shell-messages';

const script = document.currentScript as HTMLScriptElement | null;
// Shell configs must come from this script's origin.
if (script?.src) setShellScriptUrl(script.src);

/** One of the script's attributes (probe-script.ts); `null` when it is absent. */
const attribute = (name: keyof ProbeScriptAttributes) => script?.getAttribute(name) ?? null;
const frontend = attribute('data-frontend');
const remote = attribute('data-remote');
// A probe inlined, without a URL, has no bundle next to it.
const bundle = script?.src ? new URL(attribute('data-bundle') || BUNDLE_SCRIPT, script.src).href : null;
const open = attribute('data-open-immediately') !== null;
const locked = attribute('data-shell-mode-locked') !== null;
const noToggler = attribute('data-no-toggler') !== null;
const shellOff = attribute('data-default-shell-mode') === 'off';

/** Whether to enter shell mode by default; storage that throws counts as no. */
const shellByDefault = () => {
  try {
    if (sessionStorage.getItem(SHELL_REFUSED_KEY)) return false;
    // Locked, the user's choice is ignored but kept.
    const chosen = locked ? null : localStorage.getItem(SHELL_MODE_KEY);
    return chosen ? chosen === 'on' : !shellOff;
  } catch {
    return false;
  }
};
// A shell entered before takes the page's flags as they are now; locked out of shell mode, it is left.
const entered = bundle && frontend && remote === null && window === top ? readShellConfig() : null;
if (entered && locked && shellOff) {
  try {
    sessionStorage.removeItem(SHELL_KEY);
  } catch {}
} else if (entered) {
  storeShellConfig(entered.frontend, entered.bundle, entered.sw ?? null, { ...entered, locked, noToggler });
}
// installProbe() reads the config next and writes the shell.
if (bundle && frontend && remote === null && window === top && !readShellConfig() && shellByDefault()) {
  storeShellConfig(frontend, bundle, attribute('data-sw'), { open, locked, noToggler });
}

const probe = installProbe();
// The probe's own request is DevTools', not the page's: left out of the Network panel.
if (script?.src) probe.ownUrls.add(script.src);

/** True for a devtools-anywhere-sw.js script URL as the shell registers it. */
const isShellWorker = (scriptUrl: string | undefined) => {
  if (!scriptUrl) return false;
  const params = new URL(scriptUrl).searchParams;
  return !!params.get('probe')?.endsWith(`/${PROBE_SCRIPT}`) && params.has('shell');
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
    worker.postMessage({ type: SHELL_QUERY }, [channel.port2]);
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

// In the shell's top window the probe has replaced the document with the shell already.
if (script && bundle && (frontend || remote !== null) && !(readShellConfig() && window === top)) {
  probe.ownUrls.add(bundle);

  const mount = () => {
    const loader = document.createElement('script');
    loader.src = bundle;
    loader.onload = () => {
      if (remote !== null) {
        const api: unknown = Reflect.get(window, 'DevtoolsAnywhere');
        if (isApi(api)) {
          api.connectRemote(new URL(remote || '.', script.src).href, {
            singlePath: attribute('data-single-path') !== null,
          });
        }
        return;
      }
      if (!frontend || document.querySelector('devtools-anywhere')) return;
      const element = document.createElement('devtools-anywhere');
      element.setAttribute('frontend', new URL(frontend, location.href).href);
      if (open) element.setAttribute('open', '');
      if (locked) element.setAttribute('shell-mode-locked', '');
      if (noToggler) element.setAttribute('no-toggler', '');
      const sw = attribute('data-sw');
      if (sw !== null) element.setAttribute('sw', sw);
      document.body.appendChild(element);
    };
    document.head.appendChild(loader);
  };
  // Load the larger bundle only after the page itself has loaded.
  if (document.readyState === 'complete') mount();
  else addEventListener('load', mount, { once: true });
}
