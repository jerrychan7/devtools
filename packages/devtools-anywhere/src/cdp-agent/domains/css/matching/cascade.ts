import type { Protocol } from 'devtools-protocol';
import { documentOf, isCssom, isElement, isHtmlElement, isShadowRoot, isSvgElement } from '../../../core/realm';
import { containerMatches, parentOf } from '../../../core/style/container-query';
import type { NodeRegistry, PseudoType } from '../../../core/nodes/nodes';
import { compareSpecificity, specificity, splitTopLevel } from '../../../core/style/selectors';
import type { ForcedPseudoClasses, TreeScope } from './forced-pseudo';
import type { RuleView } from './rule-view';
import { type Entry, type StyleRule, ancestorsOf, resolveSelector, sheetApplies } from './rules';
import type { SheetRegistry } from '../sheets/sheet-registry';
import { hostMatcher } from './host';
import { matchInNamespaces } from './namespaces';
import { namespaceText } from '../sheets/sheet-text';
import type { UserAgentStyles } from '../user-agent/user-agent';
import { type CSSStyle, INLINE_PREFIX, buildStyle, sources, splitPseudoElement } from '../style';

/** A style rule ready for matching: its selectors resolved and split, with forced pseudo-classes rewritten. */
type Candidate = {
  sheet: CSSStyleSheet;
  /** The document or shadow root the sheet applies to. */
  tree: TreeScope;
  rule: StyleRule;
  order: number;
  /** Positions of its cascade layers among their siblings, outermost first. */
  layer: number[];
  containers: CSSContainerRule[];
  /** The innermost @scope around it. */
  scope: CSSScopeRule | null;
  selectors: {
    index: number;
    pseudo: string | null;
    host: string;
    spec: Protocol.CSS.Specificity;
    /** For `<slot selector>::slotted(<slotted>)`. */
    slotted: string | null;
  }[];
};

type Kind = 'own' | 'host' | 'slotted';
type Selector = Candidate['selectors'][number];

/** Matches elements against the page's style rules, in cascade order. */
export class Cascade {
  /**
   * The candidates of the request being answered: one request matches the element, its
   * pseudo-elements and its ancestors against the same rules, so they are collected once.
   */
  private request: Map<TreeScope, Candidate[]> | null = null;
  /** The namespaces of sheets, and what was matched in them (see inNamespaces), for one request. */
  private namespaceCache: {
    namespaces: Map<CSSStyleSheet, string>;
    matched: Map<TreeScope, Map<Element, Map<CSSStyleSheet, Map<string, boolean>>>>;
  } | null = null;

  private readonly sheets: SheetRegistry;
  private readonly forced: ForcedPseudoClasses;
  private readonly nodes: NodeRegistry;
  private readonly rules: RuleView;
  /** The user agent style sheet's rules, which come before all others. */
  private readonly userAgent: UserAgentStyles | null;

  constructor(
    sheets: SheetRegistry,
    forced: ForcedPseudoClasses,
    nodes: NodeRegistry,
    rules: RuleView,
    userAgent: UserAgentStyles | null = null
  ) {
    this.sheets = sheets;
    this.forced = forced;
    this.nodes = nodes;
    this.rules = rules;
    this.userAgent = userAgent;
  }

  /** Runs `answer` with the candidates collected once for it. */
  forRequest<T>(answer: () => T): T {
    this.request = this.candidates();
    this.namespaceCache = null;
    try {
      return answer();
    } finally {
      this.request = null;
      this.namespaceCache = null;
    }
  }

