// The browser's own functions that the agent calls on the page's objects, and the window's (timers, frames,
// observers, listeners): taken by the probe before the page's code runs, and used by the agent in place of
// whatever the page has put over them since (core/natives.ts). A page that wraps `getAttribute` or
// `requestAnimationFrame` would otherwise see the agent's calls, and the values they carry. Zero dependencies:
// the probe is built from this file.
import type { TopNatives } from './types';

/** A function of the page's interfaces, called with the object as `this`. */
export type Native = (...args: unknown[]) => unknown;

/** What of a property is taken: a method (`value`), or an accessor's getter (`get`) or setter (`set`). */
export type Part = 'value' | 'get' | 'set';

/**
 * What the agent calls on the page's objects, as `part:name`, on the interfaces `INTERFACES` matches. The CSSOM's
 * are the CSS domain's and the emulation's (domains/css/sheets/watch/cssom-watch.ts, domains/emulation/rewrite.ts);
 * the attributes are those of the elements the emulation rewrites and the DOM and CSS domains edit; the queries and
 * the adopted sheets are the ones the emulation reads (domains/emulation/rewrite.ts, core/nodes/adopted.ts).
 */
export const NATIVE_KEYS: readonly string[] = [
  'value:insertRule',
  'value:deleteRule',
  'value:replaceSync',
  'get:cssRules',
  'get:styleSheets',
  'get:media',
  'get:styleSheet',
  'get:ownerNode',
  'get:style',
  'get:cssText',
  'set:cssText',
  'get:selectorText',
  'set:selectorText',
  'set:keyText',
  'get:mediaText',
  'set:mediaText',
  'get:length',
  'value:item',
  'value:getPropertyValue',
  'value:getPropertyPriority',
  'value:getAttribute',
  'value:setAttribute',
  'value:removeAttribute',
  'value:setAttributeNS',
  'value:hasAttribute',
  'get:attributes',
  'value:matches',
  'value:querySelector',
  'value:querySelectorAll',
  'get:adoptedStyleSheets',
  'set:adoptedStyleSheets',
];

/**
 * The interfaces whose functions of `NATIVE_KEYS` are taken. A style sheet's `media` and `ownerNode` are the
 * StyleSheet interface's, which CSSStyleSheet inherits, so StyleSheet is among them; an element's `style` is its
 * HTMLElement, SVGElement or MathMLElement interface's.
 */
const INTERFACES = /^(CSS\w*|StyleSheet|(HTML|SVG|MathML)?Element|MediaList|Document|DocumentFragment|ShadowRoot)$/;

/** The functions taken: by the top window's prototype, and by interface name (for the objects of other realms). */
export interface NativeTable {
  byProto: Map<object, Map<string, Native>>;
  byName: Map<string, Map<string, Native>>;
}

/**
 * The functions of `NATIVE_KEYS` on the top window's interface prototypes. A prototype with none of them is not
 * in the table. Web IDL checks the interface, not the realm: an object of an iframe takes the top window's
 * functions of its interface too (by name, `Symbol.toStringTag`).
 */
export function captureNatives(): NativeTable {
  const byProto = new Map<object, Map<string, Native>>();
  const byName = new Map<string, Map<string, Native>>();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!INTERFACES.test(name)) continue;
    const proto: unknown = (Reflect.get(globalThis, name) as { prototype?: unknown } | undefined)?.prototype;
    if (typeof proto !== 'object' || proto === null) continue;
    const found = new Map<string, Native>();
    for (const key of NATIVE_KEYS) {
      const [part, prop] = key.split(':') as [Part, string];
      const fn: unknown = Object.getOwnPropertyDescriptor(proto, prop)?.[part];
      if (typeof fn === 'function') found.set(key, fn as Native);
    }
    if (!found.size) continue;
    byProto.set(proto, found);
    byName.set(name, found);
  }
  return { byProto, byName };
}

/**
 * The window's functions the probe and the agent use: the popover, listener and observer functions of the top
 * window, the timers, the frames and the clock. Called where the browser's functions are still the browser's.
 */
export function captureTop(): TopNatives {
  return {
    show: HTMLElement.prototype.showPopover,
    hide: HTMLElement.prototype.hidePopover,
    listen: EventTarget.prototype.addEventListener,
    unlisten: EventTarget.prototype.removeEventListener,
    MO: MutationObserver,
    observe: MutationObserver.prototype.observe,
    disconnect: MutationObserver.prototype.disconnect,
    takeRecords: MutationObserver.prototype.takeRecords,
    attach: Element.prototype.attachShadow,
    setAttr: Element.prototype.setAttribute,
    matches: Element.prototype.matches,
    raf: requestAnimationFrame,
    timeout: setTimeout,
    microtask: queueMicrotask,
    computed: getComputedStyle,
    // Bound now, as the browser's performance: a page may replace `window.performance`, not the function taken.
    now: performance.now.bind(performance),
  };
}
