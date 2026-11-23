import { computedStyle, nativeCall } from '../../../core/natives';
import { FORCED_COLORS_ATTRIBUTE, OWN_ATTRIBUTE } from '../../../core/nodes/nodes';
import { quietMutations } from '../../../core/nodes/own-mutations';
import { isShadowRoot } from '../../../core/realm';
import { splitMediaQueries } from '../rewrite/css-tokens';
import { injectOwnStyle, scanElements, type Visit } from '../inject/inject';
import { pageTrees } from '../inject/trees';

/*
 * Forced colors (Emulation.setEmulatedMedia with forced-colors: active). Chrome paints the page with a
 * fixed system palette: every element that does not keep its colors (forced-color-adjust: none, which
 * children inherit) takes the palette; an author background becomes the canvas, a translucent one keeps
 * its opacity; and a background made of generated images (gradients) loses them unless one of its layers
 * is a url() image. Here the palette is own `!important` rules in every tree of the page (inject.ts), and
 * the elements are marked with an attribute the rules read. The marks are written when an element is
 * scanned, and taken away with the emulation. Chrome's form controls are repainted by their theme, which
 * we do not do: they are only recoloured. The page's values are read, and the marks written, through the
 * browser's own functions (core/natives.ts), which a page's wrappers of them do not see. The walk up the tree
 * (parentOf) is not: it reads the page's `assignedSlot`, `parentElement`, `parentNode` and `host` as they are.
 */

/** The name of the style sheet and of the scan, in inject.ts. */
const NAME = 'forced-colors';

/*
 * The tokens of FORCED_COLORS_ATTRIBUTE. `kept` is alone: the element keeps its colors. The others may be
 * together: `canvas` (its background is the canvas, opaque), `canvas-<percent>` (the same, translucent,
 * with that opacity in steps of 5%), and `no-image` (its generated background images are taken away).
 */
const KEPT = 'kept';
const CANVAS_TOKEN = 'canvas';
const NO_IMAGE = 'no-image';
/** The steps of opacity between transparent and opaque. */
const STEPS = 20;

/** A color scheme, which Chrome chooses the palette by. */
type Scheme = 'light' | 'dark';

/**
 * Chrome's system colours under forced colors, the values the palette paints with. Chrome takes the dark or
 * the light palette from the page's `prefers-color-scheme`: the emulated one, else the browser's. The page's
 * own `color-scheme` does not choose it. `canvas` is the canvas as r, g, b, for its translucent steps.
 */
const PALETTES = {
  dark: {
    canvas: '0, 0, 0',
    text: '#fff',
    link: '#ff0',
    highlight: 'rgba(0, 230, 255, 0.8)',
    highlightText: '#000',
    gray: 'rgb(63, 242, 63)',
  },
  light: {
    canvas: '255, 255, 255',
    text: '#000',
    link: 'rgb(0, 0, 159)',
    highlight: 'rgba(5, 0, 73, 0.8)',
    highlightText: '#fff',
    gray: 'rgb(96, 0, 0)',
  },
};
/** Marks are yellow under both palettes. */
const MARK = '#ff0';
const MARK_TEXT = '#000';

/**
 * The selector part that leaves out the elements keeping their colors, and devtools-anywhere's own
 * elements and what is inside them (its overlays, its host, which the page's own colours would reach).
 */
const ADJUSTED = `:not([${FORCED_COLORS_ATTRIBUTE}~="${KEPT}"]):not([${OWN_ATTRIBUTE}]):not([${OWN_ATTRIBUTE}] *)`;

/** Buttons, and the input types that are drawn as buttons. */
const BUTTONS = 'button, input:is([type=button i], [type=submit i], [type=reset i], [type=image i])';
/** Text fields, lists and the other inputs that take text or a choice of values. */
const FIELDS =
  'textarea, select, input:not([type=button i], [type=submit i], [type=reset i], [type=image i], [type=checkbox i], [type=radio i], [type=range i], [type=color i], [type=file i], [type=hidden i])';

/**
 * A rule for `selector`: the colour of its text, its borders and outlines, and its background (when
 * given), with the caret and the text decoration in the colour of the text. All `!important`.
 */
function paint(selector: string, text: string, border: string, background?: string): string {
  const bg = background === undefined ? '' : ` background-color: ${background} !important;`;
  // `:is()` keeps the exclusion on every selector of a list, not only the last one.
  return (
    `:is(${selector})${ADJUSTED} {${bg} color: ${text} !important; border-color: ${border} !important;` +
    ` outline-color: ${border} !important; caret-color: ${text} !important;` +
    ` text-decoration-color: ${text} !important; }`
  );
}

/**
 * The style sheet of forced colors for `scheme`, the same in every tree of the page. Buttons and fields take the
 * canvas and its text: ButtonFace, Field and the canvas are one colour in Chrome's palettes, and so are their
 * texts and ButtonBorder.
 */
