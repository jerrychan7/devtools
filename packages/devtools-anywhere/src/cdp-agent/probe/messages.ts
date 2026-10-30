// Messages the probe gets from shell mode's Service Worker (service-worker.ts). No DOM types: the worker is
// type-checked with the WebWorker library.
/** Type of the message shell mode's Service Worker posts the page with what it saw of a request. */
export const RESPONSE_DETAILS = 'devtools-anywhere:response';
/** That message: the headers and status the page's fetch/XHR hooks cannot read themselves. */
export interface ResponseDetails {
  type: typeof RESPONSE_DETAILS;
  url: string;
  requestHeaders: Record<string, string>;
  status: number;
  statusText: string;
  responseHeaders: Record<string, string>;
}
