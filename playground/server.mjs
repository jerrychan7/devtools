// Static server for the playground and the tests. Serves the repository root.
//
//   node playground/server.mjs [port]
//
// Any request accepts `?delay=<ms>`. `/api/echo` returns the request as JSON.
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.avif': 'image/avif',
  '.wasm': 'application/wasm',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Starts the server; resolves with its base URL. Port 0 picks a free port. */
export function startServer(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const delay = Number(url.searchParams.get('delay')) || 0
    if (delay) await sleep(delay)

    if (url.pathname === '/api/echo') {
      let body = ''
      for await (const chunk of req) body += chunk
      res.writeHead(200, { 'content-type': 'application/json', 'x-echo': '1' })
      res.end(JSON.stringify({ method: req.method, query: Object.fromEntries(url.searchParams), body }))
      return
    }

    const file = path.join(root, decodeURIComponent(url.pathname))
    if (!file.startsWith(root)) return res.writeHead(403).end()
    try {
      const stat = await fs.stat(file)
      const target = stat.isDirectory() ? path.join(file, 'index.html') : file
      const data = await fs.readFile(target)
      res.writeHead(200, {
        'content-type': types[path.extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store',
        // Lets devtools-anywhere-sw.js control the whole site from its dist directory.
        ...(target.endsWith('-sw.js') ? { 'service-worker-allowed': '/' } : {}),
      })
      res.end(data)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise(resolve => {
    server.listen(port, () => {
      resolve({ url: `http://localhost:${server.address().port}`, close: () => server.close() })
    })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.argv[2]) || 8788)
  console.log(`${url}/playground/`)
}
