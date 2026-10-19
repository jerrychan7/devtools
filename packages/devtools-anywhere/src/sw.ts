// devtools-anywhere-sw.js: optional Service Worker for shell mode.
//
// While shell mode is on, it injects the probe at the top of <head> of every same-origin
// page loaded into an iframe, so pages that do not include the probe themselves are still
// captured when the page iframe navigates to them. The shell registers it with the probe
// URL in the query string (`?probe=…`) and unregisters it when shell mode ends. The DevTools
// frontend page (`&skip=…`, its URL without query or hash) is left alone even if same-origin.
//
// It also reports the details Resource Timing does not expose (request and response headers,
// status text) of same-origin subresources (style sheets, scripts, images, fonts) to
// the page that requested them; the probe adds them to its records. Cross-origin, ranged and
// non-GET requests pass through untouched, so the page's behavior does not change.
//
// A Service Worker needs a secure context (HTTPS or localhost), and its scope must cover
// the pages: serve this file from the site root or with `Service-Worker-Allowed: /`.

// Type-checked with the WebWorker library (tsconfig.sw.json), separately from the DOM code.
declare const self: ServiceWorkerGlobalScope;
export {};

const params = new URL(self.location.href).searchParams;
const probe = params.get('probe');
const skip = params.get('skip');
const SNIFF_LIMIT = 64 * 1024;
/** Message type the probe listens for; keep in sync with cdp-server's probe. */
const DETAILS = 'devtools-anywhere:response';
const DESTINATIONS = new Set(['style', 'script', 'image', 'font']);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (!probe) return;
  if (request.mode === 'navigate') {
    // Only iframe navigations: top-level pages pass through untouched.
    if (request.destination !== 'iframe') return;
    const url = new URL(request.url);
    if (url.origin + url.pathname !== skip) event.respondWith(inject(request, probe));
  } else if (
    DESTINATIONS.has(request.destination) &&
    request.method === 'GET' &&
    !request.headers.has('range') &&
    new URL(request.url).origin === self.location.origin
  ) {
    event.respondWith(report(event));
  }
});

const headersToObject = (headers: Headers) => Object.fromEntries(headers.entries());

/**
 * Passes a subresource through, then tells the requesting page what the response looks like
 * (kept alive by `waitUntil`): the message still arrives before the request's Resource Timing
 * entry, which only exists once the page has read the response.
 */
async function report(event: FetchEvent): Promise<Response> {
  const request = event.request;
  const response = await fetch(request);
  event.waitUntil(
    self.clients.get(event.clientId).then(client =>
      client?.postMessage({
        type: DETAILS,
        url: request.url,
        requestHeaders: headersToObject(request.headers),
        status: response.status,
        statusText: response.statusText,
        responseHeaders: headersToObject(response.headers),
      })
    )
  );
  return response;
}

async function inject(request: Request, probeUrl: string): Promise<Response> {
  const response = await fetch(request);
  const type = response.headers.get('content-type') || '';
  if (response.type === 'opaqueredirect' || !response.body || !type.includes('text/html')) return response;

  const tag = new TextEncoder().encode(`<script src="${probeUrl.replace(/"/g, '&quot;')}"></script>`);
  // Searched as single-byte text, so string offsets are byte offsets: the page's bytes pass
  // through as they are, whatever its encoding (any ASCII-compatible charset finds <head>).
  const latin1 = new TextDecoder('latin1');
  let pending = new Uint8Array(0);
  let done = false;
  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) out.set(part, (at += part.length) - part.length);
    return out;
  };

  // Streams the page through, inserting the probe right after <head> (or at the start if
  // there is no <head> early in the document), without buffering the whole response.
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (done) return controller.enqueue(chunk);
      pending = concat(pending, chunk);
      const head = /<head\b[^>]*>/i.exec(latin1.decode(pending));
      if (head) {
        const at = head.index + head[0].length;
        controller.enqueue(concat(pending.subarray(0, at), tag, pending.subarray(at)));
      } else if (pending.length < SNIFF_LIMIT) {
        return;
      } else {
        controller.enqueue(concat(tag, pending));
      }
      done = true;
      pending = new Uint8Array(0);
    },
    flush(controller) {
      if (!done) controller.enqueue(concat(tag, pending));
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
