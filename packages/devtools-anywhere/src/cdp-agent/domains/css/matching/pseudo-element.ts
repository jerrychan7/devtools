import { documentOf, styleOf } from '../../../core/realm';
import { atName } from '../sheets/text/loose';

/**
 * Matching of the pseudo-elements our DOM has no node for (::backdrop, ::scroll-button(),
 * ::view-transition-group(), …), for an animation's cssId: their argument, and the pseudo-classes
 * after them (`::scroll-button(*):disabled`).
 */

/**
 * Whether a selector's pseudo-element (as split by `splitPseudoElement`) matches the pseudo-element
 * `actual` of `el` (normalized the same way, as an effect names it). The argument of
 * `::view-transition-*()` matches by name, `*` matching any, and by the classes after it (`*.a`,
 * `.a`, `n.a.b`), the view transition's (`classes`); `::scroll-button(*)` matches any button, a
 * physical direction (`up`) the logical one it is for the element, as an effect names its button
 * logically (`block-start`). `::column::scroll-marker` matches `::scroll-marker`: an effect names a
 * column's marker as one of the scroller (and Chrome hashes its rules), so the two cannot be told
 * apart. Other arguments match when equal.
 */
export function pseudoMatches(selector: string, actual: string, el: Element, classes: ViewTransitionClasses): boolean {
  if (selector === actual) return true;
  if (selector === `column::${actual}` && actual === 'scroll-marker') return true;
  const sel = /^([\w-]+)\((.*)\)$/.exec(selector);
  const act = /^([\w-]+)\((.*)\)$/.exec(actual);
  if (!sel || !act || sel[1] !== act[1]) return false;
  const [, name, arg = ''] = sel;
  const target = act[2] ?? '';
  if (name?.startsWith('view-transition-')) {
    // Spaces between the name and its classes make the selector invalid; an escape may end in one.
    const m = new RegExp(`^(\\*|${IDENT})?((?:\\.${IDENT})*)$`).exec(arg.trim());
    if (!m) return false;
    const vtName = atName(target);
    if (m[1] && m[1] !== '*' && atName(m[1]) !== vtName) return false;
    // A class alone (`.a`) is the shorthand of `*.a`; nothing at all matches nothing.
    if (!m[1] && !m[2]) return false;
    const wanted = Array.from((m[2] ?? '').matchAll(new RegExp(`\\.(${IDENT})`, 'g')), c => atName(c[1] ?? ''));
    if (!wanted.length) return true;
    const own = classes.of(documentOf(el), vtName);
    return wanted.every(c => own.includes(c));
  }
  const wanted = arg.trim().toLowerCase();
  if (wanted === '*' || wanted === target.toLowerCase()) return true;
  if (name !== 'scroll-button') return false;
  const style = styleOf(el);
  return logicalSide(wanted, style.writingMode, style.direction) === target.toLowerCase();
}

/**
 * Whether the pseudo-classes after a pseudo-element (`:disabled:hover`) match it, as far as the
 * page can tell: `:disabled` and `:enabled` of a scroll button (whether its scroller can scroll that
 * way), `:target-current` of a scroll marker, and `:only-child` of a view transition's old or new
 * image (the other one missing) and image pair. Others, such as `::before:hover`, which Chrome runs
 * no animation for, do not match.
 */
export function pseudoClassesMatch(
  pseudoClasses: string,
  el: Element,
  pseudo: string,
  classes: ViewTransitionClasses
): boolean {
  const list = pseudoClasses.match(/:[\w-]+(?:\([^)]*\))?/g) ?? [];
  return list.every(pc => {
    const name = pc.slice(1).toLowerCase();
    const button = /^scroll-button\((.*)\)$/.exec(pseudo);
    if (button && (name === 'disabled' || name === 'enabled'))
      return canScroll(el, (button[1] ?? '').toLowerCase()) === (name === 'enabled');
    if (pseudo === 'scroll-marker' && name === 'target-current') return isTargetCurrent(el);
    if (name === 'only-child') {
      if (pseudo.startsWith('view-transition-image-pair(')) return true;
      const image = /^view-transition-(old|new)\((.*)\)$/.exec(pseudo);
      if (image) return !classes.hasImage(documentOf(el), image[1] === 'old' ? 'new' : 'old', atName(image[2] ?? ''));
    }
    return false;
  });
}

/**
 * The logical side (`block-start`, …) a physical one (`up`, `down`, `left`, `right`) is for an
 * element of `writingMode` and `direction`; other sides as they are.
 */
export function logicalSide(side: string, writingMode: string, direction: string): string {
  const order = physicalSides(writingMode, direction);
  return LOGICAL[order.indexOf(side)] ?? side;
}

const LOGICAL = ['block-start', 'inline-end', 'block-end', 'inline-start'];

/** The physical sides of block-start, inline-end, block-end and inline-start, in that order. */
function physicalSides(writingMode: string, direction: string): string[] {
  const vertical = writingMode.startsWith('vertical') || writingMode.startsWith('sideways');
  const rtl = direction === 'rtl';
  if (!vertical) return rtl ? ['up', 'left', 'down', 'right'] : ['up', 'right', 'down', 'left'];
  const blockStart = writingMode.endsWith('-lr') ? 'left' : 'right';
  const blockEnd = blockStart === 'left' ? 'right' : 'left';
  // sideways-lr runs its lines bottom to top.
  const up = writingMode === 'sideways-lr' ? !rtl : rtl;
  return [blockStart, up ? 'up' : 'down', blockEnd, up ? 'down' : 'up'];
}

