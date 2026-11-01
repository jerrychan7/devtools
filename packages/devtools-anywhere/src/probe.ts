// Entry of devtools-anywhere's probe.iife.js: the probe plus zero-config mounting.
//
//   <script src="…/devtools-anywhere/dist/probe.iife.js" data-devtools-frontend-url="…/anywhere_app.html"></script>
//
// From jsDelivr or unpkg, `data-devtools-frontend-url` defaults to the frontend package of the same
// version there (trust.ts); `data-no-panel` goes without it, for a page only debugged remotely.
// As the first script in <head>, it captures from the very start. With `data-devtools-frontend-url`, it
// loads devtools-anywhere.iife.js (from `data-bundle`, by default next to this file) after
// the page has loaded and mounts its own <devtools-anywhere> under <html>, whatever the page has.
// `data-open-immediately` opens DevTools right away; `data-service-worker` and `data-no-toggler` are passed on
// to the element with the others (createGlobalElement; see shell mode).
//
// With `data-devtools-frontend-url`, the top-level page enters shell mode by default, on its first load: the
// probe stores the shell config itself before the page's scripts run, so the page is not
// loaded twice over. It does not when `data-default-shell-mode="off"`, when the user turned shell
// mode off in DevTools (or on again, whatever `data-default-shell-mode` says), when the page
// cannot be framed (SHELL_REFUSED_KEY), or when the frontend, bundle or Service Worker is on
// another origin. `data-shell-mode-locked` ignores the user's choice (it stays stored) and has
// DevTools offer none; a page that cannot be framed still leaves shell mode.
//
// With `data-remote`, it connects the page to a remote debugging server
// (@devtools-anywhere/remote-server) at that URL, by default the one this file is served from,
// where DevTools on another machine inspects it. With `data-devtools-frontend-url` too, the page
// also gets its own panel (shell mode included): the two are CDP sessions of their own over the
// one probe. In shell mode the page in the shell connects, not the shell's top window. The shell's
// probe decides for every page in the page iframe, whatever their own probe says, injected by the
// Service Worker or not: it keeps its server (and `data-id-in-query`) in memory, not in
// sessionStorage where any script of the page could change it, and answers each page that asks
// (SHELL_REMOTE) once loaded.
// `data-id-in-query` connects to that URL itself, the target in the query, for a server whose
// host routes WebSocket upgrades by exact path (remote-server's `idInQuery`).
//
// Outside shell mode it unregisters the shell's Service Worker if one is left over (shell mode
// ended without exitShell): recognized by its script URL, which the shell gives `probe` (ending
// in probe.iife.js) and `shell` query parameters, and kept while it answers that a shell in
// another tab still uses it. The page's own workers are left alone.
import {
  cdnFrontendUrl,
  SHELL_KEY,
  SHELL_MODE_KEY,
  SHELL_PAGE_ID,
  SHELL_REFUSED_KEY,
  installProbe,
  isShellPage,
  readShellConfig,
  setShellScriptUrl,
  storeShellConfig,
} from './cdp-agent/probe';
import type { DevtoolsAnywhereApi } from './api';
import { BUNDLE_SCRIPT, PROBE_SCRIPT } from './embedder';
import type { ProbeScriptAttributes } from './probe-script';
import { SHELL_QUERY, SHELL_REMOTE } from './shell-messages';

const script = document.currentScript as HTMLScriptElement | null;
// Shell configs may only point where this script trusts (trust.ts).
if (script?.src) setShellScriptUrl(script.src);

/** One of the script's attributes (probe-script.ts); `null` when it is absent. */
const attribute = (name: keyof ProbeScriptAttributes) => script?.getAttribute(name) ?? null;
// Loaded from an npm CDN, the probe finds the frontend of its version there by default.
const frontend =
  attribute('data-no-panel') === null
    ? attribute('data-devtools-frontend-url') || (script?.src ? cdnFrontendUrl(script.src) : null)
    : null;
const remote = attribute('data-remote');
// A probe inlined, without a URL, has no bundle next to it.
const bundle = script?.src ? new URL(attribute('data-bundle') || BUNDLE_SCRIPT, script.src).href : null;
const open = attribute('data-open-immediately') !== null;
const locked = attribute('data-shell-mode-locked') !== null;
const noToggler = attribute('data-no-toggler') !== null;
const shellOff = attribute('data-default-shell-mode') === 'off';
const shellPage = isShellPage();
/**
 * The server `data-remote` names; for the pages in the shell, in the shell's top window. In the shell's
 * page iframe, the shell's probe decides instead (SHELL_REMOTE): its server, or none.
 */
