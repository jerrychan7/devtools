// Elements with `data-devtools-anywhere-toggle` open and close a `<devtools-anywhere>` when clicked.
import { isShellPage } from '../cdp-agent';
import type { TogglerAttributes } from '../public-types';
import {
  CONTROL_EVENT,
  customElementsLoading,
  globalElements,
  inactiveGlobals,
  isCustom,
  isShellElement,
  ownElements,
  STATE_EVENT,
} from './registry';

/** What a toggler fires on an element placed by the page, which has no open state. */
const TOGGLE_REQUEST_EVENT = 'devtools-toggle-request';

/** Elements with this attribute open and close DevTools when clicked (see togglerTarget). */
const TOGGLE_ATTRIBUTE: keyof TogglerAttributes = 'data-devtools-anywhere-toggle';
/** The tag the togglers look for, once they are installed. */
let togglerTag = '';
/** Toggler values already warned about. */
const warned = new Set<string>();

/**
 * The element a toggler controls: the element whose id is the attribute's value, or without one
 * the first global element, or in the shell's page iframe the shell's element.
 */
export function togglerTarget(toggler: Element, warn: boolean): Element | null {
  const id = toggler.getAttribute(TOGGLE_ATTRIBUTE) ?? '';
  const doc = toggler.ownerDocument;
  let target: Element | null | undefined = null;
  if (isShellPage()) {
    // An element the page placed in the shell's page: the toggler names it. Without a value, the
    // shell's element, of the shell window's class: it is toggled through an event.
    const named = id ? doc.getElementById(id) : null;
    if (named && customElementsLoading.has(named)) return named;
    if (!id) return shellElement();
  } else {
    // Without a value, the global element (or the shell's); global elements after the first do
    // nothing: they are not targets.
    target = id
      ? doc.getElementById(id)
      : [...doc.querySelectorAll(togglerTag)].find(
          el => (globalElements.has(el) || isShellElement(el)) && !inactiveGlobals.has(el)
        );
  }
  if (target && ownElements.has(target) && !inactiveGlobals.has(target)) return target;
  if (warn && !warned.has(id)) {
    warned.add(id);
    console.warn(`devtools-anywhere: no <${togglerTag}>${id ? ` with id "${id}"` : ''} for ${TOGGLE_ATTRIBUTE}`);
  }
  return null;
}

/** In the shell's page iframe: the shell's element, of the shell window's class. */
export function shellElement(): Element | null {
  const shellDocument = window.frameElement?.ownerDocument;
  return (shellDocument && [...shellDocument.querySelectorAll(togglerTag)].find(isShellElement)) ?? null;
}

/**
 * Asks a toggler's element, maybe of another window, whether it is open, toggling it first when
 * `toggle`. Undefined when it does not answer.
 */
export function controlElement(target: Element, toggle: boolean): boolean | undefined {
  const detail: { toggle: boolean; open?: boolean } = { toggle };
  target.dispatchEvent(new CustomEvent(CONTROL_EVENT, { detail }));
  return detail.open;
}

/** Sets aria-expanded on a toggler from the state of its element. */
function refreshToggler(toggler: Element, warn = false) {
  const target = togglerTarget(toggler, warn);
  // An element placed by the page has no open state.
  if (target && isCustom(target)) return target;
  const open = target && controlElement(target, false);
  if (open !== undefined && open !== null) toggler.setAttribute('aria-expanded', String(open));
  return target;
}

export function refreshTogglers(doc: Document) {
  if (!togglerTag) return;
  for (const toggler of doc.querySelectorAll(`[${TOGGLE_ATTRIBUTE}]`)) refreshToggler(toggler);
}

/** Makes any element with TOGGLE_ATTRIBUTE, including those added later, a toggler. */
export function installTogglers(tag: string) {
  if (togglerTag) return;
  togglerTag = tag;
  document.addEventListener(
    'click',
    event => {
      const clicked = event.target instanceof Element ? event.target : null;
      const toggler = clicked?.closest(`[${TOGGLE_ATTRIBUTE}]`);
      // A label's click is followed by one on its control: that one toggles, once.
      const control = clicked?.closest('label')?.control;
      if (!toggler || (control && control !== clicked && toggler.contains(control))) return;
      const target = toggler && refreshToggler(toggler, true);
      if (!target) return;
      // An element placed by the page only tells its listeners, which decide.
      if (isCustom(target)) target.dispatchEvent(new Event(TOGGLE_REQUEST_EVENT));
      else controlElement(target, true);
      refreshToggler(toggler);
    },
    true
  );
  const refresh = () => refreshTogglers(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
  // In the shell's page iframe, the togglers follow the shell's element while this page is shown.
  if (!isShellPage()) return;
  const shellDocument = window.frameElement?.ownerDocument;
  let shell: Element | null = null;
  const listen = () => {
    shell = togglerTarget(document.documentElement, false);
    shell?.addEventListener(STATE_EVENT, refresh);
    refresh();
  };
  // The shell parses its element after its bundle, which may load after this page has run.
  if (shellDocument?.readyState === 'loading') shellDocument.addEventListener('DOMContentLoaded', listen);
  else listen();
  window.addEventListener('pagehide', () => {
    shellDocument?.removeEventListener('DOMContentLoaded', listen);
    shell?.removeEventListener(STATE_EVENT, refresh);
  });
  window.addEventListener('pageshow', event => event.persisted && listen());
}
