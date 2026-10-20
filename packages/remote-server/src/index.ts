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
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { listPage } from './list-page';
import { Target, type Peer } from './relay';

export interface RemoteServerOptions {
  /** Default: 8080. 0 picks a free port. */
  port?: number;
  /** Default: all interfaces, so that other devices can connect. */
  host?: string;
  /** Path everything is served under, such as `/devtools/`. Default: `/`. */
  basePath?: string;
  /**
   * Needed to see the target list and inspect a page. Default: a random token. `false` lets
   * anyone who can reach the server inspect every page connected to it.
   */
  token?: string | false;
  /** Serves over HTTPS (and WSS), for pages that are themselves served over HTTPS. */
  https?: { cert: string | Buffer; key: string | Buffer };
  /** A DevTools frontend build to serve. Default: @devtools-anywhere/devtools-frontend. */
  frontendDir?: string;
}

export interface RemoteServer {
  /** The target list, with the token: what to open on the inspecting machine. */
  readonly url: string;
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

/** Starts a remote debugging server; resolves once it listens. */
export async function startRemoteServer(options: RemoteServerOptions = {}): Promise<RemoteServer> {
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
  const secure = !!options.https;
  const targets = new Map<string, Target>();

  const authorized = (url: URL) => token === false || sameToken(url.searchParams.get('token'), token);
  const forget = (target: Target) => {
    if (!target.connected && !target.attached) targets.delete(target.id);
  };

  /** The target list as JSON, in the shape of Chrome's /json/list. */
  function list(host: string) {
    const query = token === false ? '' : `?token=${token}`;
    return [...targets.values()]
      .filter(target => target.connected)
      .map(target => {
        const socket = `${host}${base}client/${target.id}${query}`;
        return {
          id: target.id,
          type: 'page',
          title: target.info.title,
          url: target.info.url,
          faviconUrl: target.info.favicon,
          userAgent: target.info.userAgent,
          since: target.since,
          attached: target.attached,
          devtoolsFrontendUrl: `${base}front_end/anywhere_app.html?${secure ? 'wss' : 'ws'}=${encodeURIComponent(socket)}`,
          webSocketDebuggerUrl: `${secure ? 'wss' : 'ws'}://${socket}`,
        };
      });
  }

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (!url.pathname.startsWith(base)) return send(404, 'text/plain', 'Not found');
    const rel = url.pathname.slice(base.length);
    if (rel === '' || rel === 'json' || rel === 'json/list') {
      if (!authorized(url)) {
        return send(401, 'text/plain; charset=utf-8', 'Open the URL the server printed: it has the token.');
      }
      if (rel === '') return send(200, 'text/html; charset=utf-8', listPage(base));
      return send(200, 'application/json; charset=utf-8', JSON.stringify(list(req.headers.host ?? 'localhost')));
    }
    const file = rel.startsWith('front_end/')
      ? (fileIn(frontendDir, rel.slice('front_end/'.length)) ?? fileIn(localesDir, rel.slice('front_end/'.length)))
      : fileIn(dist, rel);
    if (!file) return send(404, 'text/plain', 'Not found');
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    // Bundled frontend files are named after their content; everything else is revalidated.
    res.setHeader('cache-control', rel.startsWith('front_end/bundle/') ? 'max-age=31536000, immutable' : 'no-cache');
    // Pages on any origin load the probe and its bundle (and the bundle loads snapDOM).
    res.setHeader('access-control-allow-origin', '*');
    createReadStream(file)
      .on('error', () => (res.headersSent ? res.destroy() : send(500, 'text/plain', 'Read failed')))
      .pipe(res);
  };

  const server = options.https ? https.createServer(options.https, onRequest) : http.createServer(onRequest);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [kind, id = ''] = url.pathname.slice(base.length).split('/');
    const ok =
      url.pathname.startsWith(base) &&
      TARGET_ID.test(id) &&
      (kind === 'target' || (kind === 'client' && authorized(url) && targets.get(id)?.connected));
    if (!ok) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      let target = targets.get(id);
      if (!target) targets.set(id, (target = new Target(id)));
      const peer: Peer = { send: data => ws.send(data), close: (code, reason) => ws.close(code, reason) };
      const relay = target;
      if (kind === 'target') {
        relay.attachPage(peer);
        ws.on('message', data => relay.fromPage(data.toString()));
        ws.on('close', () => {
          relay.detachPage(peer);
          forget(relay);
        });
      } else {
        relay.attachClient(peer);
        ws.on('message', data => relay.fromClient(data.toString()));
        ws.on('close', () => {
          relay.detachClient(peer);
          forget(relay);
        });
      }
      ws.on('error', () => ws.terminate());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8080, options.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 8080);
  const origin = `${secure ? 'https' : 'http'}://${options.host && options.host !== '0.0.0.0' ? options.host : 'localhost'}:${port}`;
  return {
    url: `${origin}${base}${token === false ? '' : `?token=${token}`}`,
    scriptTag: `<script src="${origin}${base}probe.iife.js" data-remote></script>`,
    token,
    server,
    close() {
      for (const ws of sockets.clients) ws.terminate();
      return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    },
  };
}
