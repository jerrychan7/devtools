import { FORCED_COLORS_ATTRIBUTE, OWN_ATTRIBUTE } from '../../core/nodes/nodes';
import { quietMutations } from '../../core/nodes/own-mutations';
import { isShadowRoot, styleOf } from '../../core/realm';
import { splitMediaQueries } from './css-tokens';
import { injectOwnStyle, scanElements } from './inject';
import { pageTrees } from './trees';

/*
 * Forced colors (Emulation.setEmulatedMedia with forced-colors: active). Chrome paints the page with a
 * fixed system palette: every element that does not keep its colors (forced-color-adjust: none, which
 * children inherit) takes the palette; an author background becomes the canvas, a translucent one keeps
 * its opacity; and a background made of generated images (gradients) loses them unless one of its layers
 * is a url() image. Here the palette is own `!important` rules in every tree of the page (inject.ts), and
 * the elements are marked with an attribute the rules read. The marks are written when an element is
 * scanned, and taken away with the emulation. Chrome's form controls are repainted by their theme, which
 * we do not do: they are only recoloured.
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

/** Chrome's system colours under forced colors, the values the palette paints with. */
const CANVAS = '#000';
const CANVAS_TEXT = '#fff';
const LINK_TEXT = '#ff0';
const BUTTON_FACE = '#000';
const BUTTON_TEXT = '#fff';
const BUTTON_BORDER = '#fff';
const FIELD = '#000';
const FIELD_TEXT = '#fff';
const HIGHLIGHT = 'rgba(0, 230, 255, 0.8)';
const HIGHLIGHT_TEXT = '#000';
const GRAY_TEXT = 'rgb(63, 242, 63)';
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

/** The rule of each translucent step: the canvas at its opacity (`canvas-5` … `canvas-95`). */
const TRANSLUCENT = Array.from(
  { length: STEPS - 1 },
  (_, i) =>
    `[${FORCED_COLORS_ATTRIBUTE}~="${CANVAS_TOKEN}-${(i + 1) * (100 / STEPS)}"] { background-color: rgba(0, 0, 0, ${(i + 1) / STEPS}) !important; }`
);

/** The style sheet of forced colors, the same in every tree of the page. */
const PALETTE = [
  `:root${ADJUSTED}, body${ADJUSTED} { background-color: ${CANVAS} !important; }`,
  // The backgrounds are not reset here: an element's own background shows until its mark makes it the
  // canvas, so a background that covers something hides it, as in Chrome, and a transparent one stays
  // transparent. Buttons, fields and marks get the backgrounds the palette gives them, as they do in Chrome.
  `*${ADJUSTED} { color: ${CANVAS_TEXT} !important;` +
    ` border-color: ${CANVAS_TEXT} !important; outline-color: ${CANVAS_TEXT} !important;` +
    ` caret-color: ${CANVAS_TEXT} !important; text-decoration-color: ${CANVAS_TEXT} !important;` +
    ` column-rule-color: ${CANVAS_TEXT} !important; box-shadow: none !important; text-shadow: none !important;` +
    ` accent-color: auto !important; scrollbar-color: auto !important; }`,
  // A pseudo-element has no mark: its background is transparent, so what it covers shows through it.
  `*${ADJUSTED}::before, *${ADJUSTED}::after { background-color: transparent !important;` +
    ` color: ${CANVAS_TEXT} !important; border-color: ${CANVAS_TEXT} !important;` +
    ` outline-color: ${CANVAS_TEXT} !important; caret-color: ${CANVAS_TEXT} !important;` +
    ` text-decoration-color: ${CANVAS_TEXT} !important; column-rule-color: ${CANVAS_TEXT} !important;` +
    ` box-shadow: none !important; text-shadow: none !important; }`,
  `[${FORCED_COLORS_ATTRIBUTE}~="${CANVAS_TOKEN}"] { background-color: ${CANVAS} !important; }`,
  ...TRANSLUCENT,
  paint('a:link', LINK_TEXT, LINK_TEXT),
  paint('a:visited', LINK_TEXT, LINK_TEXT),
  paint('a:active', LINK_TEXT, LINK_TEXT),
  paint(BUTTONS, BUTTON_TEXT, BUTTON_BORDER, BUTTON_FACE),
  // Only the disabled buttons are grey: a disabled field keeps the field's colours, as in Chrome.
  paint(`:is(${BUTTONS}):disabled`, GRAY_TEXT, GRAY_TEXT),
  paint(FIELDS, FIELD_TEXT, BUTTON_BORDER, FIELD),
  paint('mark', MARK_TEXT, MARK_TEXT, MARK),
  `*${ADJUSTED}::selection { color: ${HIGHLIGHT_TEXT} !important; background-color: ${HIGHLIGHT} !important; }`,
  `[${FORCED_COLORS_ATTRIBUTE}~="${NO_IMAGE}"] { background-image: none !important; }`,
].join('\n');

/**
 * The element above `el` in the flat tree, which is the one styles are inherited along: the slot it is assigned
 * to, else its parent, or the host of its shadow root. A slot of a closed shadow root is not told to the page
 * (`assignedSlot` is null), so an element in one is taken as its parent's child.
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
  const value = styleOf(el).getPropertyValue('forced-color-adjust');
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
 * the agent's: no DOM event of the client reports it.
 */
function mark(el: Element, value: string | null): void {
  const before = el.getAttribute(FORCED_COLORS_ATTRIBUTE);
  if (value !== null) track(el);
  if (before === value) return;
  quietMutations(
    () => {
      if (value === null) el.removeAttribute(FORCED_COLORS_ATTRIBUTE);
      else el.setAttribute(FORCED_COLORS_ATTRIBUTE, value);
    },
    { target: el, name: FORCED_COLORS_ATTRIBUTE, before }
  );
}

/**
 * Marks `el` with what forced colors does to it. Marks it already has are taken away first: a clone of a
 * marked element carries them, and the palette's rules for them would change what is read (a gradient the
 * `no-image` mark hides reads as none). The page's values are read after that.
 */
function visit(el: Element): void {
  mark(el, null);
  if (keepsColors(el)) return mark(el, KEPT);
  const style = styleOf(el);
  const tokens: string[] = [];
  const steps = Math.round(alphaOf(style.getPropertyValue('background-color')) * STEPS);
  if (steps === STEPS) tokens.push(CANVAS_TOKEN);
  else if (steps > 0) tokens.push(`${CANVAS_TOKEN}-${steps * (100 / STEPS)}`);
  if (losesImages(style.getPropertyValue('background-image'))) tokens.push(NO_IMAGE);
  mark(el, tokens.length ? tokens.join(' ') : null);
}

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
    for (const el of Array.from(tree.querySelectorAll(`[${FORCED_COLORS_ATTRIBUTE}]`))) mark(el, null);
}

let active = false;

/**
 * Turns forced colors on or off for the whole page: the palette in every tree, the scan of new elements
 * and the marks. Turning them off takes all of it back. Setting the state it already has changes nothing.
 */
export function setForcedColors(on: boolean): void {
  if (on === active) return;
  active = on;
  if (on) {
    keeps = new WeakMap();
    injectOwnStyle(NAME, PALETTE);
    scanElements(NAME, visit);
    return;
  }
  scanElements(NAME, null);
  injectOwnStyle(NAME, null);
  unmarkAll();
}
