// devtools-anywhere-sw.js: optional Service Worker for shell mode.
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
// single-byte.
//
// A Service Worker needs a secure context (HTTPS or localhost), and its scope must cover
// the pages: serve this file from the site root or with `Service-Worker-Allowed: /`.

// Type-checked with the WebWorker library (tsconfig.sw.json), separately from the DOM code.
declare const self: ServiceWorkerGlobalScope;
import { debuggerStatementSites } from '../../cdp-server/src/core/lexer';

const params = new URL(self.location.href).searchParams;
const probe = params.get('probe');
const SNIFF_LIMIT = 64 * 1024;
/** Text re-searched before each new chunk, so a tag split across chunks is still found. */
const SNIFF_OVERLAP = 1024;
/** Marks the DevTools frontend page, which must not get the probe. */
const FRONTEND =
  /<meta\b[^>]*\bname\s*=\s*["']?devtools-anywhere-frontend\b|entrypoints\/anywhere_app\/anywhere_app\.js/i;
/** Message type the probe listens for; keep in sync with cdp-server's probe. */
const DETAILS = 'devtools-anywhere:response';
const DESTINATIONS = new Set(['style', 'script', 'image', 'font']);
/** Handshake message the shell posts to this worker; keep in sync with element.ts. */
const SHELL = 'devtools-anywhere:shell';
/** Asks whether a shell is open (answered on the transferred port); keep in sync with probe.ts. */
const SHELL_QUERY = 'devtools-anywhere:shell-open';
const SHELL_CACHE = 'devtools-anywhere-sw-shells';
/**
 * `debugger` (8 characters) becomes a call of the probe's hook (keep the name in sync with the
 * probe), a statement of its own whatever follows on the next line. When the next token is a `;`
 * (past comments and line breaks), the call takes no other one: `if (a) debugger; else …` must stay one statement.
 */
const DEBUGGER_CALL = '_$dbg();';
const DEBUGGER_CALL_BEFORE_SEMICOLON = '_$dbg() ';
const shellKey = (id: string) =>
  new URL(`/__devtools-anywhere-shell/${encodeURIComponent(id)}`, self.location.href).href;

/**
 * Same-origin scripts with an integrity hash in the pages this worker passed through (see
 * `inject`): not rewritten, or the check would fail.
 */
const integrityUrls = new Set<string>();

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
  if (!(source instanceof Client) || event.data?.type !== SHELL) return;
  event.waitUntil(
    loadShells().then(async ids => {
      ids.add(source.id);
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(shellKey(source.id), new Response(''));
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (!probe) return;
  if (request.mode === 'navigate') {
    // Only iframe navigations: top-level pages pass through untouched.
    if (request.destination !== 'iframe') return;
    event.respondWith(shellOpen().then(open => (open ? inject(request, probe) : fetch(request))));
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
  const response =
    fromWindow && request.destination === 'script' && !request.integrity && !integrityUrls.has(request.url)
      ? await rewriteDebugger(original)
      : original;
  event.waitUntil(
    self.clients.get(event.clientId).then(client =>
      client?.postMessage({
        type: DETAILS,
        url: request.url,
        requestHeaders: headersToObject(request.headers),
        status: original.status,
        statusText: original.statusText,
        responseHeaders: headersToObject(original.headers),
      })
    )
  );
  return response;
}

/** The response's charset label, UTF-8 by default. */
function charsetOf(type: string): string {
  return /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1]?.toLowerCase() ?? 'utf-8';
}

/** Single-byte charsets with no-break space at 0xA0, like the lexer takes it. */
const SINGLE_BYTE = /^(?:windows-125\d|iso-8859-\d+|iso8859-\d+|latin1|iso-latin-1|l1|cp125\d|us-ascii|ascii)$/;

/**
 * The script as text, and the byte offset of each of its characters; undefined for an encoding
 * this cannot map back to bytes (UTF-16, Shift_JIS and the other multi-byte ones), or a UTF-8
 * script that is not valid UTF-8. A BOM decides the encoding first, as it does for the page.
 */
function decodeScript(
  bytes: Uint8Array,
  charset: string
): { text: string; byteOffset: (index: number) => number } | undefined {
  const utf16Bom = (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe);
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (utf16Bom) return undefined;
  if (utf8Bom || charset === 'utf-8' || charset === 'utf8' || charset === 'unicode-1-1-utf-8') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return undefined;
    }
    const offsets = new Uint32Array(text.length + 1);
    let at = 0;
    for (let i = 0; i < text.length; i++) {
      offsets[i] = at;
      const code = text.charCodeAt(i);
      // A surrogate pair is 4 bytes, counted on its first half.
      if (code < 0x80) at += 1;
      else if (code < 0x800) at += 2;
      else if (code >= 0xd800 && code < 0xdc00) at += 4;
      else if (code >= 0xdc00 && code < 0xe000) at += 0;
      else at += 3;
    }
    offsets[text.length] = at;
    return { text, byteOffset: index => offsets[index] ?? at };
  }
  // One character per byte: the offsets are the byte offsets.
  if (SINGLE_BYTE.test(charset)) return { text: new TextDecoder('latin1').decode(bytes), byteOffset: index => index };
  return undefined;
}

/**
 * Replaces the `debugger` statements of a JavaScript response with `DEBUGGER_CALL`, in place in
 * its bytes: the replacement is ASCII of the same length, so every other byte stays as it is. A
 * response with nothing to replace is returned as it is.
 *
 * Scripts are lexed as classic ones, which only differ from modules in taking `<!--` (and `-->`
 * at the start of a line) as comments. The request does not tell the two apart (a classic script
 * with `crossorigin` is a CORS request too), and classic is the safer guess: in a module `<!--`
 * is near impossible (`a <!--b`, a comparison with a negated decrement), while a classic script
 * read as a module would have its HTML-like comments lexed as code.
 */
async function rewriteDebugger(response: Response): Promise<Response> {
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !response.body || !/javascript|ecmascript/i.test(type)) return response;
  // Read from a copy, so the original goes to the page untouched when nothing is replaced.
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  const decoded = decodeScript(bytes, charsetOf(type));
  if (!decoded) return response;
  const { text, byteOffset } = decoded;
  let replaced = false;
  if (text.includes('debugger')) {
    for (const { start: offset, semicolon } of debuggerStatementSites(text)) {
      // An escaped keyword is not valid code: only the plain one is replaced.
      if (!text.startsWith('debugger', offset)) continue;
      const call = semicolon ? DEBUGGER_CALL_BEFORE_SEMICOLON : DEBUGGER_CALL;
      const at = byteOffset(offset);
      for (let i = 0; i < call.length; i++) bytes[at + i] = call.charCodeAt(i);
      replaced = true;
    }
  }
  if (!replaced) return response;
  const headers = new Headers(response.headers);
  // The body is already decoded, and its length is now that of the bytes.
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
}

async function inject(request: Request, probeUrl: string): Promise<Response> {
  const response = await fetch(request);
  const type = response.headers.get('content-type') || '';
  if (response.type === 'opaqueredirect' || !response.body || !type.includes('text/html')) return response;

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
  const injectAt = (at: number) => concat(pending.subarray(0, at), tag, pending.subarray(at));

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
