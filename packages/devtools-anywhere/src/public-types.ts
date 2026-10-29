// The types of what the page sees of devtools-anywhere: the element, its events, the toggler
// attribute and the element's parts. Types only: the element itself comes from
// devtools-anywhere.iife.js, which the probe loads.

/**
 * The events of `<devtools-anywhere>`, besides those of any element: `devtools-toggle-request`,
 * fired on an element the page placed itself when a toggler naming it is clicked.
 *
 * @public
 */
export interface DevtoolsAnywhereElementEventMap extends HTMLElementEventMap {
  /** A toggler naming this element, which the page placed itself, was clicked. */
  'devtools-toggle-request': Event;
}

/**
 * `<devtools-anywhere>` as the page sees it: an element whose only attribute is the optional
 * `devtools-frontend-url` (without it, the probe's). The probe's element is opened and closed by
 * the user and the togglers; an element the page places itself is a box in its flow with DevTools
 * loaded, and only hears of its togglers through `devtools-toggle-request`. The element is
 * registered by devtools-anywhere.iife.js, which the probe loads after the page has loaded.
 *
 * @public
 */
export interface DevtoolsAnywhereElement extends HTMLElement {
  /** Listens to an event of {@link DevtoolsAnywhereElementEventMap}, typed. */
  addEventListener<K extends keyof DevtoolsAnywhereElementEventMap>(
    type: K,
    listener: (this: DevtoolsAnywhereElement, event: DevtoolsAnywhereElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void;
  /** Listens to any other event. */
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void;
  /** Stops listening to an event of {@link DevtoolsAnywhereElementEventMap}. */
  removeEventListener<K extends keyof DevtoolsAnywhereElementEventMap>(
    type: K,
    listener: (this: DevtoolsAnywhereElement, event: DevtoolsAnywhereElementEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions
  ): void;
  /** Stops listening to any other event. */
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void;
}

/**
 * The attributes of `<devtools-anywhere>`. Others are ignored.
 *
 * @public
 */
export type DevtoolsAnywhereAttributes = {
  /** The URL of the DevTools frontend's entry page; without it, the probe's `data-devtools-frontend-url`. */
  'devtools-frontend-url'?: string;
};

/**
 * The attribute that makes any element a toggler: clicked, it opens and closes the probe's
 * `<devtools-anywhere>` (empty), or asks an element the page placed (its id) with
 * `devtools-toggle-request`. Its `aria-expanded` follows whether DevTools is open.
 *
 * @public
 */
export type TogglerAttributes = {
  'data-devtools-anywhere-toggle'?: string;
};

/**
 * The parts of `<devtools-anywhere>` the page can style with `::part()`: `toggler`, the F12
 * button (`devtools-anywhere::part(toggler)`), and `iframe`, DevTools' iframe in an element the
 * page placed itself (`devtools-anywhere::part(iframe)`); the probe's element has no `iframe` part.
 *
 * @public
 */
export type DevtoolsAnywherePart = 'toggler' | 'iframe';

/**
 * The element's tag, typed: what `HTMLElementTagNameMap` gets from this package, so that
 * `document.querySelector('devtools-anywhere')` is a {@link DevtoolsAnywhereElement}.
 *
 * @public
 */
export interface DevtoolsAnywhereTagNameMap {
  /** The element, registered by devtools-anywhere.iife.js. */
  'devtools-anywhere': DevtoolsAnywhereElement;
}

declare global {
  interface HTMLElementTagNameMap extends DevtoolsAnywhereTagNameMap {}
}
