import type { Protocol } from 'devtools-protocol';
import { type Context } from '../../core/context';
import { OWN_ATTRIBUTE, PSEUDO_TYPES, isOwn, markOwn, PseudoElement, type PseudoType } from '../../core/nodes';
import { containerMatches, parentOf, queriedAxes } from '../../core/container-query';
import { compareSpecificity, specificity, splitTopLevel } from '../../core/selectors';
import { CdpError } from '../../core/session';
import { resolveElement } from '../dom/dom';
import { historyOf } from '../../core/history';
import { quietly, watchAdopted } from '../../core/adopted';
import { ForcedPseudoClasses, type TreeScope } from './forced-pseudo';
import { backgroundsBehind } from './color';
import {
  type Entry,
  type StyleRule,
  ancestorsOf,
  resolveSelector,
  ruleType,
  scopeText,
  mediaList,
  selectorLabel,
  sheetApplies,
} from './rules';
import { SheetRegistry, isConstructed } from './sheet-registry';
import { hostMatcher, sourceSelectors } from './source';
import {
  type CSSStyle,
  type ComputedStyleResponse,
  INLINE_PREFIX,
  buildStyle,
  setStyleText,
  sources,
  splitPseudoElement,
} from './style';

/** What the CSS domain watches in the document and shadow roots for style sheet changes. */
const OBSERVED: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributeFilter: ['href', 'rel', 'disabled', 'media', 'type'],
};

