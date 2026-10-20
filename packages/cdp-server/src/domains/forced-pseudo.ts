import { FORCE_ATTRIBUTE } from '../core/nodes';

/** A document or shadow root: what style sheets apply to. */
export type TreeScope = Document | ShadowRoot;

interface Companion {
  sheet: CSSStyleSheet;
  /** Takes the companion and the hook off the tree. */
  restore: (() => void) | null;
}

/** Pseudo-classes CSS.forcePseudoState can force (longer names first, for the alternation). */
const FORCEABLE_CLASSES = ['hover', 'focus-within', 'focus-visible', 'focus', 'active', 'visited', 'target'];
const FORCEABLE = new RegExp(`:(${FORCEABLE_CLASSES.join('|')})(?![\\w-])`, 'g');

/**
 * Emulates CSS.forcePseudoState. Page scripts cannot put an element into :hover (or
 * :focus, …), so forced elements get a marker attribute, and every rule using a forced
 * pseudo-class gets a copy whose selector uses the marker instead.
 *
 * The copies go into a constructed "companion" style sheet appended to the adoptedStyleSheets
 * of the document (and of each shadow root with style sheets, for the rules of that tree), so
 * the page's DOM is untouched. Adopted sheets come after all
 * document sheets in the cascade, so after the first copied rule the companion replays all
 * following rules of every sheet (keeping their @media, @supports, @layer and @import
 * conditions): the cascade order, which decides between rules of equal specificity, stays as
 * if the pseudo-class matched. The page's own style sheets are not modified.
 */
export class ForcedPseudoClasses {
  private forced = new Map<Element, Set<string>>();
  /** The companion of each tree, with the hook keeping it among the tree's adopted sheets. */
  private companions = new Map<TreeScope, Companion>();
  private sheetsOfCompanions = new WeakSet<CSSStyleSheet>();

  /** `trees`: the document and shadow roots, each with its top-level sheets in cascade order. */
  constructor(
    private trees: () => { tree: TreeScope; sheets: CSSStyleSheet[] }[],
    private rulesOf: (sheet: CSSStyleSheet | CSSGroupingRule) => CSSRule[]
  ) {}

