// Messages of shell mode between the page and its Service Worker (devtools-anywhere-service-worker.js), which
// service-worker.ts, element/index.ts and probe.ts all use. Constants only: service-worker.ts is built for a worker.

/** Posted by the shell to the worker: the client it comes from is a shell. */
export const SHELL_HANDSHAKE = 'devtools-anywhere:shell-handshake';
/** Asks the worker whether a shell (maybe in another tab) still uses it; answered on the transferred port. */
export const SHELL_QUERY = 'devtools-anywhere:shell-open';
/**
 * Posted by a page in the shell's page iframe to the shell (its parent window), and posted back by
 * the shell with the remote debugging server its probe names (`remote`, null for none) and
 * `idInQuery`: the shell's probe decides whether pages in the shell connect, and where.
 */
export const SHELL_REMOTE = 'devtools-anywhere:remote';
