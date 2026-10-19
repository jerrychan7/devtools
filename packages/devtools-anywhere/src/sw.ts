// devtools-anywhere-sw.js: optional Service Worker for shell mode.
//
// While shell mode is on, it injects the probe at the top of <head> of every same-origin
// page loaded into an iframe, so pages that do not include the probe themselves are still
// captured when the page iframe navigates to them. The shell registers it with the probe
// URL in the query string (`?probe=…`) and unregisters it when shell mode ends.
//
// A Service Worker needs a secure context (HTTPS or localhost), and its scope must cover
// the pages: serve this file from the site root or with `Service-Worker-Allowed: /`.

// The DOM typings in this package do not include the Service Worker global scope.
const scope = globalThis as any

const probe = new URL(scope.location.href).searchParams.get('probe')
const SNIFF_LIMIT = 64 * 1024

scope.addEventListener('install', () => scope.skipWaiting())
scope.addEventListener('activate', (event: any) => event.waitUntil(scope.clients.claim()))

scope.addEventListener('fetch', (event: any) => {
  const request: Request = event.request
  // Only iframe navigations: top-level pages and subresources pass through untouched.
  if (!probe || request.mode !== 'navigate' || request.destination !== 'iframe') return
  event.respondWith(inject(request, probe))
})

async function inject(request: Request, probeUrl: string): Promise<Response> {
  const response = await fetch(request)
  const type = response.headers.get('content-type') || ''
  if (response.type === 'opaqueredirect' || !response.body || !type.includes('text/html')) return response

  const tag = `<script src="${probeUrl.replace(/"/g, '&quot;')}"></script>`
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  let done = false

  // Streams the page through, inserting the probe right after <head> (or at the start if
  // there is no <head> early in the document), without buffering the whole response.
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (done) return controller.enqueue(chunk)
      pending += decoder.decode(chunk, { stream: true })
      const head = /<head\b[^>]*>/i.exec(pending)
      if (head) {
        const at = head.index + head[0].length
        pending = pending.slice(0, at) + tag + pending.slice(at)
      } else if (pending.length < SNIFF_LIMIT) {
        return
      } else {
        pending = tag + pending
      }
      done = true
      controller.enqueue(encoder.encode(pending))
      pending = ''
    },
    flush(controller) {
      pending += decoder.decode()
      if (!done) controller.enqueue(encoder.encode(tag + pending))
    },
  })

  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
