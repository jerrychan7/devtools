// Static server for the playground and the tests. Serves the repository root.
//
//   node playground/server.ts [port]
//
// Any request accepts `?delay=<ms>`. `/api/echo` returns the request as JSON, and
// `/ws/echo` is a WebSocket endpoint that sends every message back.
import http from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const types: Record<string, string> = {
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
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Encodes one unmasked, unfragmented frame (server to client). */
function wsFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) header[1] = length;
  else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Minimal RFC 6455 echo: text and binary messages are sent back, close is answered. */
function wsEcho(req: http.IncomingMessage, socket: Duplex) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  const protocol = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')[0]
    ?.trim();
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') +
      '\r\n'
  );
  let buffer = Buffer.alloc(0);
  // A fragmented message (Chrome sends Blobs that way) is echoed once complete.
  let message: { opcode: number; parts: Buffer[] } | null = null;
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Client frames are always masked.
    for (;;) {
      if (buffer.length < 2) return;
      const b0 = buffer.readUInt8(0);
      const b1 = buffer.readUInt8(1);
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload.writeUInt8(payload.readUInt8(i) ^ mask.readUInt8(i % 4), i);
      buffer = buffer.subarray(offset + 4 + length);
      const opcode = b0 & 0x0f;
      if (opcode === 1 || opcode === 2) message = { opcode, parts: [] };
      if (opcode <= 2 && message) {
        message.parts.push(payload);
        if (b0 & 0x80) {
          socket.write(wsFrame(message.opcode, Buffer.concat(message.parts)));
          message = null;
        }
      } else if (opcode === 9) socket.write(wsFrame(10, payload));
      else if (opcode === 8) {
        socket.end(wsFrame(8, payload));
        return;
      }
    }
  });
  socket.on('error', () => socket.destroy());
}

/** Starts the server; resolves with its base URL. Port 0 picks a free port. */
export interface PlaygroundServer {
  url: string;
  close(): void;
}

export function startServer(port = 0): Promise<PlaygroundServer> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const delay = Number(url.searchParams.get('delay')) || 0;
    if (delay) await sleep(delay);

    if (url.pathname === '/api/echo') {
      let body = '';
      for await (const chunk of req) body += chunk;
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
        // Lets devtools-anywhere-sw.js control the whole site from its dist directory.
        ...(target.endsWith('-sw.js') ? { 'service-worker-allowed': '/' } : {}),
        // Style sheets are readable from other origins (the tests load them cross-origin).
        ...(target.endsWith('.css') ? { 'access-control-allow-origin': '*' } : {}),
      });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname === '/ws/echo') wsEcho(req, socket);
    else socket.destroy();
  });
  return new Promise(resolve => {
    server.listen(port, () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({ url: `http://localhost:${actual}`, close: () => server.close() });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.argv[2]) || 8788);
  console.log(`${url}/playground/`);
}
