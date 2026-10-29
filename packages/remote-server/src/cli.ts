// devtools-anywhere-remote: starts a remote debugging server and prints how to use it.
//
//   devtools-anywhere-remote [--port 8080] [--host 0.0.0.0] [--base-path /] [--token <t> | --no-token]
//                            [--cert cert.pem --key key.pem] [--public-url <url>]
//                            [--devtools-frontend-path <file> | --devtools-frontend-url <url>] [--id-in-query]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { startRemoteServer, type RemoteServerOptions } from './index';

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'base-path': { type: 'string' },
    token: { type: 'string' },
    'no-token': { type: 'boolean' },
    cert: { type: 'string' },
    key: { type: 'string' },
    'public-url': { type: 'string' },
    'devtools-frontend-path': { type: 'string' },
    'devtools-frontend-url': { type: 'string' },
    'id-in-query': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`Usage: devtools-anywhere-remote [options]

  -p, --port <port>        Port to listen on (default: 8080)
      --host <host>        Interface to listen on (default: all)
      --base-path <path>   Path to serve everything under (default: /)
      --token <token>      Token needed to list and inspect pages (default: random)
      --no-token           Let anyone who can reach the server inspect its pages
      --cert <file>        TLS certificate: serve over HTTPS, for HTTPS pages
      --key <file>         TLS private key
      --public-url <url>   The server's URL as pages reach it (default: this machine's LAN address)
      --devtools-frontend-path <file>  entry page of a DevTools frontend build to serve
                                       (anywhere_app.html); its directory is served
      --devtools-frontend-url <url>    anywhere_app.html hosted elsewhere (a CDN), to open instead
      --id-in-query        Pages and DevTools connect to the base path itself, the target in the
                           query, for hosts that route WebSocket upgrades by exact path`);
  process.exit(0);
}
if (!!values.cert !== !!values.key) {
  console.error('--cert and --key go together.');
  process.exit(1);
}

const options: RemoteServerOptions = {};
if (values.port !== undefined) options.port = Number(values.port);
if (values.host !== undefined) options.host = values.host;
if (values['base-path'] !== undefined) options.basePath = values['base-path'];
if (values['no-token']) options.token = false;
else if (values.token !== undefined) options.token = values.token;
if (values.cert && values.key) options.https = { cert: readFileSync(values.cert), key: readFileSync(values.key) };
if (values['public-url'] !== undefined) options.publicUrl = values['public-url'];
if (values['devtools-frontend-path'] !== undefined) options.devtoolsFrontendPath = values['devtools-frontend-path'];
if (values['devtools-frontend-url'] !== undefined) options.devtoolsFrontendUrl = values['devtools-frontend-url'];
if (values['id-in-query']) options.idInQuery = true;

const remote = await startRemoteServer(options);
console.log(`Inspect pages at ${remote.url}`);
console.log(`Connect a page with this as the first script in its <head>:`);
console.log(`  ${remote.scriptTag}`);
if (remote.token === false) console.log('No token: anyone who can reach this server can inspect its pages.');
