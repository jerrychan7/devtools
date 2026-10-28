// Messages of shell mode between the page and its Service Worker (devtools-anywhere-sw.js), which
// sw.ts, element.ts and probe.ts all use. Constants only: sw.ts is built for a worker.

/** Posted by the shell to the worker: the client it comes from is a shell. */
export const SHELL_HANDSHAKE = 'devtools-anywhere:shell-handshake';
/** Asks the worker whether a shell (maybe in another tab) still uses it; answered on the transferred port. */
export const SHELL_QUERY = 'devtools-anywhere:shell-open';
