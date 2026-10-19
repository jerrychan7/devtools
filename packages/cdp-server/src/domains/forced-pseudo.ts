import { FORCE_ATTRIBUTE, OWN_ATTRIBUTE } from '../core/nodes';

/** Pseudo-classes CSS.forcePseudoState can force (longer names first, for the alternation). */
const FORCEABLE_CLASSES = ['hover', 'focus-within', 'focus-visible', 'focus', 'active', 'visited', 'target'];
const FORCEABLE = new RegExp(`:(${FORCEABLE_CLASSES.join('|')})(?![\\w-])`, 'g');

/**
 * Emulates CSS.forcePseudoState. Page scripts cannot put an element into :hover (or
 * :focus, …), so forced elements get a marker attribute, and every rule using a forced
 * pseudo-class gets a copy whose selector uses the marker instead.
 *
 * The copies go into a "companion" style sheet inserted right after each original sheet,
 * and after the first copied rule the companion replays all following rules of the original
 * sheet: the cascade order, which decides between rules of equal specificity, stays exactly
 * as if the pseudo-class matched. The page's own style sheets are not modified.
 */
export class ForcedPseudoClasses {
  private forced = new Map<Element, Set<string>>();
  private companions: HTMLStyleElement[] = [];

  constructor(
    private sheets: () => CSSStyleSheet[],
    private rulesOf: (sheet: CSSStyleSheet | CSSGroupingRule) => CSSRule[]
  ) {}

  /** Pseudo-classes forced on at least one element. */
  private active(): Set<string> {
    const all = new Set<string>();
    for (const classes of this.forced.values()) classes.forEach(c => all.add(c));
    return all;
  }

  /**
   * `selector` with forced pseudo-classes extended by the marker attribute: `:hover` becomes
   * `:is(:hover, [marker~="hover"])`, which matches elements really hovered or forced, so
   * negations like `:not(:hover)` stop matching forced elements, as in Chrome. The rewritten
   * selector alone decides whether a rule matches; the page's own copy of a negated rule
   * still applies, as its style sheets are not modified.
   */
  rewrite(selector: string): string {
    const active = this.active();
    if (!active.size) return selector;
    return selector.replace(FORCEABLE, (match, name: string) =>
      active.has(name) ? `:is(${match}, [${FORCE_ATTRIBUTE}~="${name}"])` : match
    );
  }

  set(el: Element, classes: string[]) {
    const known = classes.filter(c => FORCEABLE_CLASSES.includes(c));
    if (known.length) {
      this.forced.set(el, new Set(known));
      el.setAttribute(FORCE_ATTRIBUTE, known.join(' '));
    } else {
      this.forced.delete(el);
      el.removeAttribute(FORCE_ATTRIBUTE);
    }
    this.rebuild();
  }

  clear() {
    for (const el of this.forced.keys()) el.removeAttribute(FORCE_ATTRIBUTE);
    this.forced.clear();
    this.rebuild();
  }

  get isActive() {
    if (this.prune() && !this.forced.size) this.rebuild();
    return this.forced.size > 0;
  }

  /**
   * Forgets elements removed from the document, as Chrome does when a node is removed: they
   * are no longer held, and are not forced if they come back. Returns whether any was removed.
   */
  private prune(): boolean {
    let pruned = false;
    for (const el of this.forced.keys()) {
      if (el.isConnected) continue;
      this.forced.delete(el);
      el.removeAttribute(FORCE_ATTRIBUTE);
      pruned = true;
    }
    return pruned;
  }

  /** After `removed` left the tree: un-forces the elements among them, like Chrome. */
  removed(removed: Node[]) {
    if (!this.forced.size || !removed.length) return;
    let changed = false;
    for (const el of this.forced.keys()) {
      if (!removed.some(node => node.contains(el))) continue;
      this.forced.delete(el);
      el.removeAttribute(FORCE_ATTRIBUTE);
      changed = true;
    }
    if (changed) this.rebuild();
  }

  /** Recreates the companion sheets, e.g. after the page's style sheets changed. */
  rebuild() {
    this.companions.forEach(style => style.remove());
    this.companions = [];
    this.prune();
    if (!this.forced.size) return;
    for (const sheet of this.sheets()) {
      const owner = sheet.ownerNode;
      if (!(owner instanceof Element) || !owner.isConnected) continue;
      const text = this.companionText(this.rulesOf(sheet));
      if (!text) continue;
      const style = document.createElement('style');
      style.setAttribute(OWN_ATTRIBUTE, 'forced-pseudo-classes');
      style.textContent = text;
      owner.after(style);
      this.companions.push(style);
    }
  }

  private companionText(rules: CSSRule[]): string {
    let started = false;
    const walk = (list: CSSRule[]): string => {
      let out = '';
      for (const rule of list) {
        if (rule instanceof CSSStyleRule) {
          const rewritten = this.rewrite(rule.selectorText);
          if (rewritten !== rule.selectorText) {
            out += `${rewritten} { ${rule.style.cssText} }\n`;
            started = true;
          } else if (started) {
            out += rule.cssText + '\n';
          }
        } else if (rule instanceof CSSGroupingRule) {
          const inner = walk(this.rulesOf(rule));
          if (inner) out += `${rule.cssText.slice(0, rule.cssText.indexOf('{')).trim()} {\n${inner}}\n`;
        }
      }
      return out;
    };
    return walk(rules);
  }
}
