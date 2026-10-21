// Remote debugging: a page on one device (a phone, mostly) connects here, and Chrome DevTools on
// another machine inspects it through this server.
//
//   page ──ws──▶ <base>target/<id>          the page's CDP server (probe.iife.js data-remote)
//   DevTools ──ws──▶ <base>client/<id>      the frontend, opened from the target list
//
// The server also serves what both sides load: the probe and its bundle for the page, the
// DevTools frontend for the inspecting machine, and the target list at <base>.
//
// A client can run any script in the page it inspects, so the target list and the client
// connections need the server's token. Pages connect without it: any page may ask to be
// inspected, which only puts it on the list.

import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { listPage } from './list-page';
import { Target, type Peer } from './relay';

export interface RemoteHandlerOptions {
  /** Path everything is served under, such as `/devtools/`. Default: `/`. */
  basePath?: string;
  /**
   * Needed to see the target list and inspect a page. Default: a random token. `false` lets
   * anyone who can reach the server inspect every page connected to it.
   */
  token?: string | false;
  /** A DevTools frontend build to serve. Default: @devtools-anywhere/devtools-frontend. */
  frontendDir?: string;
  /**
   * URL of the frontend's `anywhere_app.html` hosted elsewhere (a CDN), opened from the target
   * list instead of the one this server serves. An HTTPS frontend can only connect to a server
   * over WSS.
   */
  frontendUrl?: string;
  /**
   * The server's URL as pages reach it (behind a proxy, its public URL): what the target list's
   * script tag names. Default: the URL the list is opened at.
   */
  publicUrl?: string;
}

/**
 * Remote debugging as request and upgrade handlers, to mount in a server of one's own:
 *
 *   const remote = createRemoteHandler({ basePath: '/devtools/' });
 *   server.on('request', (req, res) => remote.handleRequest(req, res) || app(req, res));
 *   server.on('upgrade', (req, socket, head) => remote.handleUpgrade(req, socket, head) || socket.destroy());
 */
export interface RemoteHandler {
  readonly basePath: string;
  readonly token: string | false;
  /** Answers a request under basePath and returns true; returns false for any other. */
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  /** Takes a WebSocket upgrade under basePath and returns true; returns false for any other. */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Closes every connection. */
  close(): void;
}

export interface RemoteServerOptions extends RemoteHandlerOptions {
  /** Default: 8080. 0 picks a free port. */
  port?: number;
  /** Default: all interfaces, so that other devices can connect. */
  host?: string;
  /** Serves over HTTPS (and WSS), for pages that are themselves served over HTTPS. */
  https?: { cert: string | Buffer; key: string | Buffer };
}

export interface RemoteServer {
  /** The target list, with the token: what to open on this machine. */
  readonly url: string;
  /** The server's URL as pages reach it. */
  readonly publicUrl: string;
  /** The script tag for pages to connect with. */
  readonly scriptTag: string;
  readonly token: string | false;
  readonly server: http.Server;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
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
/** Target ids: what the page picks (see packages/devtools-anywhere/src/remote.ts). */
const TARGET_ID = /^[\w-]{1,64}$/;
/** How long a page that went away stays on the list, for it to come back (a reload, a dropped connection). */
const GONE_TTL = 60_000;
/** Pages the server keeps at most: each one connected, or gone and not forgotten yet. */
const MAX_TARGETS = 1000;

/** Directory of an installed package's file, or undefined if the package is not installed. */
function packageDir(require: NodeJS.Require, file: string): string | undefined {
  try {
    return path.dirname(require.resolve(file));
  } catch {
    return undefined;
  }
}

/** `rel` inside `dir`, if it is a file there. */
function fileIn(dir: string | undefined, rel: string): string | undefined {
  if (!dir) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return undefined; // Malformed escape such as `%E0`: not a file of ours.
  }
  const file = path.resolve(dir, decoded);
  if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) return undefined;
  return file;
}

function sameToken(given: string | null, token: string) {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** This machine's first LAN IPv4 address, if any. */
function lanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) if (address.family === 'IPv4' && !address.internal) return address.address;
  }
  return undefined;
}

