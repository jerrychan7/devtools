// devtools-anywhere-service-worker.js: optional Service Worker for shell mode.
//
// While shell mode is on, it injects the probe at the top of <head> of every same-origin
// page loaded into an iframe, so pages that do not include the probe themselves are still
// captured when the page iframe navigates to them. The shell registers it with the probe
// URL in the query string (`?probe=…&shell`) and unregisters it when shell mode ends. The
// DevTools frontend page is left alone even if same-origin: recognized by its content (the
// anywhere_app entry point, or a `<meta name="devtools-anywhere-frontend">` right after
// <head>) by the time the probe would go in, whatever URL it is opened at.
//
// Shell mode can end without the shell unregistering the worker (sessionStorage cleared, the
// tab navigated away, the shell closed), so the worker checks it on every request: each shell
// document posts a handshake once it controls the worker (kept in the Cache API, as the worker
// may be restarted at any time), and requests are only touched while one of those shells is
// still open as a top-level window. Navigation requests carry no clientId (resultingClientId is
// the new page), so an iframe navigation is checked against the shells alone; a subresource is
// also passed through when its page is a top-level window (not inside a shell). Pages not in
// shell mode also unregister the worker when the probe loads (see probe.ts), unless it answers
// that a shell (in another tab) is still open.
//
// It also reports the details Resource Timing does not expose (request and response headers,
// status text) of same-origin subresources (style sheets, scripts, images, fonts) to
// the page that requested them; the probe adds them to its records. Cross-origin, ranged and
// non-GET requests pass through untouched, so the page's behavior does not change.
//
// A page's own scripts cannot be paused, so in the same-origin scripts it passes through, each
// `debugger` statement is replaced by a statement of the same length calling a function the probe defines,
// which logs a warning with the stack instead. Lines and columns stay as they were. The Sources
// panel still shows the original: it fetches scripts itself, which this worker does not touch.
// The function is always there first: scripts are only rewritten in shell mode, for pages in the
// shell's iframe, where this worker put the probe first in <head> (or the page has it there itself)
// and the probe defines it as it runs. Scripts of workers (importScripts, which also has the
// `script` destination) are not rewritten: the probe is not in workers. Neither are scripts with
// an integrity hash (the rewrite would fail the check) or in an encoding that is not UTF-8 or
// single-byte. What each script needs is remembered by the hash of its bytes (see
// debugger-rewrite/cache.ts), so a script served again is not lexed again; that memory is dropped
// when a new version of this worker activates.
//
// A Service Worker needs a secure context (HTTPS or localhost), and its scope must cover
// the pages: serve this file from the site root or with `Service-Worker-Allowed: /`.

// Type-checked with the WebWorker library (tsconfig.service-worker.json), separately from the DOM code.
declare const self: ServiceWorkerGlobalScope;
/** Hash of the lexer and the rewrite (build.ts), which the rewrite cache's record is tied to. */
declare const DEVTOOLS_ANYWHERE_REWRITE_BUILD: string;
// The lexer alone (through the rewrite): the agent's entry points would bring DOM code into the worker.
import { RewriteCache, cacheStore } from './debugger-rewrite/cache';
import { rewriteDebugger } from './debugger-rewrite/rewrite';
import { RESPONSE_DETAILS, type ResponseDetails } from './cdp-agent/probe/messages';
import { REWRITE_CACHE, SHELL_HANDSHAKE, SHELL_QUERY } from './shell-messages';

