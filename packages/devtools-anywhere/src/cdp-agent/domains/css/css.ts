import type { Protocol } from 'devtools-protocol';
import { type Context } from '../../core/context';
import { OWN_ATTRIBUTE, PSEUDO_TYPES, isOwn, markOwn, PseudoElement, type PseudoType } from '../../core/nodes';
import { parentOf } from '../../core/container-query';
import { CdpError } from '../../core/session';
import { resolveElement } from '../dom/dom';
import { historyOf } from '../../core/history';
import { quietly, watchAdopted } from '../../core/adopted';
import { ForcedPseudoClasses } from './forced-pseudo';
import { backgroundsBehind } from './color';
import { Cascade } from './cascade';
import { RuleView } from './rule-view';
import { SheetRegistry, isConstructed } from './sheet-registry';
import { type CSSStyle, type ComputedStyleResponse, INLINE_PREFIX, buildStyle, setStyleText, sources } from './style';

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
  const rules = new RuleView(sheets, nodes);
  const cascade = new Cascade(sheets, forced, nodes, rules);

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

  const element = (nodeId: number) => resolveElement(ctx, { nodeId });

  /** An element or a pseudo-element, as its host and pseudo type. */
  const target = (nodeId: number): { el: Element; pseudo: PseudoType | null } => {
    const node = nodes.get(nodeId);
    if (node instanceof PseudoElement) return { el: node.host, pseudo: node.pseudoType };
    return { el: element(nodeId), pseudo: null };
  };

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
    return rules.ruleStyle(sheet, rule);
  }

  async function matchedStyles(
    el: Element,
    pseudo: PseudoType | null
  ): Promise<Protocol.CSS.GetMatchedStylesForNodeResponse> {
    // Adopted sheets change unseen: catch up before answering.
    if (enabled) await syncSheets();
    else await loadCopies();
    return cascade.forRequest(() => {
      // For a pseudo-element, its host is the first element it inherits from.
      if (pseudo) {
        return {
          matchedCSSRules: cascade.matchedRules(el, pseudo),
          pseudoElements: [],
          inherited: cascade.inheritedEntries(el),
          cssKeyframesRules: [],
        };
      }
      const pseudoElements = PSEUDO_TYPES.map(type => ({
        pseudoType: type,
        matches: cascade.matchedRules(el, type),
      })).filter(p => p.matches.length);
      const result: Protocol.CSS.GetMatchedStylesForNodeResponse = {
        matchedCSSRules: cascade.matchedRules(el),
        pseudoElements,
        inherited: cascade.inheritedEntries(el.assignedSlot ?? parentOf(el)),
        cssKeyframesRules: [],
      };
      const style = cascade.inlineStyle(el);
      if (style) result.inlineStyle = style;
      return result;
    });
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
      const style = pseudo ? undefined : cascade.inlineStyle(el);
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
      return { selectorList: rules.selectorList(sheet, rule) };
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
      return { rule: rules.cssRule(sheet, rule) };
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