/** Whether `scroller` can scroll towards its logical `side` (a scroll button is enabled). */
function canScroll(scroller: Element, side: string): boolean {
  const style = styleOf(scroller);
  const physical = physicalSides(style.writingMode, style.direction)[LOGICAL.indexOf(side)];
  const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = scroller;
  // Scrolled from the right, scrollLeft runs from minus the overflow to 0.
  const fromRight =
    style.writingMode.endsWith('-rl') ||
    (style.direction === 'rtl' && !style.writingMode.startsWith('vertical') && !style.writingMode.startsWith('sideways'));
  const width = scrollWidth - clientWidth;
  const [low, high] = fromRight ? [-width, 0] : [0, width];
  switch (physical) {
    case 'up':
      return scrollTop > 0.5;
    case 'down':
      return scrollTop < scrollHeight - clientHeight - 0.5;
    case 'left':
      return scrollLeft > low + 0.5;
    case 'right':
      return scrollLeft < high - 0.5;
    default:
      return false;
  }
}

/**
 * Whether the scroll marker of `el` is its group's current one: approximated as the last marker
 * whose element starts at or before the top of the scroller the group belongs to (else the first),
 * where Chrome follows the scroll target.
 */
function isTargetCurrent(el: Element): boolean {
  const hasGroup = (e: Element) => !['', 'none'].includes(styleOf(e).getPropertyValue('scroll-marker-group').trim());
  let scroller = el.parentElement;
  while (scroller && !hasGroup(scroller)) scroller = scroller.parentElement;
  if (!scroller) return false;
  const markers = Array.from(scroller.querySelectorAll('*')).filter(e => {
    const content = styleOf(e, '::scroll-marker').content;
    return content !== 'none' && content !== 'normal' && content !== '';
  });
  const top = scroller.getBoundingClientRect().top + 1;
  let current = markers[0];
  for (const m of markers) if (m.getBoundingClientRect().top <= top) current = m;
  return current === el;
}

/** An identifier as written, escapes (`\\31 a`) included. */
const IDENT = String.raw`(?:\\[0-9a-fA-F]{1,6}\s?|\\[^\n0-9a-fA-F]|[^.\s*\\()])+`;

type Table = Map<string, string[]>;

/**
 * The `view-transition-class` of each view transition name of a document. Like Chrome's, the table
 * is set when a transition captures its states: the old elements' classes before its callback runs,
 * the new ones' (which win for a name in both) once it has, and kept until it finishes, class
 * changes in the meantime not counting. That takes `document.startViewTransition`, hooked from the
 * first look on; for a transition started before, the current elements are read, again within a
 * task. Elements in shadow trees count for no class, as in Chrome when the class comes from a
 * shadow tree's sheet; `auto` and `match-element` names, which Chrome generates, are not found.
 */
export class ViewTransitionClasses {
  /** The table of each document's running transition. */
  private readonly captured = new WeakMap<Document, Table>();
  /** Tables read from the current elements, for the current task. */
  private readonly scanned = new WeakMap<Document, Table>();
  private readonly hooked = new WeakSet<Document>();

  /** The classes of the view transition `name` of `doc`. */
  of(doc: Document, name: string): string[] {
    this.hook(doc);
    return this.table(doc).get(name) ?? [];
  }

  /** Whether the view transition `name` of `doc` has an old (or new) image, as its animations tell. */
  hasImage(doc: Document, kind: 'old' | 'new', name: string): boolean {
    const pseudo = `::view-transition-${kind}(${name})`;
    return doc.getAnimations().some(a => {
      const effect = a.effect as KeyframeEffect | null;
      return effect?.pseudoElement === pseudo;
    });
  }

  private table(doc: Document): Table {
    const captured = this.captured.get(doc);
    if (captured) return captured;
    let scanned = this.scanned.get(doc);
    if (!scanned) {
      scanned = scan(doc);
      this.scanned.set(doc, scanned);
      (doc.defaultView ?? globalThis).setTimeout(() => this.scanned.delete(doc), 0);
    }
    return scanned;
  }

  /** Hooks `doc.startViewTransition`, on the document itself, to capture its tables. */
  hook(doc: Document): void {
    if (this.hooked.has(doc)) return;
    this.hooked.add(doc);
    type Start = (arg?: unknown) => ViewTransition;
    const start = (doc as Document & { startViewTransition?: Start }).startViewTransition;
    if (typeof start !== 'function') return;
    const hooked = (arg?: unknown): ViewTransition => {
      const old = scan(doc);
      const update = typeof arg === 'function' ? arg : (arg as { update?: unknown } | undefined)?.update;
      const capture = () => {
        const table = new Map(old);
        for (const [name, list] of scan(doc)) table.set(name, list);
        this.captured.set(doc, table);
      };
      const wrapped = async () => {
        try {
          if (typeof update === 'function') await (update as () => unknown)();
        } finally {
          capture();
        }
      };
      const options = typeof arg === 'object' && arg !== null ? { ...arg, update: wrapped } : wrapped;
      const transition = start.call(doc, options);
      transition.finished.then(
        () => this.captured.delete(doc),
        () => this.captured.delete(doc)
      );
      return transition;
    };
    Object.defineProperty(doc, 'startViewTransition', { value: hooked, configurable: true, writable: true });
  }
}

/** The view transition names of the elements of `doc` (not of its shadow trees), with their classes. */
function scan(doc: Document): Table {
  const result: Table = new Map();
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const style = styleOf(el);
    const name = atName(style.getPropertyValue('view-transition-name').trim());
    if (!name || name === 'none' || name === 'auto' || name === 'match-element' || result.has(name)) continue;
    const list = style.getPropertyValue('view-transition-class').trim();
    result.set(name, list && list !== 'none' ? list.split(/\s+/).map(atName) : []);
  }
  return result;
}