/** Creates the request and upgrade handlers of a remote debugging server. */
export function createRemoteHandler(options: RemoteHandlerOptions = {}): RemoteHandler {
  const require = createRequire(import.meta.url);
  const dist = path.dirname(require.resolve('devtools-anywhere/probe.iife.js'));
  const frontendDir = path.resolve(
    options.frontendDir ??
      packageDir(require, '@devtools-anywhere/devtools-frontend/anywhere_app.html') ??
      '@devtools-anywhere/devtools-frontend is not installed'
  );
  // Optional: translations beyond English and Chinese, laid out like the frontend.
  const localesDir = packageDir(require, '@devtools-anywhere/devtools-frontend-locales/REVISION');
  const base = `/${(options.basePath ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
  const token = options.token ?? randomBytes(16).toString('hex');
  const targets = new Map<string, Target>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });

  const authorized = (url: URL) => token === false || sameToken(url.searchParams.get('token'), token);
  /** Behind a TLS proxy too, as long as it says so. */
  const secure = (req: http.IncomingMessage) =>
    req.socket instanceof TLSSocket || req.headers['x-forwarded-proto'] === 'https';
  /** Drops a target nothing is connected to, once it has had time to come back. */
  const forget = (target: Target) => {
    setTimeout(() => {
      if (!target.connected && target.clients === 0 && Date.now() - target.changed >= GONE_TTL) {
        targets.delete(target.id);
      }
    }, GONE_TTL).unref();
  };

  /** The target list as JSON, in the shape of Chrome's /json/list (plus its own fields). */
  function list(req: http.IncomingMessage) {
    const query = token === false ? '' : `?token=${token}`;
    const ws = secure(req) ? 'wss' : 'ws';
    const frontend = options.frontendUrl ?? `${base}front_end/anywhere_app.html`;
    // The frontend's URL may have a query (a version) and a fragment of its own.
    const hash = frontend.indexOf('#');
    const page = hash < 0 ? frontend : frontend.slice(0, hash);
    const fragment = hash < 0 ? '' : frontend.slice(hash);
    // A frontend served from elsewhere (a CDN) gets the socket, with its token, in the fragment,
    // which the browser does not send there.
    const inFragment = options.frontendUrl !== undefined;
    return [...targets.values()].map(target => {
      const socket = `${req.headers.host ?? 'localhost'}${base}client/${target.id}${query}`;
      return {
        id: target.id,
        type: 'page',
        title: target.info.title,
        url: target.info.url,
        faviconUrl: target.info.favicon,
        userAgent: target.info.userAgent,
        since: target.since,
        connected: target.connected,
        clients: target.clients,
        devtoolsFrontendUrl: inFragment
          ? `${page}${fragment || '#?'}${fragment.length > 1 ? '&' : ''}${ws}=${encodeURIComponent(socket)}`
          : `${page}${page.includes('?') ? '&' : '?'}${ws}=${encodeURIComponent(socket)}${fragment}`,
        webSocketDebuggerUrl: `${ws}://${socket}`,
      };
    });
  }

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(base)) return false;
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const rel = url.pathname.slice(base.length);
    if (rel === '' || rel === 'json' || rel === 'json/list') {
      if (!authorized(url)) {
        send(401, 'text/plain; charset=utf-8', 'Open the URL the server printed: it has the token.');
      } else if (rel === '') {
        send(200, 'text/html; charset=utf-8', listPage(base, options.publicUrl));
      } else {
        send(200, 'application/json; charset=utf-8', JSON.stringify(list(req)));
      }
      return true;
    }
    const file = rel.startsWith('front_end/')
      ? (fileIn(frontendDir, rel.slice('front_end/'.length)) ?? fileIn(localesDir, rel.slice('front_end/'.length)))
      : fileIn(dist, rel);
    if (!file) {
      send(404, 'text/plain', 'Not found');
      return true;
    }
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    // Bundled frontend files are named after their content; everything else is revalidated.
    res.setHeader('cache-control', rel.startsWith('front_end/bundle/') ? 'max-age=31536000, immutable' : 'no-cache');
    // Pages on any origin load the probe and its bundle (and the bundle loads snapDOM).
    res.setHeader('access-control-allow-origin', '*');
    // What revalidation goes by: unchanged, the file is not sent again.
    const { mtime, size } = statSync(file);
    const etag = `W/"${size.toString(16)}-${Math.floor(mtime.getTime()).toString(16)}"`;
    res.setHeader('etag', etag);
    res.setHeader('last-modified', mtime.toUTCString());
    const ifNoneMatch = req.headers['if-none-match'];
    const ifModifiedSince = Date.parse(req.headers['if-modified-since'] ?? '');
    const fresh =
      ifNoneMatch !== undefined
        ? ifNoneMatch.split(',').some(tag => tag.trim() === etag || tag.trim() === '*')
        : ifModifiedSince >= Math.floor(mtime.getTime() / 1000) * 1000;
    if (fresh) {
      res.writeHead(304);
      res.end();
      return true;
    }
    createReadStream(file)
      .on('error', () => (res.headersSent ? res.destroy() : send(500, 'text/plain', 'Read failed')))
      .pipe(res);
    return true;
  }

  function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(base)) return false;
    const [kind, id = ''] = url.pathname.slice(base.length).split('/');
    // Any page may connect, but only so many: a new one past the limit is turned away.
    const room = targets.has(id) || targets.size < MAX_TARGETS;
    const ok =
      TARGET_ID.test(id) && ((kind === 'target' && room) || (kind === 'client' && authorized(url) && targets.has(id)));
    if (!ok) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return true;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      let target = targets.get(id);
      if (!target) targets.set(id, (target = new Target(id)));
      const peer: Peer = { send: data => ws.send(data), close: (code, reason) => ws.close(code, reason) };
      const relay = target;
      if (kind === 'target') {
        relay.attachPage(peer);
        ws.on('message', data => relay.fromPage(peer, data.toString()));
        ws.on('close', () => {
          relay.detachPage(peer);
          forget(relay);
        });
      } else {
        relay.attachClient(peer);
        ws.on('message', data => relay.fromClient(peer, data.toString()));
        ws.on('close', () => {
          relay.detachClient(peer);
          forget(relay);
        });
      }
      ws.on('error', () => ws.terminate());
    });
    return true;
  }

  return {
    basePath: base,
    token,
    handleRequest,
    handleUpgrade,
    close() {
      for (const ws of sockets.clients) ws.terminate();
    },
  };
}

