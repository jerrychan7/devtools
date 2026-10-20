// devtools-anywhere-remote: starts a remote debugging server and prints how to use it.
//
//   devtools-anywhere-remote [--port 8080] [--host 0.0.0.0] [--base-path /] [--token <t> | --no-token]
//                            [--cert cert.pem --key key.pem] [--frontend-dir <dir>]
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
    'frontend-dir': { type: 'string' },
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
      --frontend-dir <dir> DevTools frontend build to serve`);
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
if (values['frontend-dir'] !== undefined) options.frontendDir = values['frontend-dir'];

const remote = await startRemoteServer(options);
console.log(`Inspect pages at ${remote.url}`);
console.log(`Connect a page with this as the first script in its <head> (use this machine's address):`);
console.log(`  ${remote.scriptTag}`);
if (remote.token === false) console.log('No token: anyone who can reach this server can inspect its pages.');