  /** Candidates by the tree their sheets apply to. */
  private candidates(): Map<TreeScope, Candidate[]> {
    const result = new Map<TreeScope, Candidate[]>();
    // Each tree has cascade layers of its own.
    const layerOrders = new Map<TreeScope, Map<string, number>>();
    const pending: { sheet: CSSStyleSheet; tree: TreeScope; entry: Entry }[] = [];
    for (const { sheet, tree } of this.sheets.scoped()) {
      if (sheet.disabled || !sheetApplies(sheet, this.sheets.realmOf(sheet))) continue;
      let layerOrder = layerOrders.get(tree);
      if (!layerOrder) layerOrders.set(tree, (layerOrder = new Map()));
      for (const entry of this.sheets.entries(sheet, true, layerOrder)) pending.push({ sheet, tree, entry });
    }
    // Layers are ranked once all of them are declared: a later sheet can declare an order.
    pending.forEach(({ sheet, tree, entry: { rule, layer } }, order) => {
      const ancestors = ancestorsOf(rule);
      const parts = isCssom(rule, 'CSSStyleRule') ? splitTopLevel(rule.selectorText, ',') : ['&'];
      const selectors = parts.map((s, index) => {
        const selector = s.trim();
        const resolved = resolveSelector(selector, rule);
        const split = splitPseudoElement(resolved);
        const spec = specificity(resolveSelector(selector, rule, true));
        const slotted = /::slotted\((.*)\)$/i.exec(resolved)?.[1];
        return {
          index,
          pseudo: slotted === undefined ? split.pseudo : 'slotted',
          host: this.forced.rewrite(split.host),
          spec,
          slotted: slotted === undefined ? null : this.forced.rewrite(slotted),
        };
      });
      const layerOrder = layerOrders.get(tree);
      let bucket = result.get(tree);
      if (!bucket) result.set(tree, (bucket = []));
      bucket.push({
        sheet,
        tree,
        rule,
        order,
        layer: layer.map((_, i) => layerOrder?.get(layer.slice(0, i + 1).join('\u0001')) ?? 0),
        containers: ancestors.filter(a => isCssom(a, 'CSSContainerRule')),
        scope: ancestors.find(a => isCssom(a, 'CSSScopeRule')) ?? null,
        selectors,
      });
    });
    return result;
  }

