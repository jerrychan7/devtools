// Static server for the early-capture experiment.
// Serves the repository root so the pages can reach the local Chii build
// (chii.ignore/public/front_end) and chobitsu (chii.ignore/node_modules/chobitsu).
//
//   node experiments/early-capture/server.ts [port]
//
// Any request accepts `?delay=<ms>` to simulate a slow network.
// `/api/echo` returns the request as JSON.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.argv[2]) || 8787;

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.avif': 'image/avif',
  '.wasm': 'application/wasm',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const delay = Number(url.searchParams.get('delay')) || 0;
    if (delay) await sleep(delay);

    if (url.pathname === '/') {
      res.writeHead(302, { location: '/experiments/early-capture/' }).end();
      return;
    }

    if (url.pathname === '/api/echo') {
      let body = '';
      try {
        for await (const chunk of req) body += chunk;
      } catch {
        // The client went away mid-request (e.g. a navigation aborted it): nothing to answer.
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-echo': '1' });
      res.end(JSON.stringify({ method: req.method, query: Object.fromEntries(url.searchParams), body }));
      return;
    }

    const file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const stat = await fs.stat(file);
      const target = stat.isDirectory() ? path.join(file, 'index.html') : file;
      const data = await fs.readFile(target);
      res.writeHead(200, {
        'content-type': types[path.extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(port, () => console.log(`http://localhost:${port}/experiments/early-capture/`));