const remoteUrl = script?.src && remote !== null ? new URL(remote || '.', script.src).href : null;
const idInQuery = attribute('data-id-in-query') !== null;

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
const entered = bundle && frontend && window === top ? readShellConfig() : null;
if (entered && locked && shellOff) {
  try {
    sessionStorage.removeItem(SHELL_KEY);
  } catch {}
} else if (entered) {
  storeShellConfig(entered.frontend, entered.bundle, entered.serviceWorker ?? null, {
    ...entered,
    locked,
    noToggler,
  });
}
// installProbe() reads the config next and writes the shell.
if (bundle && frontend && window === top && !readShellConfig() && shellByDefault()) {
  storeShellConfig(frontend, bundle, attribute('data-service-worker'), { open, locked, noToggler });
}

const probe = installProbe();
// The probe's own request is DevTools', not the page's: left out of the Network panel.
if (script?.src) probe.ownUrls.add(script.src);
/** Whether this is the shell's top window, its document replaced with the shell by installProbe(). */
const shellTop = window === top && readShellConfig() !== null;

/** Whether `event` is a SHELL_REMOTE message from `source`, of this origin, not made up by a script. */
const isRemoteMessage = (event: MessageEvent, source: MessageEventSource | null): event is MessageEvent<object> =>
  event.isTrusted &&
  event.source === source &&
  event.origin === location.origin &&
  // Data posted to this window is cloned in its realm: any object is an Object here.
  event.data instanceof Object &&
  Reflect.get(event.data, 'type') === SHELL_REMOTE;
// The shell's top window tells the pages in its page iframe its server. Its listeners are erased when
// installProbe() replaces the document with the shell, in a task of its own: this one comes after.
if (shellTop) {
  setTimeout(() =>
    addEventListener('message', event => {
      const page = document.getElementById(SHELL_PAGE_ID);
      if (!(page instanceof HTMLIFrameElement) || !isRemoteMessage(event, page.contentWindow)) return;
      page.contentWindow?.postMessage({ type: SHELL_REMOTE, remote: remoteUrl, idInQuery }, location.origin);
    })
  );
}

/** True for a devtools-anywhere-service-worker.js script URL as the shell registers it. */
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

/**
 * Whether the bundle's API (src/api.ts) has the function `name`, once the bundle has run: checked,
 * since it is built separately.
 */
const hasApi = <K extends 'connectRemote' | 'createGlobalElement'>(
  api: unknown,
  name: K
): api is Pick<DevtoolsAnywhereApi, K> =>
  typeof api === 'object' && api !== null && typeof Reflect.get(api, name) === 'function';

// In the shell's top window the probe has replaced the document with the shell already. The page in
// the shell has the bundle from installProbe() already and only connects to the remote server: the shell
// shows DevTools, and the elements the page places take the shell's frontend (see element.ts).
if (script && bundle && (frontend || remoteUrl || shellPage) && !shellTop) {
  probe.ownUrls.add(bundle);

  const start = () => {
    const api: unknown = Reflect.get(window, 'DevtoolsAnywhere');
    if (shellPage) {
      // The shell's answer, once: its server, or none.
      const onAnswer = (event: MessageEvent) => {
        if (!isRemoteMessage(event, parent)) return;
        removeEventListener('message', onAnswer);
        const server: unknown = Reflect.get(event.data, 'remote');
        if (typeof server === 'string' && hasApi(api, 'connectRemote'))
          api.connectRemote(server, { idInQuery: Reflect.get(event.data, 'idInQuery') === true });
      };
      addEventListener('message', onAnswer);
      parent.postMessage({ type: SHELL_REMOTE }, location.origin);
    } else if (remoteUrl) {
      if (!hasApi(api, 'connectRemote')) return;
      api.connectRemote(remoteUrl, { idInQuery });
    }
    if (shellPage || !frontend || !hasApi(api, 'createGlobalElement')) return;
    // The page's own <devtools-anywhere> elements are not this one: it sits beside <body>.
    const element = api.createGlobalElement({
      frontend: new URL(frontend, location.href).href,
      open,
      locked,
      noToggler,
      serviceWorker: attribute('data-service-worker'),
    });
    if (element) document.documentElement.appendChild(element);
  };
  const mount = () => {
    // The bundle installProbe() added has run by the load event, which its script delays.
    if (shellPage) return start();
    const loader = document.createElement('script');
    loader.src = bundle;
    loader.onload = start;
    document.head.appendChild(loader);
  };
  // Load the larger bundle only after the page itself has loaded.
  if (document.readyState === 'complete') mount();
  else addEventListener('load', mount, { once: true });
}
