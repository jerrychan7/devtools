// Which `<devtools-anywhere>` is which: the probe's (global), the shell's, its F12 button in the
// shell's page, or one placed by the page; and the events between them and their togglers.
import { isShellDocument } from '../cdp-agent';
import type { GlobalElementConfig } from '../api';

/** Every element of this window's class, whatever tag it is registered under. */
export const ownElements = new WeakSet<Element>();
/**
 * The global elements, created for the probe (createGlobalElement), whether one has connected, and
 * those connected after it, which do nothing.
 */
export const globalElements = new WeakSet<Element>();
export const inactiveGlobals = new WeakSet<Element>();
/** The connected elements placed by the page, each with what loads its frontend. */
export const customElementsLoading = new Map<Element, () => void>();
/** The probe's options for each global element, taken when it first connects. */
export const globalConfigs = new WeakMap<Element, GlobalElementConfig>();

/**
 * Whether a global element has connected; and the probe's frontend URL, for the elements placed by
 * the page without one.
 */
export const globals = { taken: false, probeFrontend: '' };

/** The F12 buttons of the shell's element, in the shell's page (mountShellToggler). */
export const shellTogglers = new WeakSet<Element>();

/** Whether `el` is an element placed by the page (of this window). */
export const isCustom = (el: Element) =>
  ownElements.has(el) && !globalElements.has(el) && !shellTogglers.has(el) && !isShellElement(el);
/**
 * Whether `el` is the shell's element: one in the shell document the probe wrote (not created
 * for the probe), maybe of another window. Its document is marked as the shell's when the probe writes the
 * shell; a `shell` attribute no longer makes an element the shell's.
 */
export const isShellElement = (el: Element) => !globalElements.has(el) && isShellDocument(el.ownerDocument);

/**
 * Fired on the global element when it opens or closes, for the togglers of the shell's page: an
 * internal convention, not part of the API, which has only their aria-expanded. A page of the
 * same origin can fire it too: it is not meant to be trusted.
 */
export const STATE_EVENT = 'devtools-anywhere-state';

/**
 * The event a toggler controls its element with (see controlElement): an internal convention, not
 * part of the API. A page of the same origin can fire it too: it is not meant to be trusted.
 */
export const CONTROL_EVENT = 'devtools-anywhere-control';