function palette(scheme: Scheme): string {
  const { canvas: rgb, text, link, highlight, highlightText, gray } = PALETTES[scheme];
  const canvas = `rgb(${rgb})`;
  return [
    `:root${ADJUSTED}, body${ADJUSTED} { background-color: ${canvas} !important; }`,
    // The backgrounds are not reset here: an element's own background shows until its mark makes it the
    // canvas, so a background that covers something hides it, as in Chrome, and a transparent one stays
    // transparent. Buttons, fields and marks get the backgrounds the palette gives them, as they do in Chrome.
    `*${ADJUSTED} { color: ${text} !important;` +
      ` border-color: ${text} !important; outline-color: ${text} !important;` +
      ` caret-color: ${text} !important; text-decoration-color: ${text} !important;` +
      ` column-rule-color: ${text} !important; box-shadow: none !important; text-shadow: none !important;` +
      ` accent-color: auto !important; scrollbar-color: auto !important; }`,
    // A pseudo-element has no mark: its background is transparent, so what it covers shows through it.
    `*${ADJUSTED}::before, *${ADJUSTED}::after { background-color: transparent !important;` +
      ` color: ${text} !important; border-color: ${text} !important;` +
      ` outline-color: ${text} !important; caret-color: ${text} !important;` +
      ` text-decoration-color: ${text} !important; column-rule-color: ${text} !important;` +
      ` box-shadow: none !important; text-shadow: none !important; }`,
    `[${FORCED_COLORS_ATTRIBUTE}~="${CANVAS_TOKEN}"] { background-color: ${canvas} !important; }`,
    // Each translucent step: the canvas at its opacity (`canvas-5` … `canvas-95`).
    ...Array.from(
      { length: STEPS - 1 },
      (_, i) =>
        `[${FORCED_COLORS_ATTRIBUTE}~="${CANVAS_TOKEN}-${(i + 1) * (100 / STEPS)}"] { background-color: rgba(${rgb}, ${(i + 1) / STEPS}) !important; }`
    ),
    paint('a:link', link, link),
    paint('a:visited', link, link),
    paint('a:active', link, link),
    paint(BUTTONS, text, text, canvas),
    // Only the disabled buttons are grey: a disabled field keeps the field's colours, as in Chrome.
    paint(`:is(${BUTTONS}):disabled`, gray, gray),
    paint(FIELDS, text, text, canvas),
    paint('mark', MARK_TEXT, MARK_TEXT, MARK),
    `*${ADJUSTED}::selection { color: ${highlightText} !important; background-color: ${highlight} !important; }`,
    `[${FORCED_COLORS_ATTRIBUTE}~="${NO_IMAGE}"] { background-image: none !important; }`,
  ].join('\n');
}

/**
 * The style sheet for the scheme emulated, or, with none, both palettes under the browser's own
 * `prefers-color-scheme`, so that the browser follows a change of its scheme. The agent's own sheets are not
 * rewritten by the media emulation.
 */
const sheetFor = (scheme: Scheme | undefined): string =>
  scheme
    ? palette(scheme)
    : `@media not (prefers-color-scheme: dark) {\n${palette('light')}\n}\n@media (prefers-color-scheme: dark) {\n${palette('dark')}\n}`;

/**
 * The element above `el` in the flat tree, which is the one styles are inherited along: the slot it is assigned
 * to, else its parent, or the host of its shadow root. A slot of a closed shadow root is not exposed to the page
 * (`assignedSlot` is null), so an element in one is taken as its parent's child. The tree is read through the
 * accessors the page has, as the rest of the agent reads it: a wrapper the page puts over them sees these reads.
 */
const parentOf = (el: Element): Element | null =>
  el.assignedSlot ?? el.parentElement ?? (isShadowRoot(el.parentNode) ? el.parentNode.host : null);

/** Whether each element looked at in the current emulation keeps its colors, so a child reads its parent's answer. */
let keeps = new WeakMap<Element, boolean>();

/**
 * Whether `el` keeps its colors: its forced-color-adjust is none, or preserve-parent-color where its parent
 * keeps them. Computed none is inherited, so a child of an element that keeps its colors computes none too.
 */
function keepsColors(el: Element): boolean {
  const known = keeps.get(el);
  if (known !== undefined) return known;
  const value = nativeCall<string>(computedStyle(el), 'getPropertyValue', 'forced-color-adjust');
  let kept = value === 'none';
  if (value === 'preserve-parent-color') {
    const parent = parentOf(el);
    kept = !!parent && keepsColors(parent);
  }
  keeps.set(el, kept);
  return kept;
}