  /** Whether `sheet` is one of our companions rather than a sheet of the page. */
  owns(sheet: CSSStyleSheet): boolean {
    return this.sheetsOfCompanions.has(sheet);
  }

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
    this.prune();
    const seen = new Set<TreeScope>();
    if (this.forced.size) {
      for (const { tree, sheets } of this.trees()) {
        const text = this.companionText(sheets);
        if (!text) continue;
        seen.add(tree);
        let companion = this.companions.get(tree);
        if (!companion) {
          companion = { sheet: new CSSStyleSheet(), restore: null };
          this.sheetsOfCompanions.add(companion.sheet);
          this.companions.set(tree, companion);
        }
        companion.sheet.replaceSync(text);
        this.attach(tree, companion);
      }
    }
    for (const [tree, companion] of this.companions) {
      if (seen.has(tree)) continue;
      this.detach(companion);
      this.companions.delete(tree);
    }
  }

  /** Puts each companion back at the end of its tree's adopted sheets, e.g. after the page pushed onto them in place. */
  reattach() {
    for (const [tree, companion] of this.companions) this.attach(tree, companion);
  }

  /**
   * Appends the companion after the tree's adopted sheets, and keeps it there when the page
   * assigns new ones. The page does not see it: reading adoptedStyleSheets gives a copy without
   * it. The trade-off: pushing onto or splicing that copy in place has no effect, where the page
   * would change its adopted sheets; a live view would show the companion. Changes made in place
   * on the real array before the hook (or by code holding it) move the companion away from the
   * end, which reattach() repairs.
   */
  private attach(tree: TreeScope, companion: Companion) {
    const sheet = companion.sheet;
    const proto = tree instanceof ShadowRoot ? ShadowRoot.prototype : Document.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
    const get = descriptor?.get;
    const set = descriptor?.set;
    if (!get || !set) return;
    const native = (): CSSStyleSheet[] => {
      const value: unknown = get.call(tree);
      return Array.isArray(value) ? value.filter((s): s is CSSStyleSheet => s instanceof CSSStyleSheet) : [];
    };
    const adopted = native();
    if (adopted[adopted.length - 1] !== sheet) set.call(tree, [...adopted.filter(s => s !== sheet), sheet]);
    if (companion.restore) return;
    const own = Object.getOwnPropertyDescriptor(tree, 'adoptedStyleSheets');
    Object.defineProperty(tree, 'adoptedStyleSheets', {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      get: (): CSSStyleSheet[] => native().filter(s => s !== sheet),
      set(value: CSSStyleSheet[]) {
        const sheets = Array.from(value).filter(s => s !== sheet);
        set.call(tree, [...sheets, sheet]);
      },
    });
    companion.restore = () => {
      Reflect.deleteProperty(tree, 'adoptedStyleSheets');
      if (own) Object.defineProperty(tree, 'adoptedStyleSheets', own);
      // The page's sheets without the companion.
      const adopted = native();
      if (adopted.includes(sheet))
        set.call(
          tree,
          adopted.filter(s => s !== sheet)
        );
    };
  }

  /** Removes the companion; the page's adopted sheets stay. */
  private detach(companion: Companion) {
    companion.restore?.();
    companion.restore = null;
  }

  /**
   * The companion's rules: walking the tree's style sheets in cascade order (sheets of <style>
   * and <link> with their @import-ed sheets inlined, then adopted sheets), each rule using a forced
   * pseudo-class is copied with the rewritten selector, and after the first copy every
   * following style rule is replayed, so that rules later in the cascade still win.
   */
  private companionText(sheets: CSSStyleSheet[]): string {
    let started = false;
    const prelude = (rule: CSSRule) => rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();
    const wrap = (inner: string, preludes: string[]) => preludes.reduceRight((out, p) => `${p} {\n${out}}\n`, inner);
    const walkSheet = (sheet: CSSStyleSheet): string => {
      if (sheet.disabled) return '';
      const inner = walk(this.rulesOf(sheet));
      return inner && sheet.media.length ? wrap(inner, [`@media ${sheet.media.mediaText}`]) : inner;
    };
    const walk = (list: CSSRule[]): string => {
      let out = '';
      for (const rule of list) {
        if (rule instanceof CSSStyleRule) {
          // Nested rules (`&:hover`) resolve `&` against the copy of their parent, which only
          // carries its own declarations once copying started.
          const rewritten = this.rewrite(rule.selectorText);
          if (rewritten !== rule.selectorText) started = true;
          const own = started ? rule.style.cssText : '';
          const nested = walk(this.rulesOf(rule));
          if (own || nested) out += `${rewritten} { ${own}${nested ? `\n${nested}` : ''} }\n`;
        } else if (rule instanceof CSSNestedDeclarations) {
          if (started && rule.style.cssText) out += `${rule.style.cssText}\n`;
        } else if (rule instanceof CSSGroupingRule) {
          const inner = walk(this.rulesOf(rule));
          // Limitation: a copy of an anonymous `@layer { }` is a new anonymous layer, after all
          // layers of the page, so it ranks above named layers the page put later. Named layers
          // keep their place, as their order is fixed by the page's sheets, which come first.
          if (inner) out += wrap(inner, [prelude(rule)]);
        } else if (rule instanceof CSSLayerStatementRule) {
          // Layer order is fixed by the page's sheets, which come first.
          continue;
        } else if (rule instanceof CSSImportRule && rule.styleSheet) {
          const inner = walk(this.rulesOf(rule.styleSheet));
          if (!inner) continue;
          const preludes: string[] = [];
          if (rule.layerName !== null) preludes.push(`@layer ${rule.layerName}`.trim());
          if (rule.supportsText) preludes.push(`@supports ${rule.supportsText}`);
          if (rule.media.length) preludes.push(`@media ${rule.media.mediaText}`);
          out += wrap(inner, preludes);
        }
      }
      return out;
    };
    let out = '';
    for (const sheet of sheets) out += walkSheet(sheet);
    return out;
  }
}