  /**
   * Cascade layer order: layers in order of declaration, and rules outside any layer (or
   * directly in a layer, rather than in its sub-layers) after them.
   */
  private compareLayers(x: number[], y: number[]): number {
    for (let i = 0; ; i++) {
      if (i >= x.length || i >= y.length) return y.length - x.length;
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d) return d;
    }
  }

  /**
   * How many generations up the scoping root of `el` is for a rule in `scope`, the nearest
   * root first, or null when no root has `el` in scope and matching `test`.
   */
  private scopeProximity(sheet: CSSStyleSheet, scope: CSSScopeRule, el: Element, test: (root: Element) => boolean) {
    const owner = sheet.ownerNode;
    // Without a prelude, the root is the parent of the <style>.
    const implicitRoot = isElement(owner) ? owner.parentElement : documentOf(el).documentElement;
    const matches = (node: Element, selector: string) => {
      try {
        return node.matches(selector);
      } catch {
        return false;
      }
    };
    for (let root: Element | null = el, distance = 0; root; root = parentOf(root), distance++) {
      if (scope.start === null ? root !== implicitRoot : !matches(root, scope.start)) continue;
      // The limit and what is below it are out of scope.
      let limited = false;
      const end = scope.end;
      if (end !== null)
        for (let node: Element | null = el; node && node !== root; node = parentOf(node))
          if (matches(node, end)) limited = true;
      if (!limited && test(root)) return distance;
    }
    return null;
  }
  /**
   * Whether `el` matches selector `s` of a candidate as the rules of a tree match it (`kind`), in
   * the namespaces its sheet declares; undefined for a sheet declaring none, which
   * Element.matches() can match. Found by a probe (namespaces.ts) for all the candidates of the
   * tree at once, and for an element of the tree, for its ancestors too: they are matched next.
   */
  private inNamespaces(kind: Kind, group: Candidate[], el: Element, c: Candidate, s: Selector): boolean | undefined {
    const cache = (this.namespaceCache ??= { namespaces: new Map(), matched: new Map() });
    const namespacesOf = (sheet: CSSStyleSheet) => {
      let text = cache.namespaces.get(sheet);
      if (text === undefined) cache.namespaces.set(sheet, (text = namespaceText(this.sheets.rulesOf(sheet))));
      return text;
    };
    if (!namespacesOf(c.sheet)) return undefined;
    // Only for the elements asked about (`own`), so that few others have their style recalculated;
    // after the selector, which keeps the default namespace (not applied inside :is()).
    const probe = (c: Candidate, s: Selector): ((d: string, own: string) => string) | null => {
      if (kind === 'slotted')
        return s.slotted === null ? null : (d, own) => `${s.host}::slotted(${s.slotted}:is(${own})){${d}}`;
      // A host matches `:host()` alone (it is featureless).
      if (kind === 'host') return d => `${s.host}{${d}}`;
      if (!c.scope) return (d, own) => `${s.host}:is(${own}){${d}}`;
      // The implicit root of an @scope is the parent of its own sheet's <style>.
      const { start, end } = c.scope;
      if (start === null) return null;
      return (d, own) => `@scope (${start})${end === null ? '' : ` to (${end})`}{${s.host}:is(${own}){${d}}}`;
    };
    const key = (c: Candidate, s: Selector) =>
      `${kind}\u0001${c.scope ? `${c.scope.start}\u0002${c.scope.end}` : ''}\u0001${s.host}\u0001${s.slotted}`;
    let byTree = cache.matched.get(c.tree);
    if (!byTree) cache.matched.set(c.tree, (byTree = new Map()));
    const known = byTree.get(el)?.get(c.sheet)?.get(key(c, s));
    if (known !== undefined) return known;
    const els = [el];
    if (kind === 'own') for (let p = el.parentElement; p && !byTree.has(p); p = p.parentElement) els.push(p);
    const bySheet = new Map<CSSStyleSheet, { keys: string[]; rules: ((d: string, own: string) => string)[] }>();
    for (const candidate of group) {
      if (!namespacesOf(candidate.sheet)) continue;
      let entry = bySheet.get(candidate.sheet);
      if (!entry) bySheet.set(candidate.sheet, (entry = { keys: [], rules: [] }));
      for (const selector of candidate.selectors) {
        const rule = probe(candidate, selector);
        const k = key(candidate, selector);
        if (rule && !entry.keys.includes(k)) {
          entry.keys.push(k);
          entry.rules.push(rule);
        }
      }
    }
    const sheets = [...bySheet];
    const found = matchInNamespaces(
      els,
      c.tree,
      sheets.map(([sheet, { rules }]) => ({ namespaces: namespacesOf(sheet), rules }))
    );
    els.forEach((e, j) => {
      let bySheetOf = byTree.get(e);
      if (!bySheetOf) byTree.set(e, (bySheetOf = new Map()));
      sheets.forEach(([sheet, { keys }], i) => {
        let byKey = bySheetOf.get(sheet);
        if (!byKey) bySheetOf.set(sheet, (byKey = new Map()));
        keys.forEach((k, n) => byKey.set(k, found[i]?.[j]?.[n] ?? false));
      });
    });
    return byTree.get(el)?.get(c.sheet)?.get(key(c, s));
  }

  /**
   * Rules matching `el`, or with `pseudo`, its pseudo-element, in cascade order (lowest
   * priority first). Selectors ending in a pseudo-element only match that pseudo-element.
   */
  matchedRules(el: Element, pseudo: PseudoType | null = null): Protocol.CSS.RuleMatch[] {
    // Kept for one request only: out of one, for one call.
    if (!this.request) this.namespaceCache = null;
    const matches: {
      match: Protocol.CSS.RuleMatch;
      spec: Protocol.CSS.Specificity;
      order: number;
      layer: number[];
      proximity: number;
      rank: number;
    }[] = [];
    // A pseudo-element's own element can be its container; a slotted element's is up its slot.
    const containerStart = pseudo ? el : (el.assignedSlot ?? parentOf(el));
    const byTree = this.request ?? this.candidates();
    // Rules of a shadow tree reach outside it only through `:host` and `::slotted()`.
    const ownShadow = this.nodes.shadowRootOf(el);
    const elRoot = el.getRootNode();
    const groups: [Candidate[] | undefined, 'own' | 'host' | 'slotted', HTMLSlotElement | null, number][] = [
      // An element of an iframe's document matches the rules of that document only.
      [byTree.get(isShadowRoot(elRoot) ? elRoot : documentOf(el)), 'own', null, 0],
    ];
    // A slot can itself be assigned to a slot further in: `::slotted()` of each of those trees
    // matches, the trees further in losing to those closer to the element, like in Chrome.
    // Rules of inner trees lose to those of the element's own tree, whatever their layer or
    // specificity (the context of the cascade), and like in Chrome, `:host` ones lose to all.
    let depth = 1;
    for (let slot = el.assignedSlot; slot; slot = slot.assignedSlot) {
      const slotTree = slot.getRootNode();
      if (isShadowRoot(slotTree)) groups.push([byTree.get(slotTree), 'slotted', slot, -depth++]);
    }
    groups.push([ownShadow ? byTree.get(ownShadow) : undefined, 'host', null, -depth]);
    for (const [group, kind, slot, rank] of groups) {
      for (const candidate of group ?? []) {
        const { sheet, tree, rule, order, layer, containers, scope, selectors } = candidate;
        let proximity = Infinity;
        const matched = selectors.filter(s => {
          try {
            if (kind === 'slotted') {
              if (pseudo || s.slotted === null) return false;
              return (
                this.inNamespaces(kind, group ?? [], el, candidate, s) ??
                (!!slot?.matches(s.host) && el.matches(s.slotted))
              );
            }
            if (s.pseudo !== pseudo) return false;
            const declared = this.inNamespaces(kind, group ?? [], el, candidate, s);
            if (kind === 'host') {
              if (declared !== undefined) return declared;
              const host = hostMatcher(s.host);
              return host !== null && host(el);
            }
            if (!scope) return declared ?? el.matches(s.host);
            if (declared === false) return false;
            if (declared) {
              // Its proximity where Element.matches() can tell it, else as if the root were the farthest.
              let distance: number | null = null;
              try {
                distance = this.scopeProximity(sheet, scope, el, root =>
                  root === el ? el.matches(s.host) : Array.from(root.querySelectorAll(s.host)).includes(el)
                );
              } catch {
                // A prefix Element.matches() does not know.
              }
              if (distance !== null) proximity = Math.min(proximity, distance);
              return true;
            }
            // `:scope` is the root: Element.matches for the root itself, querySelectorAll below it,
            // once the element matches the selector with any root.
            const anyRoot = s.host.replace(/:scope(?![\w-])/g, ':is(*)');
            if (!el.matches(anyRoot)) return false;
            const distance = this.scopeProximity(sheet, scope, el, root =>
              root === el ? el.matches(s.host) : Array.from(root.querySelectorAll(s.host)).includes(el)
            );
            if (distance === null) return false;
            proximity = Math.min(proximity, distance);
            return true;
          } catch {
            return false; // Unsupported selector.
          }
        });
        if (!matched.length) continue;
        if (!containers.every(c => containerMatches(containerStart, c.containerName, c.containerQuery))) continue;
        // Like Chrome, nested declarations count as matching through their (only) selector `&`.
        const matching = matched.map(m => m.index);
        const spec = matched.map(m => m.spec).reduce((m, s) => (compareSpecificity(s, m) > 0 ? s : m));
        matches.push({
          match: { rule: this.rules.cssRule(sheet, rule, tree), matchingSelectors: matching },
          spec,
          order,
          layer,
          proximity,
          rank,
        });
      }
    }
    // Context, then layers, then specificity, then scope proximity (nearer roots win), then order of
    // appearance. Inspector rules win over regular ones of equal specificity, as they come last.
    const userAgent = this.userAgent?.matchedRules(el, pseudo) ?? [];
    return userAgent.concat(
      matches
        .sort(
          (x, y) =>
            x.rank - y.rank ||
            this.compareLayers(x.layer, y.layer) ||
            compareSpecificity(x.spec, y.spec) ||
            (x.proximity === y.proximity ? 0 : x.proximity > y.proximity ? -1 : 1) ||
            x.order - y.order
        )
        .map(m => m.match)
    );
  }

  inlineStyle(el: Element): CSSStyle | undefined {
    if (!(isHtmlElement(el) || isSvgElement(el))) return undefined;
    // Like Chrome, declarations in the order of the style attribute, which the CSSOM does not keep.
    const attribute = el.getAttribute('style');
    if (attribute !== null) sources.set(el.style, { text: attribute, applied: el.style.cssText });
    return buildStyle(INLINE_PREFIX + this.nodes.backendIdOf(el), el.style, 0, 0);
  }

  inheritedEntries(from: Element | null): Protocol.CSS.InheritedStyleEntry[] {
    const inherited: Protocol.CSS.InheritedStyleEntry[] = [];
    // Like Chrome, along the flat tree: a slotted element inherits from its slot.
    for (let parent = from; parent; parent = parent.assignedSlot ?? parentOf(parent)) {
      const entry: Protocol.CSS.InheritedStyleEntry = { matchedCSSRules: this.matchedRules(parent) };
      const style = this.inlineStyle(parent);
      if (style) entry.inlineStyle = style;
      inherited.push(entry);
    }
    return inherited;
  }
}