/** The opacity of a computed colour: 1 unless it is rgba() or a colour function with a slash before its alpha. */
function alphaOf(color: string): number {
  if (color.startsWith('rgb(')) return 1;
  const alpha = /[,/]\s*([\d.]+(?:e[+-]?\d+)?%?)\s*\)$/i.exec(color)?.[1];
  if (alpha === undefined) return 1;
  return alpha.endsWith('%') ? parseFloat(alpha) / 100 : parseFloat(alpha);
}

/**
 * Whether a computed background-image loses its generated images. Chrome takes them away only where the
 * background has no url() layer: with one, every layer stays.
 */
function losesImages(image: string): boolean {
  if (image === 'none') return false;
  const layers = splitMediaQueries(image).map(layer => layer.trim());
  return !layers.some(layer => layer.startsWith('url(')) && layers.some(layer => layer !== 'none');
}

/** The elements marked, held weakly: one the page took out keeps its mark until it is put back, so it is taken away too. */
let marked = new Set<WeakRef<Element>>();
let refs = new WeakMap<Element, WeakRef<Element>>();
let sweepAt = 1024;

/** Keeps `el` in `marked`, once; the dead references in it are swept as it grows. */
function track(el: Element): void {
  if (refs.has(el)) return;
  if (marked.size >= sweepAt) {
    for (const ref of marked) if (!ref.deref()) marked.delete(ref);
    sweepAt = Math.max(1024, marked.size * 2);
  }
  const ref = new WeakRef(el);
  refs.set(el, ref);
  marked.add(ref);
}

/**
 * Sets the mark of `el` to `value` (tokens separated by spaces), or takes it away with null. The write is
 * the agent's: no DOM event of the client reports it. Returns whether it wrote: the page's own observers see
 * a write.
 */
function mark(el: Element, value: string | null): boolean {
  const before = nativeCall<string | null>(el, 'getAttribute', FORCED_COLORS_ATTRIBUTE);
  if (value !== null) track(el);
  if (before === value) return false;
  quietMutations(
    () => {
      if (value === null) nativeCall(el, 'removeAttribute', FORCED_COLORS_ATTRIBUTE);
      else nativeCall(el, 'setAttribute', FORCED_COLORS_ATTRIBUTE, value);
    },
    { target: el, name: FORCED_COLORS_ATTRIBUTE, before }
  );
  return true;
}

/**
 * Marks `el` with what forced colors does to it. Marks it already has are taken away first: a clone of a
 * marked element carries them, and the palette's rules for them would change what is read (a gradient the
 * `no-image` mark hides reads as none). The page's values are read after that. Returns whether a mark was
 * written or taken away, which the scan paces its next visits by (inject.ts).
 */
const visit: Visit = el => {
  const cleared = mark(el, null);
  if (keepsColors(el)) return mark(el, KEPT) || cleared;
  const style = computedStyle(el);
  const tokens: string[] = [];
  const steps = Math.round(alphaOf(nativeCall<string>(style, 'getPropertyValue', 'background-color')) * STEPS);
  if (steps === STEPS) tokens.push(CANVAS_TOKEN);
  else if (steps > 0) tokens.push(`${CANVAS_TOKEN}-${steps * (100 / STEPS)}`);
  if (losesImages(nativeCall<string>(style, 'getPropertyValue', 'background-image'))) tokens.push(NO_IMAGE);
  return mark(el, tokens.length ? tokens.join(' ') : null) || cleared;
};

/** Takes the marks off every element marked: those in the page, and those the page took out and kept. */
function unmarkAll(): void {
  for (const ref of marked) {
    const el = ref.deref();
    if (el) mark(el, null);
  }
  marked = new Set();
  refs = new WeakMap();
  sweepAt = 1024;
  for (const tree of pageTrees())
    for (const el of nativeCall<NodeListOf<Element>>(tree, 'querySelectorAll', `[${FORCED_COLORS_ATTRIBUTE}]`))
      mark(el, null);
}

let active = false;
/** The sheet injected while active, so that a change of the emulated scheme replaces it. */
let sheet = '';

/**
 * Turns forced colors on or off for the whole page: the palette in every tree, the scan of new elements
 * and the marks. `scheme` is the emulated `prefers-color-scheme`, undefined for the browser's own: a change of
 * it while active replaces the palette and keeps the marks. Turning them off takes all of it back. Setting the
 * state it already has changes nothing.
 */
export function setForcedColors(on: boolean, scheme?: Scheme): void {
  if (on && active) {
    const css = sheetFor(scheme);
    if (css !== sheet) injectOwnStyle(NAME, (sheet = css));
    return;
  }
  if (on === active) return;
  active = on;
  if (on) {
    keeps = new WeakMap();
    injectOwnStyle(NAME, (sheet = sheetFor(scheme)));
    scanElements(NAME, visit);
    return;
  }
  sheet = '';
  scanElements(NAME, null);
  injectOwnStyle(NAME, null);
  unmarkAll();
}
