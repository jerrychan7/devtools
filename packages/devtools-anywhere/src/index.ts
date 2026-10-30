/**
 * Real Chrome DevTools inside any web page, with early capture. The package ships two scripts,
 * `probe.iife.js` and `devtools-anywhere.iife.js`, and these types: the `<devtools-anywhere>`
 * element as the page sees it, and the attributes of the probe script that captures a page's
 * output from its first script on.
 *
 * @packageDocumentation
 */

export type {
  DevtoolsAnywhereAttributes,
  DevtoolsAnywhereElement,
  DevtoolsAnywhereElementEventMap,
  DevtoolsAnywherePart,
  DevtoolsAnywhereTagNameMap,
  TogglerAttributes,
} from './public-types';
export type { ProbeScriptAttributes } from './probe-script';
export type { RemoteFrontendHash } from './embedder';