const params = new URL(self.location.href).searchParams;
const probe = params.get('probe');
const SNIFF_LIMIT = 64 * 1024;
/** Text re-searched before each new chunk, so a tag split across chunks is still found. */
const SNIFF_OVERLAP = 1024;
/** Marks the DevTools frontend page, which must not get the probe. */
const FRONTEND =
  /<meta\b[^>]*\bname\s*=\s*["']?devtools-anywhere-frontend\b|entrypoints\/anywhere_app\/anywhere_app\.js/i;
const DESTINATIONS = new Set(['style', 'script', 'image', 'font']);
const SHELL_CACHE = 'devtools-anywhere-service-worker-shells';
const shellKey = (id: string) =>
  new URL(`/__devtools-anywhere-shell/${encodeURIComponent(id)}`, self.location.href).href;

/**
 * The documents this worker gave the probe (by client id), each with the same-origin scripts its
 * markup has an integrity hash for (see `inject`): not rewritten, or the check would fail. Only
 * these documents' scripts are rewritten: elsewhere (an about:blank or srcdoc frame, the DevTools
 * frontend) there is no probe to define the hook. Documents that are gone are dropped.
 */
const probed = new Map<string, Set<string>>();

/** Where the `debugger` statements of the scripts served before are. */
const rewriteStore = cacheStore(self.location.href);
const rewrites = new RewriteCache({ store: rewriteStore, build: DEVTOOLS_ANYWHERE_REWRITE_BUILD });

/** Client ids of shell documents that made the handshake (loaded lazily from the cache). */
let shells: Promise<Set<string>> | undefined;
const loadShells = () =>
  (shells ??= caches
    .open(SHELL_CACHE)
    .then(cache => cache.keys())
    .then(keys => new Set(keys.map(key => decodeURIComponent(key.url.slice(key.url.lastIndexOf('/') + 1)))))
    .catch(() => new Set<string>()));

/** True while a shell that made the handshake is still open as a top-level window. */
async function shellOpen(): Promise<boolean> {
  const ids = await loadShells();
  let open = false;
  for (const id of ids) {
    const client = await self.clients.get(id);
    if (client && client.frameType === 'top-level') open = true;
    else if (!client) {
      ids.delete(id);
      void caches.open(SHELL_CACHE).then(cache => cache.delete(shellKey(id)));
    }
  }
  return open;
}

self.addEventListener('message', event => {
  const source = event.source;
  // A page outside shell mode asks before unregistering this worker (see probe.ts).
  const port = event.ports[0];
  if (event.data?.type === SHELL_QUERY && port) {
    event.waitUntil(shellOpen().then(open => port.postMessage(open)));
    return;
  }
  if (!(source instanceof Client) || event.data?.type !== SHELL_HANDSHAKE) return;
  event.waitUntil(
    loadShells().then(async ids => {
      ids.add(source.id);
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(shellKey(source.id), new Response(''));
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event =>
  // Plans an older worker made may come from an older lexer.
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // A handle opened before this deletion would be orphaned: the record must go in the new cache.
      caches.delete(REWRITE_CACHE).then(() => rewriteStore.forget()),
    ])
  )
);

self.addEventListener('fetch', event => {
  const request = event.request;
  if (!probe) return;
  if (request.mode === 'navigate') {
    // Only iframe navigations: top-level pages pass through untouched.
    if (request.destination !== 'iframe') return;
    event.respondWith(
      shellOpen().then(open => (open ? inject(request, probe, event.resultingClientId) : fetch(request)))
    );
  } else if (
    DESTINATIONS.has(request.destination) &&
    request.method === 'GET' &&
    !request.headers.has('range') &&
    new URL(request.url).origin === self.location.origin
  ) {
    event.respondWith(
      Promise.all([shellOpen(), self.clients.get(event.clientId)]).then(([open, client]) =>
        open && client?.frameType !== 'top-level' ? report(event, client?.type === 'window') : fetch(request)
      )
    );
  }
});

const headersToObject = (headers: Headers) => Object.fromEntries(headers.entries());

/**
 * Passes a subresource through, then tells the requesting page what the response looks like
 * (kept alive by `waitUntil`): the message still arrives before the request's Resource Timing
 * entry, which only exists once the page has read the response.
 */
async function report(event: FetchEvent, fromWindow: boolean): Promise<Response> {
  const request = event.request;
  const original = await fetch(request);
  const integrityUrls = probed.get(event.clientId);
  const response =
    fromWindow &&
    integrityUrls &&
    request.destination === 'script' &&
    !request.integrity &&
    !integrityUrls.has(request.url)
      ? await rewriteDebugger(original, {
          cache: rewrites,
          url: request.url,
          waitUntil: promise => event.waitUntil(promise),
        })
      : original;
  event.waitUntil(
    self.clients.get(event.clientId).then(client =>
      client?.postMessage({
        type: RESPONSE_DETAILS,
        url: request.url,
        requestHeaders: headersToObject(request.headers),
        status: original.status,
        statusText: original.statusText,
        responseHeaders: headersToObject(original.headers),
      } satisfies ResponseDetails)
    )
  );
  return response;
}

async function inject(request: Request, probeUrl: string, clientId: string): Promise<Response> {
  const response = await fetch(request);
  const type = response.headers.get('content-type') || '';
  if (response.type === 'opaqueredirect' || !response.body || !type.includes('text/html')) return response;
  for (const id of probed.keys()) if (!(await self.clients.get(id))) probed.delete(id);
  const integrityUrls = new Set<string>();

  // Scripts with an integrity hash, as the page's markup has them: Chrome leaves `integrity` out
  // of the requests the parser makes for them.
  let markupTail = '';
  const noteIntegrity = (chunk: Uint8Array) => {
    const markup = markupTail + latin1.decode(chunk);
    for (const [tag] of markup.matchAll(/<script\b[^>]*>/gi)) {
      if (!/\sintegrity\s*=/i.test(tag)) continue;
      const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const url = src?.[1] ?? src?.[2] ?? src?.[3];
      if (url === undefined) continue;
      try {
        integrityUrls.add(new URL(url.replace(/&amp;/g, '&'), request.url).href);
      } catch {
        // Not a URL.
      }
    }
    markupTail = markup.slice(-SNIFF_OVERLAP);
  };
  const tag = new TextEncoder().encode(`<script src="${probeUrl.replace(/"/g, '&quot;')}"></script>`);
  // Searched as single-byte text, so string offsets are byte offsets: the page's bytes pass
  // through as they are, whatever its encoding (any ASCII-compatible charset finds <head>).
  const latin1 = new TextDecoder('latin1');
  let pending = new Uint8Array(0);
  /** `pending` as text, decoded a chunk at a time (one byte per character). */
  let text = '';
  /** Where the probe goes: right after <head>, once found. */
  let head = -1;
  let done = false;
  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) out.set(part, (at += part.length) - part.length);
    return out;
  };
  const injectAt = (at: number) => {
    if (clientId) probed.set(clientId, integrityUrls);
    return concat(pending.subarray(0, at), tag, pending.subarray(at));
  };

  // Streams the page through, deciding as soon as <head> and the tag after it arrive: the
  // DevTools frontend (its marker already received) passes through untouched, other pages get
  // the probe right after <head>. A page without <head> early (anywhere_app.html has none) is held back until its
  // marker, </head> or <body>, at most SNIFF_LIMIT bytes, then gets the probe at the start.
  // Only the new chunk (plus a little of the text before it, for a tag split across chunks)
  // is searched; the whole response is never buffered.
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      noteIntegrity(chunk);
      if (done) return controller.enqueue(chunk);
      const from = Math.max(0, text.length - SNIFF_OVERLAP);
      pending = concat(pending, chunk);
      text += latin1.decode(chunk);
      const recent = text.slice(from);
      let out: Uint8Array | undefined;
      if (FRONTEND.test(recent)) out = pending;
      else {
        const match = head < 0 ? /<head\b[^>]*>/i.exec(recent) : null;
        if (match) head = from + match.index + match[0].length;
        // The frontend's marker is the tag right after <head>: until that tag is complete
        // (it may come in the next chunk), the page is held back.
        if (head >= 0) {
          if (/^\s*(?:[^\s<]|<[^>]*>)/.test(text.slice(head)) || pending.length >= SNIFF_LIMIT) out = injectAt(head);
        } else if (/<\/head\b|<body\b/i.test(recent) || pending.length >= SNIFF_LIMIT) out = injectAt(0);
      }
      if (!out) return;
      controller.enqueue(out);
      done = true;
      pending = new Uint8Array(0);
      text = '';
    },
    flush(controller) {
      if (!done) controller.enqueue(injectAt(head >= 0 ? head : 0));
    },
  });

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