/** Starts a remote debugging server; resolves once it listens. */
export async function startRemoteServer(options: RemoteServerOptions = {}): Promise<RemoteServer> {
  // Created once the server listens, when its port (and so its public URL) is known.
  let handler: RemoteHandler | undefined;
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!handler?.handleRequest(req, res)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  };
  const server = options.https ? https.createServer(options.https, onRequest) : http.createServer(onRequest);
  server.on('upgrade', (req, socket, head) => {
    if (!handler?.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8080, options.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 8080);
  const scheme = options.https ? 'https' : 'http';
  const base = `/${(options.basePath ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
  const anyHost = !options.host || options.host === '0.0.0.0' || options.host === '::';
  // An IPv6 address is bracketed in a URL.
  const host = anyHost ? 'localhost' : options.host?.includes(':') ? `[${options.host}]` : options.host;
  const local = `${scheme}://${host}:${port}${base}`;
  const lan = anyHost ? lanAddress() : undefined;
  const publicUrl = options.publicUrl
    ? new URL(options.publicUrl).href.replace(/\/?$/, '/')
    : lan
      ? `${scheme}://${lan}:${port}${base}`
      : local;
  const ready = createRemoteHandler({ ...options, publicUrl });
  handler = ready;
  const { token } = ready;
  return {
    url: `${local}${token === false ? '' : `?token=${token}`}`,
    publicUrl,
    scriptTag: `<script src="${publicUrl}probe.iife.js" data-remote></script>`,
    token,
    server,
    close() {
      ready.close();
      return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    },
  };
}
