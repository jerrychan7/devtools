import { quietly } from '../../core/adopted';
import { FORCE_ATTRIBUTE } from '../../core/nodes';

/** A document or shadow root: what style sheets apply to. */
export type TreeScope = Document | ShadowRoot;

interface Companion {
  sheet: CSSStyleSheet;
  /** Takes the companion and the hook off the tree. */
  restore: (() => void) | null;
}

/** Pseudo-classes CSS.forcePseudoState can force (longer names first, for the alternation). */
const FORCEABLE_CLASSES = ['hover', 'focus-within', 'focus-visible', 'focus', 'active', 'visited', 'target'];
/** The properties a `:visited` rule can change in Chrome. */
const VISITED =
  /^(color|background-color|border-(top|right|bottom|left|block-start|block-end|inline-start|inline-end)-color|column-rule-color|outline-color|text-decoration-color|text-emphasis-color|caret-color|fill|stroke|-webkit-text-(fill|stroke)-color)$/;
const FORCEABLE = new RegExp(`:(${FORCEABLE_CLASSES.join('|')})(?![\\w-])`, 'g');

/** Whether `el` is `node` or inside it, in its shadow trees too. */
function containsAcrossShadow(node: Node, el: Element): boolean {
  for (let n: Node | null = el; n; n = n instanceof ShadowRoot ? n.host : n.parentNode) {
    if (n === node) return true;
  }
  return false;
}

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
  /** Media queries the companions depend on (for the layer order), and their change listeners. */
  private queries = new Map<string, { list: MediaQueryList; listener: () => void }>();
  private queried = new Set<string>();
  private mediaLists = new Map<string, MediaQueryList>();
  /** Media queries the last rebuild looked at: the others are let go. */
  private usedMedia = new Set<string>();

  /** The document and shadow roots, each with its top-level sheets in cascade order. */
  private trees: () => { tree: TreeScope; sheets: CSSStyleSheet[] }[];
  private rulesOf: (sheet: CSSStyleSheet | CSSGroupingRule) => CSSRule[];

  constructor(
    trees: () => { tree: TreeScope; sheets: CSSStyleSheet[] }[],
    rulesOf: (sheet: CSSStyleSheet | CSSGroupingRule) => CSSRule[]
  ) {
    this.trees = trees;
    this.rulesOf = rulesOf;
  }

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
   * still applies, as its style sheets are not modified. `skip`: a class left as it is.
   */
  rewrite(selector: string, skip?: string): string {
    const active = this.active();
    if (!active.size) return selector;
    return selector.replace(FORCEABLE, (match, name: string) =>
      active.has(name) && name !== skip ? `:is(${match}, [${FORCE_ATTRIBUTE}~="${name}"])` : match
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
      if (!removed.some(node => containsAcrossShadow(node, el))) continue;
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
    this.queried.clear();
    this.usedMedia.clear();
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
    this.watch();
    for (const text of this.mediaLists.keys()) {
      if (!this.usedMedia.has(text) && !this.queries.has(text)) this.mediaLists.delete(text);
    }
  }

  private mediaList(text: string): MediaQueryList {
    this.usedMedia.add(text);
    let list = this.mediaLists.get(text);
    if (!list) {
      list = matchMedia(text);
      this.mediaLists.set(text, list);
    }
    return list;
  }

  /** Rebuilds when a media query the layer order depended on changes; only while something is forced. */
  private watch() {
    for (const [text, { list, listener }] of this.queries) {
      if (this.queried.has(text)) continue;
      list.removeEventListener('change', listener);
      this.queries.delete(text);
      this.mediaLists.delete(text);
    }
    for (const text of this.queried) {
      if (this.queries.has(text)) continue;
      const list = this.mediaList(text);
      const listener = () => this.rebuild();
      list.addEventListener('change', listener);
      this.queries.set(text, { list, listener });
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
    // Our own reads and writes are not changes of the page's adopted sheets.
    quietly(() => {
      const adopted = native();
      if (adopted[adopted.length - 1] !== sheet) set.call(tree, [...adopted.filter(s => s !== sheet), sheet]);
    });
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
      quietly(() => {
        const adopted = native();
        if (adopted.includes(sheet))
          set.call(
            tree,
            adopted.filter(s => s !== sheet)
          );
      });
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
   *
   * A copy of an anonymous `@layer { }` would be a new anonymous layer after all layers of its
   * parent, so those copies are not made in place. Instead the parent (the page or a named layer)
   * gets one more, last, sublayer holding, in the page's layer order, the first anonymous layer
   * with copied rules and every layer after it, each with all its rules: the copies win over
   * their layer, and the layers after it still win over them. For !important, where layer order
   * is reversed, a last sublayer is added to the nearest named layer before the anonymous one (at
   * its level or an ancestor's), holding that layer's own rules and every layer from there up to
   * the anonymous one: that ranks between them, as the anonymous layer does. Limitation: with no
   * named layer before it, at any level, the !important copies of an anonymous layer rank below
   * the !important rules of the layers after it, which the page's own sheets keep.
   *
   * Layers first named in a false @media or @supports are not put into the layer order, as in
   * Chrome; those in @container are, whatever the container (also as in Chrome).
   */
  private companionText(sheets: CSSStyleSheet[]): string {
    /** A cascade layer of the page: its sublayers in layer order, all its rules, and its own ones. */
    interface Layer {
      name: string;
      parent: Layer | null;
      children: Layer[];
      text: string;
      own: string;
    }
    const root: Layer = { name: '', parent: null, children: [], text: '', own: '' };
    /** The anonymous layer of each `@layer { }` and `@import … layer`. */
    const anonymousOf = new Map<CSSRule, Layer>();
    /** The `@layer { }` and `@import … layer` rules of anonymous layers holding a copied rule. */
    const copiedRules = new Set<CSSRule>();
    const copied = new Set<Layer>();
    let started = false;
    let all = false;
    const prelude = (rule: CSSRule) => rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();
    const wrap = (inner: string, preludes: string[]) => preludes.reduceRight((out, p) => `${p} {\n${out}}\n`, inner);
    const media = (text: string) => !text || this.mediaList(text).matches;
    /** The media queries around the rules being walked (with `all`): they decide on the layers named there. */
    const open: string[] = [];
    const under = <T>(text: string, fn: () => T): T => {
      if (!all || !text) return fn();
      open.push(text);
      try {
        return fn();
      } finally {
        open.pop();
      }
    };
    const supports = (text: string) => !text || CSS.supports(`(${text})`);
    /** The sublayer `name` of `parent`, put into the layer order when `live` (its conditions hold). */
    const sublayer = (parent: Layer, name: string, live: boolean): Layer => {
      let layer = name ? parent.children.find(c => c.name === name) : undefined;
      if (!layer) {
        layer = { name, parent, children: [], text: '', own: '' };
        if (!live) return layer;
        parent.children.push(layer);
      }
      return layer;
    };
    /**
     * Enters the layer `name` (dotted, or '' for anonymous) of `parent`, recording `inner` (with
     * `conditions`, the preludes since `parent`) into it and each layer on the way.
     */
    const enter = (rule: CSSRule, parent: Layer, name: string, conditions: string[], live: boolean) => {
      for (const text of open) this.queried.add(text);
      const names = name ? name.split('.') : [''];
      const layers: Layer[] = [];
      let at = parent;
      for (const n of names) {
        at = n ? sublayer(at, n, live) : (anonymousOf.get(rule) ?? sublayer(at, '', live));
        if (!n) anonymousOf.set(rule, at);
        layers.push(at);
      }
      return (inner: string, own: string) => {
        layers.forEach((layer, i) => {
          const rest = names.slice(i + 1).join('.');
          layer.text += wrap(inner, [...conditions, ...(rest ? [`@layer ${rest}`] : [])]);
        });
        at.own += wrap(own, conditions);
      };
    };
    const walkSheet = (sheet: CSSStyleSheet): string => {
      if (sheet.disabled) return '';
      const conditions = sheet.media.length ? [`@media ${sheet.media.mediaText}`] : [];
      const [inner] = under(sheet.media.mediaText, () =>
        walk(this.rulesOf(sheet), root, conditions, media(sheet.media.mediaText))
      );
      return inner && conditions.length ? wrap(inner, conditions) : inner;
    };
    /**
     * The copy of `list`, and of its rules outside sublayers. `layer`: the layer it is in;
     * `conditions`: the preludes around it since that layer; `live`: whether they hold.
     */
    const walk = (list: CSSRule[], layer: Layer, conditions: string[], live: boolean): [string, string] => {
      let out = '';
      let own = '';
      for (const rule of list) {
        if (rule instanceof CSSStyleRule) {
          // Nested rules (`&:hover`) resolve `&` against the copy of their parent, which only
          // carries its own declarations once copying started.
          const rewritten = this.rewrite(rule.selectorText);
          if (rewritten !== rule.selectorText) started = true;
          // A rule matching only through a forced `:visited` applies only the properties Chrome
          // lets `:visited` change (colors), for privacy.
          const visitedOnly =
            rewritten !== rule.selectorText && this.rewrite(rule.selectorText, 'visited') === rule.selectorText;
          const declarations = !(started || all)
            ? ''
            : visitedOnly
              ? Array.from(rule.style)
                  .filter(p => VISITED.test(p))
                  .map(
                    p => `${p}: ${rule.style.getPropertyValue(p)} ${rule.style.getPropertyPriority(p) && '!important'};`
                  )
                  .join(' ')
              : rule.style.cssText;
          const [nested] = walk(this.rulesOf(rule), layer, conditions, live);
          if (declarations || nested) {
            const text = `${rewritten} { ${declarations}${nested ? `\n${nested}` : ''} }\n`;
            out += text;
            own += text;
          }
        } else if (rule instanceof CSSNestedDeclarations) {
          if ((started || all) && rule.style.cssText) {
            out += `${rule.style.cssText}\n`;
            own += `${rule.style.cssText}\n`;
          }
        } else if (rule instanceof CSSLayerBlockRule) {
          const record = all ? enter(rule, layer, rule.name, conditions, live) : null;
          const sub = all ? (anonymousOf.get(rule) ?? layer) : layer;
          const [inner, innerOwn] = walk(this.rulesOf(rule), sub, [], live);
          record?.(inner, innerOwn);
          if (!rule.name && !all) {
            // Copied at the end instead, see above.
            if (inner) copiedRules.add(rule);
          } else if (inner) out += wrap(inner, [prelude(rule)]);
        } else if (rule instanceof CSSGroupingRule) {
          const p = prelude(rule);
          let holds = live;
          const query = rule instanceof CSSMediaRule ? rule.media.mediaText : '';
          if (query) holds &&= media(query);
          else if (rule instanceof CSSSupportsRule) holds &&= CSS.supports(rule.conditionText);
          const [inner, innerOwn] = under(query, () => walk(this.rulesOf(rule), layer, [...conditions, p], holds));
          if (inner) out += wrap(inner, [p]);
          if (innerOwn) own += wrap(innerOwn, [p]);
        } else if (rule instanceof CSSLayerStatementRule) {
          if (all && live) for (const name of rule.nameList) enter(rule, layer, name, conditions, true);
          if (all) out += `${rule.cssText}\n`;
        } else if (rule instanceof CSSImportRule && rule.styleSheet) {
          const wrappers: string[] = [];
          if (rule.supportsText) wrappers.push(`@supports ${rule.supportsText}`);
          if (rule.media.length) wrappers.push(`@media ${rule.media.mediaText}`);
          const holds = live && supports(rule.supportsText ?? '') && media(rule.media.mediaText);
          const layerName = rule.layerName;
          if (layerName === null) {
            const sheet = rule.styleSheet;
            const [inner, innerOwn] = under(rule.media.mediaText, () =>
              walk(this.rulesOf(sheet), layer, [...conditions, ...wrappers], holds)
            );
            if (inner) out += wrap(inner, wrappers);
            if (innerOwn) own += wrap(innerOwn, wrappers);
            continue;
          }
          const record = all
            ? under(rule.media.mediaText, () => enter(rule, layer, layerName, [...conditions, ...wrappers], holds))
            : null;
          const sub = all ? (anonymousOf.get(rule) ?? layer) : layer;
          const [inner, innerOwn] = walk(this.rulesOf(rule.styleSheet), sub, [], holds);
          record?.(inner, innerOwn);
          if (!layerName && !all) {
            if (inner) copiedRules.add(rule);
          } else if (inner) out += wrap(inner, [`@layer ${layerName}`.trim(), ...wrappers]);
        }
      }
      return [out, own];
    };
    let out = '';
    for (const sheet of sheets) out += walkSheet(sheet);
    if (!copiedRules.size) return out;
    // The page's layers, with all their rules.
    all = true;
    for (const sheet of sheets) walkSheet(sheet);
    for (const rule of copiedRules) {
      const anonymous = anonymousOf.get(rule);
      if (anonymous) copied.add(anonymous);
    }
    const path = (layer: Layer): string[] => (layer.parent ? [...path(layer.parent), layer.name] : []);
    const full = (layers: Layer[]) => layers.map(l => wrap(l.text, ['@layer'])).join('');
    const within = (layer: Layer, inner: string) =>
      layer.parent ? wrap(inner, [`@layer ${path(layer).join('.')}`]) : inner;
    const visit = (layer: Layer) => {
      const indexes = layer.children.flatMap((c, i) => (copied.has(c) ? [i] : []));
      const first = indexes[0];
      const last = indexes[indexes.length - 1];
      if (first !== undefined && last !== undefined) {
        out += within(layer, wrap(full(layer.children.slice(first)), ['@layer']));
        // !important: find a named layer before, at this level or an ancestor's.
        let at = layer;
        let index = first;
        let tail = full(layer.children.slice(first, last + 1));
        for (;;) {
          const before = at.children.slice(0, index);
          let named = before.length - 1;
          while (named >= 0 && before[named]?.name === '') named--;
          const host = before[named];
          if (host) {
            const inner = wrap(host.own, ['@layer']) + full(before.slice(named + 1)) + tail;
            out += within(host, wrap(inner, ['@layer']));
            break;
          }
          const parent = at.parent;
          if (!parent) break;
          tail = wrap(full(before) + tail, ['@layer']);
          index = parent.children.indexOf(at);
          at = parent;
        }
      }
      for (const child of layer.children) if (child.name) visit(child);
    };
    visit(root);
    return out;
  }
}
