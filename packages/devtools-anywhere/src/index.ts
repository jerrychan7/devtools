/**
 * Real Chrome DevTools inside any web page, with early capture: the `<devtools-anywhere>`
 * element, and the attributes of the probe script (`probe.iife.js`) that captures a page's
 * output from its first script on.
 *
 * @packageDocumentation
 */

export { DevtoolsAnywhereElement, defineDevtoolsAnywhere } from './element';
export type { ProbeScriptAttributes } from './probe-script';
export { type RemoteFrontendHash } from './embedder';
export type { CdpSession, Handler } from './cdp-agent';