export function registerCss(ctx: Context) {
  const { session, nodes } = ctx;
  const history = historyOf(ctx);

  /**
   * Shadow roots in the document (closed ones too, when the probe recorded them), in tree order.
   * While the CSS domain is enabled they are kept until the observer sees an element come or go,
   * or a shadow root is attached.
   */
  let shadowRootCache: ShadowRoot[] | null = null;

  // An element already in the document can get a shadow root (e.g. a custom element upgraded
  // later): attaching one makes the cached list stale.
  let stopShadowRoots: (() => void) | null = null;
  function shadowRoots(): ShadowRoot[] {
    if (shadowRootCache) return shadowRootCache;
    const roots: ShadowRoot[] = [];
    const visit = (root: Document | ShadowRoot) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node instanceof Element) || isOwn(node)) continue;
        const shadowRoot = nodes.shadowRootOf(node);
        if (!shadowRoot) continue;
        roots.push(shadowRoot);
        // The document observer does not see into shadow trees.
        if (observer && !observed.has(shadowRoot)) {
          observed.add(shadowRoot);
          observer.observe(shadowRoot, OBSERVED);
        }
        visit(shadowRoot);
      }
    };
    visit(document);
    if (observer) shadowRootCache = roots;
    return roots;
  }

  const sheets = new SheetRegistry(ctx.probe.fetch, shadowRoots);
  const forced = new ForcedPseudoClasses(
    () => sheets.trees(),
    sheet => sheets.rulesOf(sheet)
  );
  sheets.isOwnSheet = sheet => forced.owns(sheet);

  // The DOM does not tell which <style> the parser made: those in the document before the
  // parser is done are taken as its own, those added later as a script's. A script that adds
  // one while the page loads is taken for the parser.
  const parsed = new WeakSet<HTMLStyleElement>();
  const collectParsed = () => document.querySelectorAll('style').forEach(s => parsed.add(s));
  collectParsed();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', collectParsed, { once: true });
  sheets.fromParser = style => parsed.has(style);

  /** After the page's styles changed: keep forced states and pseudo-elements in sync. */
  function stylesChanged() {
    // The companion sheets it adopts are ours, not a change of the page's.
    if (forced.isActive) quietly(() => forced.rebuild());
    ctx.refreshPseudoElements?.();
  }
  let enabled = false;
  let known = new Set<CSSStyleSheet>();
  let observer: MutationObserver | null = null;
  let stopAdopted: (() => void) | null = null;

  function header(sheet: CSSStyleSheet) {
    const h = sheets.header(sheet);
    if (sheet.ownerNode && sheet !== sheets.inspectorSheet) h.ownerNode = nodes.backendIdOf(sheet.ownerNode);
    return h;
  }

  /** Shadow roots the observer watches, as it does not see into them from the document. */
  let observed = new WeakSet<ShadowRoot>();

  /** Reports added and removed sheets since the last call. */
  function syncSheets() {
    return quietly(reportSheets);
  }

  function reportSheets() {
    const scoped = sheets.scoped();
    const current = new Set(scoped.map(s => s.sheet));
    for (const sheet of current) if (!known.has(sheet)) session.emit('CSS.styleSheetAdded', { header: header(sheet) });
    for (const sheet of known)
      if (!current.has(sheet)) session.emit('CSS.styleSheetRemoved', { styleSheetId: sheets.idOf(sheet) });
    known = current;
    if (forced.isActive) forced.rebuild();
    else forced.reattach();
    return loadCopies();
  }

  /** `load` reaches the document for every image and script too: only style elements matter. */
  const onLoad = (event: Event) => {
    if (event.target instanceof HTMLLinkElement || event.target instanceof HTMLStyleElement) void syncSheets();
  };

  /** Loads copies of cross-origin sheets; the client re-reads a sheet once its copy is in. */
  const loadCopies = () =>
    sheets.loadCopies(sheet => session.emit('CSS.styleSheetChanged', { styleSheetId: sheets.idOf(sheet) }));

  /** Runs `apply` and records it for DOM.undo, `revert` taking it back. */
  function perform(apply: () => void, revert: () => void) {
    apply();
    history.record({
      undo: () => {
        revert();
        stylesChanged();
      },
      redo: () => {
        apply();
        stylesChanged();
      },
    });
  }

  /** Rules of fetched copies are shown, but editing them would not affect the page. */
  function assertEditable(sheet: CSSStyleSheet) {
    if (sheets.isCopy(sheet)) throw new CdpError('This style sheet comes from another origin and cannot be edited');
  }

  function ruleStyle(sheet: CSSStyleSheet, rule: StyleRule): CSSStyle {
    const line = sheets.ruleId(sheet, rule);
    return buildStyle(sheets.idOf(sheet), rule.style, line, selectorLabel(rule).length + 3);
  }

  function selectorList(sheet: CSSStyleSheet, rule: StyleRule): Protocol.CSS.SelectorList {
    // Like Chrome, nested declarations show their style rule's selectors, without selectors of their own.
    if (!(rule instanceof CSSStyleRule)) return { selectors: [], text: selectorLabel(rule) };
    const line = sheets.ruleId(sheet, rule);
    let column = 0;
    const parts = splitTopLevel(rule.selectorText, ',');
    const written = sourceSelectors(
      sheet,
      rule,
      parts.map(p => p.trim())
    );
    const selectors = parts.map((raw, i) => {
      const text = raw.trim();
      const start = column + raw.indexOf(text);
      column += raw.length + 1;
      return {
        text: written?.[i] ?? text,
        specificity: specificity(resolveSelector(text, rule, true)),
        range: { startLine: line, startColumn: start, endLine: line, endColumn: start + text.length },
      };
    });
    return { selectors, text: rule.selectorText };
  }

  /** A rule with the at-rules and style rules around it, in the fields Chrome reports them in. */
  function cssRule(sheet: CSSStyleSheet, rule: StyleRule, tree?: TreeScope): Protocol.CSS.CSSRule {
    const styleSheetId = sheets.idOf(sheet);
    const result: Protocol.CSS.CSSRule = {
      styleSheetId,
      selectorList: selectorList(sheet, rule),
      origin: sheets.origin(sheet),
      style: ruleStyle(sheet, rule),
    };
    if (tree) result.originTreeScopeNodeId = nodes.backendIdOf(tree);
    const ancestors = ancestorsOf(rule);
    const nestingSelectors: string[] = [];
    const media: Protocol.CSS.CSSMedia[] = [];
    const containerQueries: Protocol.CSS.CSSContainerQuery[] = [];
    const supports: Protocol.CSS.CSSSupports[] = [];
    const layers: Protocol.CSS.CSSLayer[] = [];
    const scopes: Protocol.CSS.CSSScope[] = [];
    const ruleTypes: Protocol.CSS.CSSRuleType[] = [];
    for (const a of ancestors) {
      const type = ruleType(a);
      if (type) ruleTypes.push(type);
      if (a instanceof CSSStyleRule) nestingSelectors.push(a.selectorText);
      else if (a instanceof CSSMediaRule)
        media.push({
          text: a.conditionText,
          source: 'mediaRule',
          sourceURL: sheet.href ?? location.href,
          styleSheetId,
          mediaList: mediaList(a.conditionText),
        });
      else if (a instanceof CSSSupportsRule)
        supports.push({ text: a.conditionText, active: CSS.supports(a.conditionText), styleSheetId });
      else if (a instanceof CSSContainerRule)
        containerQueries.push({
          text: a.containerQuery,
          styleSheetId,
          ...(a.containerName && { name: a.containerName }),
          ...queriedAxes(a.containerQuery),
          conditionText: a.conditionText,
        });
      // Chrome lists layers outermost first, unlike the other at-rules.
      else if (a instanceof CSSLayerBlockRule) layers.unshift({ text: a.name, styleSheetId });
      else if (a instanceof CSSScopeRule) scopes.push({ text: scopeText(a), styleSheetId });
    }
    if (nestingSelectors.length) result.nestingSelectors = nestingSelectors;
    // Like Chrome, these are sent even when empty.
    Object.assign(result, {
      media,
      containerQueries,
      supports,
      layers,
      scopes,
      ruleTypes,
      startingStyles: [],
      navigations: [],
    });
    return result;
  }

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

  /** Candidates by the tree their sheets apply to. */
  function candidates(): Map<TreeScope, Candidate[]> {
    const result = new Map<TreeScope, Candidate[]>();
    // Each tree has cascade layers of its own.
    const layerOrders = new Map<TreeScope, Map<string, number>>();
    const pending: { sheet: CSSStyleSheet; tree: TreeScope; entry: Entry }[] = [];
    for (const { sheet, tree } of sheets.scoped()) {
      if (sheet.disabled || !sheetApplies(sheet)) continue;
      let layerOrder = layerOrders.get(tree);
      if (!layerOrder) layerOrders.set(tree, (layerOrder = new Map()));
      for (const entry of sheets.entries(sheet, true, layerOrder)) pending.push({ sheet, tree, entry });
    }
    // Layers are ranked once all of them are declared: a later sheet can declare an order.
    pending.forEach(({ sheet, tree, entry: { rule, layer } }, order) => {
      const ancestors = ancestorsOf(rule);
      const parts = rule instanceof CSSStyleRule ? splitTopLevel(rule.selectorText, ',') : ['&'];
      const selectors = parts.map((s, index) => {
        const selector = s.trim();
        const resolved = resolveSelector(selector, rule);
        const split = splitPseudoElement(resolved);
        const spec = specificity(resolveSelector(selector, rule, true));
        const slotted = /::slotted\((.*)\)$/i.exec(resolved)?.[1];
        return {
          index,
          pseudo: slotted === undefined ? split.pseudo : 'slotted',
          host: forced.rewrite(split.host),
          spec,
          slotted: slotted === undefined ? null : forced.rewrite(slotted),
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
        containers: ancestors.filter(a => a instanceof CSSContainerRule),
        scope: ancestors.find(a => a instanceof CSSScopeRule) ?? null,
        selectors,
      });
    });
    return result;
  }

  /**
   * Cascade layer order: layers in order of declaration, and rules outside any layer (or
   * directly in a layer, rather than in its sub-layers) after them.
   */
  function compareLayers(x: number[], y: number[]): number {
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
  function scopeProximity(sheet: CSSStyleSheet, scope: CSSScopeRule, el: Element, test: (root: Element) => boolean) {
    const owner = sheet.ownerNode;
    // Without a prelude, the root is the parent of the <style>.
    const implicitRoot = owner instanceof Element ? owner.parentElement : document.documentElement;
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
   * The candidates of the request being answered: one request matches the element, its
   * pseudo-elements and its ancestors against the same rules, so they are collected once.
   */
  let requestCandidates: Map<TreeScope, Candidate[]> | null = null;

  /**
   * Rules matching `el`, or with `pseudo`, its pseudo-element, in cascade order (lowest
   * priority first). Selectors ending in a pseudo-element only match that pseudo-element.
   */
  function matchedRules(el: Element, pseudo: PseudoType | null = null): Protocol.CSS.RuleMatch[] {
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
    const byTree = requestCandidates ?? candidates();
    // Rules of a shadow tree reach outside it only through `:host` and `::slotted()`.
    const ownShadow = nodes.shadowRootOf(el);
    const elRoot = el.getRootNode();
    const groups: [Candidate[] | undefined, 'own' | 'host' | 'slotted', HTMLSlotElement | null, number][] = [
      [byTree.get(elRoot instanceof ShadowRoot ? elRoot : document), 'own', null, 0],
    ];
    // A slot can itself be assigned to a slot further in: `::slotted()` of each of those trees
    // matches, the trees further in losing to those closer to the element, like in Chrome.
    // Rules of inner trees lose to those of the element's own tree, whatever their layer or
    // specificity (the context of the cascade), and like in Chrome, `:host` ones lose to all.
    let depth = 1;
    for (let slot = el.assignedSlot; slot; slot = slot.assignedSlot) {
      const slotTree = slot.getRootNode();
      if (slotTree instanceof ShadowRoot) groups.push([byTree.get(slotTree), 'slotted', slot, -depth++]);
    }
    groups.push([ownShadow ? byTree.get(ownShadow) : undefined, 'host', null, -depth]);
    for (const [group, kind, slot, rank] of groups)
      for (const candidate of group ?? []) {
        const { sheet, tree, rule, order, layer, containers, scope, selectors } = candidate;
        let proximity = Infinity;
        const matched = selectors.filter(s => {
          try {
            if (kind === 'slotted')
              return !pseudo && s.slotted !== null && !!slot?.matches(s.host) && el.matches(s.slotted);
            if (s.pseudo !== pseudo) return false;
            if (kind === 'host') {
              const host = hostMatcher(s.host);
              return host !== null && host(el);
            }
            if (!scope) return el.matches(s.host);
            // `:scope` is the root: Element.matches for the root itself, querySelectorAll below it,
            // once the element matches the selector with any root.
            const anyRoot = s.host.replace(/:scope(?![\w-])/g, ':is(*)');
            if (!el.matches(anyRoot)) return false;
            const distance = scopeProximity(sheet, scope, el, root =>
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
          match: { rule: cssRule(sheet, rule, tree), matchingSelectors: matching },
          spec,
          order,
          layer,
          proximity,
          rank,
        });
      }
    // Context, then layers, then specificity, then scope proximity (nearer roots win), then order of
    // appearance. Inspector rules win over regular ones of equal specificity, as they come last.
    return matches
      .sort(
        (x, y) =>
          x.rank - y.rank ||
          compareLayers(x.layer, y.layer) ||
          compareSpecificity(x.spec, y.spec) ||
          (x.proximity === y.proximity ? 0 : x.proximity > y.proximity ? -1 : 1) ||
          x.order - y.order
      )
      .map(m => m.match);
  }

  function inlineStyle(el: Element): CSSStyle | undefined {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return undefined;
    // Like Chrome, declarations in the order of the style attribute, which the CSSOM does not keep.
    const attribute = el.getAttribute('style');
    if (attribute !== null) sources.set(el.style, { text: attribute, applied: el.style.cssText });
    return buildStyle(INLINE_PREFIX + nodes.backendIdOf(el), el.style, 0, 0);
  }

  const element = (nodeId: number) => resolveElement(ctx, { nodeId });

  /** An element or a pseudo-element, as its host and pseudo type. */
  const target = (nodeId: number): { el: Element; pseudo: PseudoType | null } => {
    const node = nodes.get(nodeId);
    if (node instanceof PseudoElement) return { el: node.host, pseudo: node.pseudoType };
    return { el: element(nodeId), pseudo: null };
  };

  function inheritedEntries(from: Element | null): Protocol.CSS.InheritedStyleEntry[] {
    const inherited: Protocol.CSS.InheritedStyleEntry[] = [];
    // Like Chrome, along the flat tree: a slotted element inherits from its slot.
    for (let parent = from; parent; parent = parent.assignedSlot ?? parentOf(parent)) {
      const entry: Protocol.CSS.InheritedStyleEntry = { matchedCSSRules: matchedRules(parent) };
      const style = inlineStyle(parent);
      if (style) entry.inlineStyle = style;
      inherited.push(entry);
    }
    return inherited;
  }

  function applyEdit(edit: Protocol.CSS.StyleDeclarationEdit): CSSStyle {
    if (edit.styleSheetId.startsWith(INLINE_PREFIX)) {
      const el = ctx.nodes.getByBackendId(Number(edit.styleSheetId.slice(INLINE_PREFIX.length)));
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) throw new CdpError('Node not found');
      const old = el.getAttribute('style');
      const oldSource = sources.get(el.style);
      perform(
        () => setStyleText(el.style, edit.text, () => el.setAttribute('style', edit.text)),
        () => {
          if (old === null) el.removeAttribute('style');
          else el.setAttribute('style', old);
          if (oldSource) sources.set(el.style, oldSource);
          else sources.delete(el.style);
        }
      );
      return buildStyle(edit.styleSheetId, el.style, 0, 0);
    }
    const sheet = sheets.get(edit.styleSheetId);
    assertEditable(sheet);
    const rule = sheets.findRule(sheet, edit.range.startLine);
    const old = rule.style.cssText;
    const oldSource = sources.get(rule.style);
    perform(
      () => setStyleText(rule.style, edit.text, () => (rule.style.cssText = edit.text)),
      () => {
        rule.style.cssText = old;
        if (oldSource) sources.set(rule.style, oldSource);
        else sources.delete(rule.style);
      }
    );
    return ruleStyle(sheet, rule);
  }

  async function matchedStyles(
    el: Element,
    pseudo: PseudoType | null
  ): Promise<Protocol.CSS.GetMatchedStylesForNodeResponse> {
    // Adopted sheets change unseen: catch up before answering.
    if (enabled) await syncSheets();
    else await loadCopies();
    requestCandidates = candidates();
    try {
      // For a pseudo-element, its host is the first element it inherits from.
      if (pseudo) {
        return {
          matchedCSSRules: matchedRules(el, pseudo),
          pseudoElements: [],
          inherited: inheritedEntries(el),
          cssKeyframesRules: [],
        };
      }
      const pseudoElements = PSEUDO_TYPES.map(type => ({ pseudoType: type, matches: matchedRules(el, type) })).filter(
        p => p.matches.length
      );
      const result: Protocol.CSS.GetMatchedStylesForNodeResponse = {
        matchedCSSRules: matchedRules(el),
        pseudoElements,
        inherited: inheritedEntries(el.assignedSlot ?? parentOf(el)),
        cssKeyframesRules: [],
      };
      const style = inlineStyle(el);
      if (style) result.inlineStyle = style;
      return result;
    } finally {
      requestCandidates = null;
    }
  }

  session.register('CSS', {
    enable() {
      if (enabled) return;
      enabled = true;
      known = new Set();
      const ownsSheet = (n: Node | null) =>
        (n instanceof HTMLStyleElement || n instanceof HTMLLinkElement) && !isOwn(n);
      observer = new MutationObserver(records => {
        // Adding or removing a <style> or <link>, changing the text of a <style> or the href
        // of a <link> all replace style sheets.
        const touchesSheets = records.some(
          r =>
            ownsSheet(r.target) ||
            ownsSheet(r.target.parentNode) ||
            [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].some(
              // A shadow host brings or takes away the sheets of its shadow tree.
              n => ownsSheet(n) || (n instanceof Element && !isOwn(n) && !!nodes.shadowRootOf(n))
            )
        );
        // Shadow hosts may come or go with any element: look for shadow roots again when needed.
        if (
          records.some(r =>
            [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].some(n => n instanceof Element)
          )
        )
          shadowRootCache = null;
        quietly(() => forced.removed(records.flatMap(r => Array.from(r.removedNodes))));
        if (touchesSheets) syncSheets();
      });
      observed = new WeakSet();
      shadowRootCache = null;
      stopShadowRoots ??= ctx.probe.onShadowRoot(() => (shadowRootCache = null));
      observer.observe(document, OBSERVED);
      syncSheets();
      // A <link> stylesheet (or a <style> with @import) becomes available once loaded.
      document.addEventListener('load', onLoad, true);
      // Adopted style sheets change without a DOM mutation.
      stopAdopted = watchAdopted(
        () => void syncSheets(),
        () => [document, ...shadowRoots()]
      );
    },

    disable() {
      enabled = false;
      quietly(() => forced.clear());
      observer?.disconnect();
      observer = null;
      shadowRootCache = null;
      stopShadowRoots?.();
      stopShadowRoots = null;
      document.removeEventListener('load', onLoad, true);
      stopAdopted?.();
      stopAdopted = null;
    },

    async getMatchedStylesForNode(
      params: Protocol.CSS.GetMatchedStylesForNodeRequest
    ): Promise<Protocol.CSS.GetMatchedStylesForNodeResponse> {
      const { el, pseudo } = target(params.nodeId);
      return sheets.batch(() => matchedStyles(el, pseudo));
    },

    getInlineStylesForNode(
      params: Protocol.CSS.GetInlineStylesForNodeRequest
    ): Protocol.CSS.GetInlineStylesForNodeResponse {
      const { el, pseudo } = target(params.nodeId);
      const style = pseudo ? undefined : inlineStyle(el);
      return style ? { inlineStyle: style } : {};
    },

    getComputedStyleForNode(params: Protocol.CSS.GetComputedStyleForNodeRequest): ComputedStyleResponse {
      const { el, pseudo } = target(params.nodeId);
      const style = getComputedStyle(el, pseudo ? `::${pseudo}` : null);
      return {
        computedStyle: Array.from(style, name => ({ name, value: style.getPropertyValue(name) })),
        extraFields: { isAppearanceBase: false, isTableSetVisuallyTable: false },
      };
    },

    getBackgroundColors(params: Protocol.CSS.GetBackgroundColorsRequest): Protocol.CSS.GetBackgroundColorsResponse {
      const { el, pseudo } = target(params.nodeId);
      const style = getComputedStyle(el, pseudo ? `::${pseudo}` : null);
      // Chrome reports no background for a pseudo-element.
      const backgroundColors = pseudo ? null : backgroundsBehind(el, style);
      return {
        ...(backgroundColors && { backgroundColors }),
        computedFontSize: style.fontSize,
        computedFontWeight: style.fontWeight,
      };
    },

    getStyleSheetText: (params: Protocol.CSS.GetStyleSheetTextRequest): Protocol.CSS.GetStyleSheetTextResponse => ({
      text: sheets.text(sheets.get(params.styleSheetId)),
    }),

    setStyleSheetText(params: Protocol.CSS.SetStyleSheetTextRequest): Protocol.CSS.SetStyleSheetTextResponse {
      const id = params.styleSheetId;
      const sheet = sheets.get(id);
      const owner = sheet.ownerNode;
      assertEditable(sheet);
      if (isConstructed(sheet)) {
        const old = sheets.text(sheet);
        perform(
          () => sheet.replaceSync(params.text),
          () => sheet.replaceSync(old)
        );
        stylesChanged();
        return {};
      }
      if (!(owner instanceof HTMLStyleElement)) throw new CdpError('Style sheet is not editable');
      const setText = (text: string) => {
        const current = sheets.get(id);
        owner.textContent = text;
        // The <style> now has a new sheet: it takes the place of the old one.
        if (owner.sheet && owner.sheet !== current) {
          sheets.rebind(current, owner.sheet);
          if (known.delete(current)) known.add(owner.sheet);
        }
      };
      const old = owner.textContent;
      perform(
        () => setText(params.text),
        () => setText(old)
      );
      stylesChanged();
      return {};
    },

    setStyleTexts(params: Protocol.CSS.SetStyleTextsRequest): Protocol.CSS.SetStyleTextsResponse {
      const styles = params.edits.map(applyEdit);
      stylesChanged();
      return { styles };
    },

    setRuleSelector(params: Protocol.CSS.SetRuleSelectorRequest): Protocol.CSS.SetRuleSelectorResponse {
      const sheet = sheets.get(params.styleSheetId);
      assertEditable(sheet);
      const rule = sheets.findRule(sheet, params.range.startLine);
      if (!(rule instanceof CSSStyleRule)) throw new CdpError('No rule at given range');
      const old = rule.selectorText;
      perform(
        () => (rule.selectorText = params.selector),
        () => (rule.selectorText = old)
      );
      stylesChanged();
      return { selectorList: selectorList(sheet, rule) };
    },

    createStyleSheet(): Protocol.CSS.CreateStyleSheetResponse {
      if (!sheets.inspectorSheet?.ownerNode?.isConnected) {
        const style = document.createElement('style');
        style.setAttribute(OWN_ATTRIBUTE, 'inspector-stylesheet');
        markOwn(style);
        document.head.appendChild(style);
        // A connected <style> always has a sheet.
        if (!style.sheet) throw new CdpError('Could not create the inspector style sheet');
        sheets.inspectorSheet = style.sheet;
        known.add(style.sheet);
        session.emit('CSS.styleSheetAdded', { header: header(style.sheet) });
      }
      return { styleSheetId: sheets.idOf(sheets.inspectorSheet) };
    },

    addRule(params: Protocol.CSS.AddRuleRequest): Protocol.CSS.AddRuleResponse {
      const sheet = sheets.get(params.styleSheetId);
      assertEditable(sheet);
      // Before the rule at `location`, or after it when the location is inside it (rules are one
      // per line). Like Chrome, a location in an @media (or another group rule) puts the rule in it.
      const { startLine, startColumn } = params.location;
      const entries = sheets.entries(sheet).map(e => e.rule);
      const onLine = entries.find(r => sheets.ruleId(sheet, r) === startLine);
      let parent: CSSStyleSheet | CSSGroupingRule = sheet;
      let at = -1;
      if (onLine) {
        // The group rule (not a style rule: addRule does not nest) the rule is in.
        let child: CSSRule = onLine;
        for (let p = child.parentRule; p; child = p, p = p.parentRule)
          if (p instanceof CSSGroupingRule && !(p instanceof CSSStyleRule)) {
            parent = p;
            break;
          }
        at = Array.from(parent.cssRules).indexOf(child) + (startColumn === 0 ? 0 : 1);
      } else {
        // Before the top-level rule of the next style rule.
        let next: CSSRule | null | undefined = entries.find(r => sheets.ruleId(sheet, r) > startLine);
        while (next?.parentRule) next = next.parentRule;
        at = next ? Array.from(sheet.cssRules).indexOf(next) : -1;
      }
      const target = parent;
      const index = target.insertRule(params.ruleText, at < 0 ? target.cssRules.length : at);
      const rule = target.cssRules[index];
      if (!(rule instanceof CSSStyleRule)) {
        target.deleteRule(index);
        throw new CdpError('Failed to parse rule text');
      }
      const text = rule.cssText;
      // Redo inserts a new rule object, which the next undo removes.
      let added: CSSRule = rule;
      history.record({
        undo: () => {
          const at = Array.from(target.cssRules).indexOf(added);
          if (at >= 0) target.deleteRule(at);
          stylesChanged();
        },
        redo: () => {
          added = target.cssRules[target.insertRule(text, Math.min(index, target.cssRules.length))] ?? added;
          stylesChanged();
        },
      });
      stylesChanged();
      return { rule: cssRule(sheet, rule) };
    },

    collectClassNames(params: Protocol.CSS.CollectClassNamesRequest): Protocol.CSS.CollectClassNamesResponse {
      const names = new Set<string>();
      for (const { rule } of sheets.entries(sheets.get(params.styleSheetId))) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const [, name] of rule.selectorText.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) if (name) names.add(name);
      }
      return { classNames: Array.from(names) };
    },

    getPlatformFontsForNode: (): Protocol.CSS.GetPlatformFontsForNodeResponse => ({ fonts: [] }),
    getMediaQueries: (): Protocol.CSS.GetMediaQueriesResponse => ({ medias: [] }),
    forcePseudoState(params: Protocol.CSS.ForcePseudoStateRequest) {
      quietly(() => forced.set(element(params.nodeId), params.forcedPseudoClasses));
      ctx.refreshPseudoElements?.();
    },
    trackComputedStyleUpdates: () => {},
    takeComputedStyleUpdates: (): Protocol.CSS.TakeComputedStyleUpdatesResponse => ({ nodeIds: [] }),
    setEffectivePropertyValueForNode(params: Protocol.CSS.SetEffectivePropertyValueForNodeRequest) {
      const el = element(params.nodeId);
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) throw new CdpError('Element has no inline style');
      const old = el.getAttribute('style');
      perform(
        () => el.style.setProperty(params.propertyName, params.value),
        () => (old === null ? el.removeAttribute('style') : el.setAttribute('style', old))
      );
    },
  });
}
