import type { Protocol } from 'devtools-protocol';
import {
  documentOf,
  isCssom,
  isDocument,
  isElement,
  isHtml,
  isHtmlElement,
  isNode,
  isShadowRoot,
  isSvgElement,
  realmOf,
} from '../../core/realm';
import { type Context, type MatchingStyle } from '../../core/context';
import { OWN_ATTRIBUTE, PSEUDO_TYPES, isOwn, markOwn, PseudoElement, type PseudoType } from '../../core/nodes/nodes';
import { parentOf } from '../../core/style/container-query';
import { CdpError } from '../../core/session';
import { mergedFrames } from '../../core/frames/merged-frames';
import { resolveElement } from '../dom/dom';
import { historyOf, type Action } from '../../core/nodes/history';
import { shownAttribute } from '../../core/nodes/written-attributes';
import { shownCssText, shownMedia } from '../emulation/rewrite';
import { adoptedOf, isHiddenSheet, quietly, watchAdopted, watchTrees } from '../../core/nodes/adopted';
import { environmentVariables } from './env-variables';
import { ForcedPseudoClasses } from './matching/forced-pseudo';
import { backgroundsBehind } from './color';
import { Cascade } from './matching/cascade';
import { ComputedStyleUpdates } from './computed/computed-updates';
import { UserAgentStyles, userAgentSheetUrl } from './user-agent/user-agent';
import { RuleView } from './matching/rule-view';
import {
  OUT_OF_BOUNDS,
  RANGE_MISMATCH,
  STYLE_MISMATCH,
  SheetRegistry,
  assertOrdered,
  isConstructed,
} from './sheets/sheet-registry';
import { offsetsOf } from './sheets/text/ranges';
import { stopWarming, warmUp } from './sheets/text/warm';
import { ROOT } from './sheets/parse/css-outline';
import { outline } from './sheets/parse/css-outline-wasm';
import {
  editedBy,
  ownCall,
  ownEdit,
  ownSet,
  ownSheet,
  ownStyle,
  settle,
  useCssNatives,
  watchCssom,
  watchRealms,
  watching,
} from './sheets/watch/cssom-watch';
import {
  type CSSStyle,
  type ComputedStyleResponse,
  INLINE_PREFIX,
  INVALID_STYLE,
  buildStyle,
  normalizePseudo,
  setStyleText,
  styleTextFits,
  sources,
} from './style';

/** What the CSS domain watches in the document and shadow roots for style sheet changes. */
const OBSERVED: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributeFilter: ['href', 'rel', 'disabled', 'media', 'type'],
};

/**
 * Commands for a merged sandboxed iframe's nodes or style sheets go to its agent
 * (core/frames/merged-frames.ts); its style sheets come in its own CSS.styleSheetAdded, of its frame id.
 * The rest fan out: what they answer without an id (media queries) the iframe's agent answers
 * empty, as the page's does, so the page's answer is the merged one. Computed style updates of
 * properties are the page's only: a take waits for a change, which the iframe's would hold up.
 */
const NODE_ID = ['nodeId'];
const SHEET_ID = ['styleSheetId'];
mergedFrames.registerRoutes('CSS', {
  routeBy: {
    'CSS.getMatchedStylesForNode': NODE_ID,
    'CSS.getInlineStylesForNode': NODE_ID,
    'CSS.getComputedStyleForNode': NODE_ID,
    'CSS.getBackgroundColors': NODE_ID,
    'CSS.getPlatformFontsForNode': NODE_ID,
    'CSS.forcePseudoState': NODE_ID,
    'CSS.setEffectivePropertyValueForNode': NODE_ID,
    'CSS.trackComputedStyleUpdatesForNode': NODE_ID,
    'CSS.getStyleSheetText': SHEET_ID,
    'CSS.setStyleSheetText': SHEET_ID,
    'CSS.collectClassNames': SHEET_ID,
    'CSS.setRuleSelector': SHEET_ID,
    'CSS.setMediaText': SHEET_ID,
    'CSS.setSupportsText': SHEET_ID,
    'CSS.setContainerQueryText': SHEET_ID,
    'CSS.setContainerQueryConditionText': SHEET_ID,
    'CSS.setScopeText': SHEET_ID,
    'CSS.setKeyframeKey': SHEET_ID,
    'CSS.addRule': SHEET_ID,
    'CSS.setStyleTexts': ['edits.0.styleSheetId'],
    'CSS.createStyleSheet': ['frameId'],
  },
  fanOut: ['CSS.enable', 'CSS.disable', 'CSS.getMediaQueries'],
});

export function registerCss(ctx: Context) {
  const { session, nodes } = ctx;
  const history = historyOf(ctx);

  /** The documents of the frames, the top one first. */
  const documents = () => Array.from(ctx.frames, f => f.document);

  /**
   * Shadow roots in the frames' documents (closed ones too, when the probe recorded them), in tree
   * order, from the shared tracker, which keeps the list while the CSS domain is enabled.
   */
  let stopShadowRoots: (() => void) | null = null;
  function shadowRoots(): ShadowRoot[] {
    const roots = ctx.shadowRoots.roots();
    // The document observer does not see into shadow trees.
    if (observer)
      for (const root of roots)
        if (!observed.has(root)) {
          observed.add(root);
          observer.observe(root, OBSERVED);
        }
    return roots;
  }

  useCssNatives(ctx.probe.css);
  const sheets = new SheetRegistry(ctx.probe.fetch, shadowRoots, ctx.frames);
  const forced = new ForcedPseudoClasses(
    () => sheets.trees(),
    sheet => sheets.rulesOf(sheet)
  );
  // Our own sheets (the companions of the forced states, the injected ones) are not the page's.
  sheets.isOwnSheet = sheet => forced.owns(sheet) || isHiddenSheet(sheet);
  const rules = new RuleView(sheets, nodes);
  // DevTools' own request, not one of the page's.
  const uaUrl = userAgentSheetUrl;
  if (uaUrl) ctx.probe.ownUrls.add(uaUrl);
  const userAgent = uaUrl
    ? new UserAgentStyles(async () => {
        const response = await ctx.probe.fetch(uaUrl);
        // Not deployed (it may be left out, being the only LGPL file): no user agent rules, and no
        // request again. A failed request is tried again with the next one.
        if (response.status === 404) return '';
        if (!response.ok) throw new Error(`${uaUrl}: ${response.status}`);
        return response.text();
      })
    : null;
  const cascade = new Cascade(sheets, forced, nodes, rules, userAgent);
  // Captures the classes of view transitions from now on (other frames' when first matched).
  for (const doc of documents()) cascade.viewTransitions.hook(doc);
  ctx.matchingStyles = (el, pseudo) => {
    // As Chrome reads them, with getPropertyValue: a longhand of a shorthand with var() is empty.
    const declares = (decl: CSSStyleDeclaration) => (name: string) =>
      decl.getPropertyValue(name) === ''
        ? null
        : decl.getPropertyPriority(name) === 'important'
          ? 'important'
          : 'normal';
    const styles: MatchingStyle[] = [];
    // Like Chrome's element->style(), there even without a style attribute.
    const inline = (el as Partial<ElementCSSInlineStyle>).style;
    if (!pseudo && inline) styles.push({ rule: null, declares: declares(inline) });
    for (const { rule } of cascade.matchedRules(el, pseudo && normalizePseudo(pseudo)).reverse()) {
      if (rule.origin === 'user-agent' || !rule.styleSheetId || !rule.style.range) continue;
      const sheet = sheets.get(rule.styleSheetId);
      if (!sheet.ownerNode) continue;
      const decl = ownStyle(sheets.findRule(sheet, rule.style.range, 'style'));
      // Nested declarations, which have no selectors of their own, are not style rules.
      const own = rule.selectorList.selectors.length ? `${rule.styleSheetId}\n${rule.selectorList.text}` : null;
      styles.push({ rule: own, declares: declares(decl) });
    }
    return styles;
  };
  const updates = new ComputedStyleUpdates(
    nodes,
    () => [...documents(), ...shadowRoots()],
    nodeId => session.emit('CSS.computedStyleUpdated', { nodeId })
  );

  // The DOM does not tell which <style> the parser made: those in the document before the
  // parser is done are taken as its own, those added later as a script's. A script that adds
  // one while the page loads is taken for the parser.
  // The same goes for the document of each iframe, from when the agent first sees it.
  const parsed = new WeakSet<HTMLStyleElement>();
  const parsedIn = new WeakSet<Document>();
  const collectParsed = (doc: Document) => {
    if (parsedIn.has(doc)) return;
    parsedIn.add(doc);
    const collect = () => doc.querySelectorAll('style').forEach(s => parsed.add(s));
    collect();
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', collect, { once: true });
  };
  documents().forEach(collectParsed);
  sheets.fromParser = style => parsed.has(style);

  /** After the page's styles changed: keep forced states and pseudo-elements in sync. */
  function stylesChanged() {
    // The companion sheets it adopts are ours, not a change of the page's.
    if (forced.isActive) quietly(() => forced.rebuild());
    ctx.refreshPseudoElements?.();
    // Rule edits make no DOM mutation for the tracked computed styles to be compared after.
    updates.check();
  }
  let enabled = false;
  let known = new Set<CSSStyleSheet>();
  /** Sheets changed while adopted but not reported yet. */
  const changedUnseen = new Set<CSSStyleSheet>();
  const adopted = (sheet: CSSStyleSheet) => [...documents(), ...shadowRoots()].some(t => adoptedOf(t).includes(sheet));
  let observer: MutationObserver | null = null;
  let stopAdopted: (() => void) | null = null;
  let stopCssom: (() => void) | null = null;
  let stopRevised: (() => void) | null = null;
  /** Checks and pairs the texts of this session's sheets while the page is idle (warm.ts). */
  const warmer = {
    warm: (sheet: CSSStyleSheet) => void (known.has(sheet) && sheets.sourceOf(sheet)),
    cold: (sheet: CSSStyleSheet) => (known.has(sheet) ? sheets.texts.coldLength(sheet) : 0),
  };

  function header(sheet: CSSStyleSheet) {
    const h = sheets.header(sheet);
    if (sheet.ownerNode && !sheets.isInspector(sheet)) h.ownerNode = nodes.backendIdOf(sheet.ownerNode);
    return h;
  }

  /** Shadow roots the observer watches, as it does not see into them from the document. */
  let observed = new WeakSet<ShadowRoot>();

  /** Reports added and removed sheets since the last call. */
  function syncSheets() {
    return quietly(reportSheets);
  }

  function reportSheets() {
    // What the page wrote through the styles it took counts in the headers (isMutable): settled
    // once for the batch (header() settles too, a no-op within the same microtask).
    settle();
    const scoped = sheets.scoped();
    const current = new Set(scoped.map(s => s.sheet));
    const added: CSSStyleSheet[] = [];
    for (const sheet of current)
      if (!known.has(sheet)) {
        session.emit('CSS.styleSheetAdded', { header: header(sheet) });
        added.push(sheet);
      }
    for (const sheet of known)
      if (!current.has(sheet)) {
        session.emit('CSS.styleSheetRemoved', { styleSheetId: sheets.idOf(sheet) });
        sheets.forget(sheet);
      }
    known = current;
    for (const sheet of changedUnseen)
      if (current.has(sheet)) session.emit('CSS.styleSheetChanged', { styleSheetId: sheets.idOf(sheet) });
    changedUnseen.clear();
    // Their texts were taken for their headers unchecked: checked and paired while idle.
    if (added.length) warmUp(warmer, added);
    // Every session's observer reports the same change: the shared companions are rebuilt once.
    if (forced.isActive) forced.schedule();
    else forced.reattach();
    return loadCopies();
  }

  /** `load` reaches the document for every image and script too: only style elements matter. */
  const onLoad = (event: Event) => {
    const target = event.target;
    if (isNode(target) && (isHtml(target, 'link') || isHtml(target, 'style'))) void syncSheets();
  };

  /** The frames' documents the observer and the load listener watch. */
  let watched = new Set<Document>();
  let stopFrames: (() => void) | null = null;

  /** Watches the documents of frames not watched yet for style sheet changes. */
  function watchDocuments() {
    const current = new Set(documents());
    // Those of removed iframes and those navigated away from are let go.
    for (const doc of watched) {
      if (current.has(doc)) continue;
      doc.removeEventListener('load', onLoad, true);
      watched.delete(doc);
    }
    for (const doc of current) {
      if (watched.has(doc)) continue;
      watched.add(doc);
      collectParsed(doc);
      observer?.observe(doc, OBSERVED);
      // A <link> stylesheet (or a <style> with @import) becomes available once loaded.
      doc.addEventListener('load', onLoad, true);
    }
    // Adopted style sheets change without a DOM mutation, in the iframes' realms too.
    watchTrees(documents());
    watchRealms(documents());
  }

  /**
   * Like Chrome, an iframe's style sheets are added when it is attached or loads another
   * document, and removed with the document it leaves.
   */
  function framesChanged() {
    watchDocuments();
    void syncSheets();
  }

  /**
   * Loads copies of cross-origin sheets; the client re-reads a sheet once its copy is in, if CSS
   * is still enabled (the fetch, its own or another session's, may end after CSS.disable).
   */
  const copyLoaded = (sheet: CSSStyleSheet) => {
    if (enabled && known.has(sheet)) session.emit('CSS.styleSheetChanged', { styleSheetId: sheets.idOf(sheet) });
  };
  const loadCopies = () => sheets.loadCopies(copyLoaded);

  const element = (nodeId: number) => resolveElement(ctx, { nodeId });

  /** An element or a pseudo-element, as its host and pseudo type. */
  const target = (nodeId: number): { el: Element; pseudo: PseudoType | null } => {
    const node = nodes.get(nodeId);
    if (node instanceof PseudoElement) return { el: node.host, pseudo: node.pseudoType };
    return { el: element(nodeId), pseudo: null };
  };

  /** The edits of a setStyleTexts so far, recorded once all are applied; null outside of one. */
  let batch: { revert: () => void; action: Action }[] | null = null;

  /** Runs `apply` and records it for DOM.undo, `revert` taking it back. */
  function perform(apply: () => void, revert: () => void) {
    apply();
    const action: Action = {
      undo: () => {
        revert();
        stylesChanged();
      },
      redo: () => {
        apply();
        stylesChanged();
      },
    };
    if (batch) batch.push({ revert, action });
    else history.record(action);
  }

  /** Rules of fetched copies are shown, but editing them would not affect the page. */
  function assertEditable(sheet: CSSStyleSheet) {
    if (sheets.isCopy(sheet)) throw new CdpError('This style sheet comes from another origin and cannot be edited');
  }

  function applyEdit(edit: Protocol.CSS.StyleDeclarationEdit): CSSStyle {
    if (edit.styleSheetId.startsWith(INLINE_PREFIX)) {
      const el = ctx.nodes.getByBackendId(Number(edit.styleSheetId.slice(INLINE_PREFIX.length)));
      if (!isNode(el) || !(isHtmlElement(el) || isSvgElement(el))) throw new CdpError('Node not found');
      // As the page wrote it: an undo gives the page's text back, not the one the emulation rewrote.
      const old = shownAttribute(el, 'style', el.getAttribute('style'));
      const oldSource = sources.get(el.style);
      if (!styleTextFits(edit.text)) throw new CdpError(INVALID_STYLE); // As Chrome, as for a rule's.
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
    const rule = sheets.findRule(sheet, edit.range, 'style');
    if (!styleTextFits(edit.text)) throw new CdpError(INVALID_STYLE);
    const style = ownStyle(rule);
    const old = shownCssText(style);
    const oldSource = sources.get(style);
    editSheet(
      sheet,
      splice(sheet, edit.range, edit.text),
      () => setStyleText(style, edit.text, () => ownSet(style, 'cssText', edit.text)),
      () => {
        ownSet(style, 'cssText', old);
        if (oldSource) sources.set(style, oldSource);
        else sources.delete(style);
      },
      edit.range
    );
    return rules.ruleStyle(sheet, rule);
  }

  /** The text of the sheet with `range` replaced by `insert`, as written; null without one. */
  const splice =
    (sheet: CSSStyleSheet, range: Protocol.CSS.SourceRange, insert: string) =>
    (text: string | null): string | null => {
      const source = sheets.sourceOf(sheet);
      const offsets = source && offsetsOf(source, range);
      return text !== null && offsets ? text.slice(0, offsets[0]) + insert + text.slice(offsets[1]) : null;
    };

  /**
   * Edits a sheet through the CSSOM with `apply` (`revert` undoes it), and its text the same way:
   * `next` gives the new one from the old, null when the text is not known. The edit is the
   * CSS domain's own: no CSS.styleSheetChanged for it. `recorded` tells whether `apply` or `revert`
   * recorded the text it left itself, with its rules paired.
   */
  function editSheet(
    sheet: CSSStyleSheet,
    next: (text: string | null) => string | null,
    apply: () => void,
    revert: () => void,
    span?: Protocol.CSS.SourceRange,
    recorded?: () => boolean
  ) {
    const source = sheets.sourceOf(sheet);
    const before = source?.text ?? null;
    const after = next(before);
    // A change of a part of the text: only the rule around it is outlined again.
    const offsets = source && span && offsetsOf(source, span);
    const record = (text: string | null) =>
      text === null ? sheets.texts.invalidate(sheet) : sheets.texts.set(sheet, text);
    // The generation of the text this edit left (-1: not made yet): undo and redo put back theirs
    // only if no one (a session, the page) changed it since; the text is unknown otherwise, and
    // stays so for later ones (-2).
    let left = -1;
    // Told before the edit, which may record its text itself (`recorded`).
    const fresh = () => sheets.texts.generation(sheet) === left;
    const restore = (text: string | null, unchanged: boolean) => {
      const known = unchanged ? text : null;
      if (known === null || !recorded?.()) record(known);
      left = known === null ? -2 : sheets.texts.generation(sheet);
      editedBy(sheets, sheet, known ?? undefined);
    };
    perform(
      () => {
        const unchanged = fresh();
        ownEdit(apply);
        if (left !== -1) return restore(after, unchanged);
        if (offsets && before !== null && after !== null)
          sheets.texts.splice(
            sheet,
            offsets[0],
            offsets[1],
            after.slice(offsets[0], after.length - (before.length - offsets[1]))
          );
        else if (after === null || !recorded?.()) record(after);
        left = sheets.texts.generation(sheet);
        editedBy(sheets, sheet, after ?? undefined);
      },
      () => {
        const unchanged = fresh();
        ownEdit(revert);
        restore(before, unchanged);
      }
    );
  }

  /**
   * The rule `is` picks whose prelude (condition, key) is at `range`: only the text the sheet was
   * written in has ranges for them.
   */
  function atPrelude(sheet: CSSStyleSheet, range: Protocol.CSS.SourceRange, is: (r: CSSRule) => boolean): CSSRule {
    assertOrdered(range);
    const source = sheets.sourceOf(sheet);
    const offsets = source && offsetsOf(source, range);
    if (source && !offsets) throw new CdpError(OUT_OF_BOUNDS);
    if (source && offsets)
      for (const [r, node] of source.nodes)
        if (is(r) && source.outline.preludeStart(node) === offsets[0] && source.outline.preludeEnd(node) === offsets[1])
          return r;
    throw new CdpError(RANGE_MISMATCH);
  }

  /**
   * Writes a group rule's condition as given. Its CSSOM has no setter for it (@supports,
   * @container, @scope): the rule is replaced by one parsed from its text with the new condition.
   */
  function setPrelude(
    sheet: CSSStyleSheet,
    range: Protocol.CSS.SourceRange,
    text: string,
    is: (r: CSSRule) => boolean
  ): CSSRule {
    assertEditable(sheet);
    let current = atPrelude(sheet, range, is);
    const source = sheets.sourceOf(sheet);
    const node = source?.nodes.get(current);
    const parent = current.parentRule ?? current.parentStyleSheet;
    if (!source || node === undefined || !(isCssom(parent, 'CSSGroupingRule') || isCssom(parent, 'CSSStyleSheet')))
      throw new CdpError(RANGE_MISMATCH);
    const o = source.outline;
    const before = source.text.slice(o.start(node), o.end(node));
    const after =
      source.text.slice(o.start(node), o.preludeStart(node)) +
      text +
      source.text.slice(o.preludeEnd(node), o.end(node));
    // A condition that leaves the rule unparsable is refused before the rule is taken out, as
    // Chrome leaves it.
    try {
      ownCall(ownSheet(), 'insertRule', after, 0);
    } catch {
      throw new CdpError('SyntaxError Rule text is not valid.');
    }
    const swap = (ruleText: string) => {
      const i = Array.from(parent.cssRules).indexOf(current);
      ownCall(parent, 'deleteRule', i);
      ownCall(parent, 'insertRule', ruleText, i);
      current = parent.cssRules[i] ?? current;
    };
    // The rule objects change: the text is paired again whole.
    editSheet(
      sheet,
      splice(sheet, range, text),
      () => swap(after),
      () => swap(before)
    );
    stylesChanged();
    return current;
  }

  /**
   * The @keyframes of the element's animations, as Chrome's FindKeyframesRule: of the element's
   * own shadow tree, then of its tree, then of its document, the last of each name in effect (not
   * in a disabled sheet, nor under a media or condition that does not apply), in their order.
   */
  function keyframesOf(el: Element, pseudo: PseudoType | null): Protocol.CSS.CSSKeyframesRule[] {
    const value = realmOf(el).getComputedStyle(el, pseudo ? `::${pseudo}` : null).animationName;
    const names = [...new Set(value.split(',').map(n => n.trim()))].filter(n => n && n !== 'none');
    if (!names.length) return [];
    const scopes = [nodes.shadowRootOf(el), el.getRootNode(), documentOf(el)];
    const byTree = new Map(sheets.trees().map(({ tree, sheets }) => [tree, sheets]));
    const found = new Map<string, { sheet: CSSStyleSheet; rule: CSSKeyframesRule }>();
    const inScope = new Map<string, { sheet: CSSStyleSheet; rule: CSSKeyframesRule }>();
    const realm = realmOf(el);
    const applies = (media: MediaList) => !media.mediaText || realm.matchMedia(media.mediaText).matches;
    const walk = (sheet: CSSStyleSheet, list: CSSRule[]) => {
      for (const rule of list)
        if (isCssom(rule, 'CSSKeyframesRule')) inScope.set(rule.name, { sheet, rule });
        else if (isCssom(rule, 'CSSImportRule')) {
          if (rule.styleSheet && applies(rule.media)) walk(rule.styleSheet, sheets.rulesOf(rule.styleSheet));
        } else if (isCssom(rule, 'CSSMediaRule')) {
          if (applies(rule.media)) walk(sheet, sheets.rulesOf(rule));
        } else if (isCssom(rule, 'CSSSupportsRule')) {
          if (realm.CSS.supports(rule.conditionText)) walk(sheet, sheets.rulesOf(rule));
        } else if (isCssom(rule, 'CSSGroupingRule')) walk(sheet, sheets.rulesOf(rule));
    };
    for (const scope of new Set(scopes)) {
      const list = isNode(scope) && (isDocument(scope) || isShadowRoot(scope)) ? byTree.get(scope) : undefined;
      inScope.clear();
      for (const sheet of list ?? []) if (!sheet.disabled && applies(sheet.media)) walk(sheet, sheets.rulesOf(sheet));
      for (const [name, f] of inScope) if (!found.has(name)) found.set(name, f);
    }
    return names.flatMap(name => {
      const f = found.get(name);
      return f ? [rules.keyframes(f.sheet, f.rule)] : [];
    });
  }

  async function matchedStyles(
    el: Element,
    pseudo: PseudoType | null
  ): Promise<Protocol.CSS.GetMatchedStylesForNodeResponse> {
    // Without the DOM domain listening, an iframe loaded since may not be known yet.
    if (!ctx.frames.ofDocument(documentOf(el))) ctx.frames.sync();
    // Adopted sheets change unseen: catch up before answering.
    if (enabled) await syncSheets();
    else await loadCopies();
    await userAgent?.ready();
    return cascade.forRequest(() => {
      // For a pseudo-element, its host is the first element it inherits from.
      if (pseudo) {
        return {
          matchedCSSRules: cascade.matchedRules(el, pseudo),
          pseudoElements: [],
          inherited: cascade.inheritedEntries(el),
          cssKeyframesRules: keyframesOf(el, pseudo),
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
        cssKeyframesRules: keyframesOf(el, null),
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
      // Changes the page made while no session watched went unseen: the texts the sessions share
      // are checked against their sheets again.
      if (!watching()) sheets.texts.unseen();
      known = new Set();
      // Before this domain's observer and frame listener, so the tracker drops a stale list first.
      if (!stopShadowRoots) {
        const release = ctx.shadowRoots.acquire();
        // A shadow tree found with no DOM change this domain sees (a declarative root the parser
        // attached earlier, found when parsing ends) brings sheets; syncSheets only reports the
        // difference from the sheets known, so syncing again after its own observer adds none.
        const unsubscribe = ctx.shadowRoots.onStale(() => void syncSheets());
        stopShadowRoots = () => {
          unsubscribe();
          release();
        };
      }
      const ownsSheet = (n: Node | null) => (isHtml(n, 'style') || isHtml(n, 'link')) && !isOwn(n);
      observer = new MutationObserver(records => {
        // Adding or removing a <style> or <link>, changing the text of a <style> or the href
        // of a <link> all replace style sheets.
        const touchesSheets = records.some(
          r =>
            ownsSheet(r.target) ||
            ownsSheet(r.target.parentNode) ||
            [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].some(
              // A shadow host brings or takes away the sheets of its shadow tree.
              n => ownsSheet(n) || (isElement(n) && !isOwn(n) && !!nodes.shadowRootOf(n))
            )
        );
        // A <style> added, or its text changed, now: its sheet is made while watched, its text taken
        // without the check (sheet-text.ts). Not for a changed attribute (the sheet stays), nor
        // for those in the shadow tree of a host added (no record tells of them): checked.
        for (const r of records) {
          const style = r.type === 'characterData' ? r.target.parentNode : r.target;
          if (r.type !== 'attributes' && isHtml(style, 'style') && !isOwn(style)) sheets.texts.watchedStyle(style);
          for (const n of Array.from(r.addedNodes)) if (isHtml(n, 'style') && !isOwn(n)) sheets.texts.watchedStyle(n);
        }
        quietly(() => forced.removed(records.flatMap(r => Array.from(r.removedNodes))));
        if (touchesSheets) syncSheets();
      });
      observed = new WeakSet();
      watched = new Set();
      // Adopted style sheets change without a DOM mutation.
      stopAdopted = watchAdopted(
        () => void syncSheets(),
        () => [...documents(), ...shadowRoots()]
      );
      // Like Chrome, a change the page makes through the CSSOM keeps the sheet's id: its text is
      // the one given replace() or replaceSync(), or else serialized from the CSSOM.
      stopCssom = watchCssom(
        (sheet, _text, by, change) => {
          // The sheet's own media list changed: Chrome sends nothing for that, and the text is the same.
          if (change?.kind === 'media') return;
          // The text is recorded already, once for every session (sheet-text.ts). Another
          // session's edit: unlike Chrome (where the other sessions keep the text they had and
          // hear nothing), this one is sent styleSheetChanged to fetch it again.
          if (by === sheets) return;
          if (known.has(sheet)) session.emit('CSS.styleSheetChanged', { styleSheetId: sheets.idOf(sheet) });
          // Adopted in the same task, not reported yet: like Chrome, added then changed. Looking
          // through every tree's adopted sheets costs about 1.3 µs a write: a sheet with an owner
          // node (a <style> added in the same task) is none, one already found is not looked for.
          else if (!by && !sheet.ownerNode && !changedUnseen.has(sheet) && adopted(sheet)) changedUnseen.add(sheet);
          // Sheets the other session added or removed (setStyleSheetText's @import).
          if (by) syncSheets();
        },
        () => documents().map(realmOf)
      );
      // A text a header was given found not to be the sheet's at its first use (unchanged since
      // the page changed the sheet unseen): the client fetches it again, now serialized.
      stopRevised = sheets.texts.onRevised(sheet => {
        if (known.has(sheet)) session.emit('CSS.styleSheetChanged', { styleSheetId: sheets.idOf(sheet) });
      });
      stopFrames = ctx.frames.onChange(framesChanged);
      watchDocuments();
      syncSheets();
    },

    disable() {
      enabled = false;
      quietly(() => forced.clear());
      observer?.disconnect();
      observer = null;
      stopShadowRoots?.();
      stopShadowRoots = null;
      for (const doc of watched) doc.removeEventListener('load', onLoad, true);
      watched = new Set();
      stopFrames?.();
      stopFrames = null;
      stopAdopted?.();
      stopAdopted = null;
      stopCssom?.();
      stopCssom = null;
      stopRevised?.();
      stopRevised = null;
      stopWarming(warmer);
      updates.stop();
      // Enabled again, the sheets are all reported anew.
      known = new Set();
      changedUnseen.clear();
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
      // The element's own window: in an iframe, its viewport and media queries.
      const style = realmOf(el).getComputedStyle(el, pseudo ? `::${pseudo}` : null);
      return {
        computedStyle: Array.from(style, name => ({ name, value: style.getPropertyValue(name) })),
        extraFields: { isAppearanceBase: false, isTableSetVisuallyTable: false },
      };
    },

    getBackgroundColors(params: Protocol.CSS.GetBackgroundColorsRequest): Protocol.CSS.GetBackgroundColorsResponse {
      const { el, pseudo } = target(params.nodeId);
      const style = realmOf(el).getComputedStyle(el, pseudo ? `::${pseudo}` : null);
      // Chrome reports no background for a pseudo-element.
      const backgroundColors = pseudo ? null : backgroundsBehind(el, style);
      return {
        ...(backgroundColors && { backgroundColors }),
        computedFontSize: style.fontSize,
        computedFontWeight: style.fontWeight,
      };
    },

    async getStyleSheetText(
      params: Protocol.CSS.GetStyleSheetTextRequest
    ): Promise<Protocol.CSS.GetStyleSheetTextResponse> {
      const sheet = sheets.get(params.styleSheetId);
      // The text of a file is fetched again: wait for it.
      await loadCopies();
      // Chrome has the text of a cross-origin sheet even without CORS; a page script cannot read it.
      if (sheets.isUnreadable(sheet))
        throw new CdpError('The text of a style sheet from another origin is only available with CORS');
      return { text: sheets.text(sheet) };
    },

    setStyleSheetText(params: Protocol.CSS.SetStyleSheetTextRequest): Protocol.CSS.SetStyleSheetTextResponse {
      const sheet = sheets.get(params.styleSheetId);
      assertEditable(sheet);
      // Like Chrome, the text is the sheet's as given, invalid rules and all; that of a <style> is
      // left as it is (setting it would make another sheet). Its rules are replaced through the CSSOM.
      // Only the top-level rules whose text changed are replaced, when that can be told; the
      // others stay the same objects, and the text is recorded with them paired (`recorded`).
      let recorded = false;
      const replace = (text: string) => {
        recorded = false;
        if (isConstructed(sheet)) return ownCall<void>(sheet, 'replaceSync', text);
        if (sheets.texts.retext(sheet, text, s => sheets.rulesOf(s))) {
          recorded = true;
          return;
        }
        while (sheet.cssRules.length) ownCall(sheet, 'deleteRule', sheet.cssRules.length - 1);
        const o = outline(text);
        for (let node = o.firstChild(ROOT); node >= 0; node = o.next(node))
          try {
            ownCall(sheet, 'insertRule', text.slice(o.start(node), o.end(node)), sheet.cssRules.length);
          } catch {
            // Dropped, as the parser drops it.
          }
      };
      const old = sheets.text(sheet);
      editSheet(
        sheet,
        () => params.text,
        () => replace(params.text),
        () => replace(old),
        undefined,
        () => recorded
      );
      // @import rules gone or new bring or take sheets; with CSS disabled, none is reported.
      if (enabled) void syncSheets();
      else void loadCopies();
      stylesChanged();
      return {};
    },

    setStyleTexts(params: Protocol.CSS.SetStyleTextsRequest): Protocol.CSS.SetStyleTextsResponse {
      // Like Chrome, all or none: an edit failing takes back those before it, unrecorded.
      const done: { revert: () => void; action: Action }[] = [];
      const rangeAt = sheets.rangesAtStart(params.edits);
      batch = done;
      let styles: CSSStyle[];
      try {
        styles = params.edits.map((edit, i) => {
          try {
            return applyEdit({ ...edit, range: rangeAt(i) });
          } catch (e) {
            for (const { revert } of done.reverse()) revert();
            // Like Chrome, a range that is no style's, or a text that is none, names the edit.
            const named = e instanceof CdpError && [STYLE_MISMATCH, INVALID_STYLE].includes(e.message);
            throw named ? new CdpError(`Failed applying edit #${i}: ${(e as Error).message}`) : e;
          }
        });
      } finally {
        batch = null;
      }
      for (const { action } of done) history.record(action);
      stylesChanged();
      return { styles };
    },

    setRuleSelector(params: Protocol.CSS.SetRuleSelectorRequest): Protocol.CSS.SetRuleSelectorResponse {
      const sheet = sheets.get(params.styleSheetId);
      assertEditable(sheet);
      const rule = sheets.findRule(sheet, params.range, 'selector');
      if (!isCssom(rule, 'CSSStyleRule')) throw new CdpError('No rule at given range');
      const old = rule.selectorText;
      editSheet(
        sheet,
        splice(sheet, params.range, params.selector),
        () => ownSet(rule, 'selectorText', params.selector),
        () => ownSet(rule, 'selectorText', old),
        params.range
      );
      stylesChanged();
      return { selectorList: rules.selectorList(sheet, rule) };
    },

    setMediaText(params: Protocol.CSS.SetMediaTextRequest): Protocol.CSS.SetMediaTextResponse {
      const sheet = sheets.get(params.styleSheetId);
      assertEditable(sheet);
      const rule = atPrelude(sheet, params.range, r => isCssom(r, 'CSSMediaRule'));
      if (!isCssom(rule, 'CSSMediaRule')) throw new CdpError(RANGE_MISMATCH);
      const media = rule.media;
      const old = shownMedia(media);
      editSheet(
        sheet,
        splice(sheet, params.range, params.text),
        () => ownSet(media, 'mediaText', params.text),
        () => ownSet(media, 'mediaText', old),
        params.range
      );
      stylesChanged();
      return { media: rules.media(sheet, rule) };
    },

    setSupportsText(params: Protocol.CSS.SetSupportsTextRequest): Protocol.CSS.SetSupportsTextResponse {
      const sheet = sheets.get(params.styleSheetId);
      const rule = setPrelude(sheet, params.range, params.text, r => isCssom(r, 'CSSSupportsRule'));
      if (!isCssom(rule, 'CSSSupportsRule')) throw new CdpError(RANGE_MISMATCH);
      // As measured in Chrome 156: a condition given otherwise than it is serialized is answered as
      // given and without its range from then on, and so are the @media around it.
      if (params.text !== rule.conditionText) {
        rules.supportsSet.set(rule, params.text);
        for (let p = rule.parentRule; p; p = p.parentRule) rules.rangeless.add(p);
      }
      return { supports: rules.supports(sheet, rule) };
    },

    setContainerQueryText(
      params: Protocol.CSS.SetContainerQueryTextRequest
    ): Protocol.CSS.SetContainerQueryTextResponse {
      const sheet = sheets.get(params.styleSheetId);
      const rule = setPrelude(sheet, params.range, params.text, r => isCssom(r, 'CSSContainerRule'));
      if (!isCssom(rule, 'CSSContainerRule')) throw new CdpError(RANGE_MISMATCH);
      return { containerQuery: rules.container(sheet, rule) };
    },

    // The condition of an @container, the name included: like setContainerQueryText (Chrome 157).
    setContainerQueryConditionText(
      params: Protocol.CSS.SetContainerQueryConditionTextRequest
    ): Protocol.CSS.SetContainerQueryConditionTextResponse {
      const sheet = sheets.get(params.styleSheetId);
      const rule = setPrelude(sheet, params.range, params.text, r => isCssom(r, 'CSSContainerRule'));
      if (!isCssom(rule, 'CSSContainerRule')) throw new CdpError(RANGE_MISMATCH);
      return { containerQuery: rules.container(sheet, rule) };
    },

    setScopeText(params: Protocol.CSS.SetScopeTextRequest): Protocol.CSS.SetScopeTextResponse {
      const sheet = sheets.get(params.styleSheetId);
      const rule = setPrelude(sheet, params.range, params.text, r => isCssom(r, 'CSSScopeRule'));
      if (!isCssom(rule, 'CSSScopeRule')) throw new CdpError(RANGE_MISMATCH);
      return { scope: rules.scope(sheet, rule) };
    },

    setKeyframeKey(params: Protocol.CSS.SetKeyframeKeyRequest): Protocol.CSS.SetKeyframeKeyResponse {
      const sheet = sheets.get(params.styleSheetId);
      assertEditable(sheet);
      const rule = atPrelude(sheet, params.range, r => isCssom(r, 'CSSKeyframeRule'));
      if (!isCssom(rule, 'CSSKeyframeRule')) throw new CdpError(RANGE_MISMATCH);
      const old = rule.keyText;
      // Chrome's error for a key the parser does not take.
      const alone = ownSheet();
      ownCall(alone, 'replaceSync', `@keyframes x { ${params.keyText} {} }`);
      const parsed = alone.cssRules[0];
      if (!isCssom(parsed, 'CSSKeyframesRule') || parsed.cssRules.length !== 1)
        throw new CdpError('SyntaxError Keyframe key text is not valid.');
      editSheet(
        sheet,
        splice(sheet, params.range, params.keyText),
        () => ownSet(rule, 'keyText', params.keyText),
        () => ownSet(rule, 'keyText', old),
        params.range
      );
      stylesChanged();
      return { keyText: rules.keyText(sheet, rule) };
    },

    createStyleSheet(params: Protocol.CSS.CreateStyleSheetRequest): Protocol.CSS.CreateStyleSheetResponse {
      // Like Chrome, in the document of the frame asked for, each frame with its own sheet; with
      // `force`, a new one every time.
      const frame = ctx.frames.byId(params.frameId);
      if (!frame) throw new CdpError('Frame not found');
      const doc = frame.document;
      const force = params.force ?? false;
      let sheet = force ? null : sheets.inspectorOf(doc);
      if (!sheet) {
        const style = doc.createElement('style');
        style.setAttribute(OWN_ATTRIBUTE, 'inspector-stylesheet');
        markOwn(style);
        (doc.head ?? doc.documentElement).appendChild(style);
        // A connected <style> always has a sheet.
        if (!style.sheet) throw new CdpError('Could not create the inspector style sheet');
        sheet = style.sheet;
        sheets.addInspector(sheet, doc, force);
        sheets.texts.set(sheet, '');
        known.add(sheet);
        session.emit('CSS.styleSheetAdded', { header: header(sheet) });
      }
      return { styleSheetId: sheets.idOf(sheet) };
    },

    addRule(params: Protocol.CSS.AddRuleRequest): Protocol.CSS.AddRuleResponse {
      const sheet = sheets.get(params.styleSheetId);
      assertEditable(sheet);
      // Like Chrome, a location is a range: one that starts past its end is refused first.
      assertOrdered(params.location);
      // Like Chrome, a location in an @media (or another group rule) puts the rule in it.
      const { startLine, startColumn } = params.location;
      const entries = sheets.entries(sheet).map(e => e.rule);
      const onLine = entries.find(r => sheets.ruleId(sheet, r) === startLine);
      let parent: CSSStyleSheet | CSSGroupingRule = sheet;
      let at = -1;
      const source = sheets.sourceOf(sheet);
      if (source) {
        // Where the text is inserted, as written: after the rules before it, in the innermost group
        // rule (not a style rule: addRule does not nest) around it.
        const offset = offsetsOf(source, params.location)?.[0];
        if (offset === undefined) throw new CdpError(OUT_OF_BOUNDS);
        const around = (r: CSSRule) => {
          const node = source.nodes.get(r);
          const o = source.outline;
          return (
            node !== undefined && o.blockStart(node) >= 0 && o.blockStart(node) < offset && offset < o.blockEnd(node)
          );
        };
        for (let inner = Array.from(parent.cssRules).find(around); inner;) {
          if (!isCssom(inner, 'CSSGroupingRule') || isCssom(inner, 'CSSStyleRule')) break;
          parent = inner;
          inner = Array.from(parent.cssRules).find(around);
        }
        at = Array.from(parent.cssRules).filter(r => {
          const node = source.nodes.get(r);
          return (node === undefined ? offset : source.outline.start(node)) < offset;
        }).length;
      } else if (onLine) {
        // Before the rule at `location`, or after it when the location is inside it (in the
        // serialized text, rules are one per line).
        // The group rule (not a style rule: addRule does not nest) the rule is in.
        let child: CSSRule = onLine;
        for (let p = child.parentRule; p; child = p, p = p.parentRule)
          if (isCssom(p, 'CSSGroupingRule') && !isCssom(p, 'CSSStyleRule')) {
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
      // As measured in Chrome 156, a rule asked for before @namespace rules (which only @import may
      // precede) goes in after them, its text still where asked; one before an @import is refused.
      if (parent === sheet) while (at >= 0 && isCssom(sheet.cssRules[at], 'CSSNamespaceRule')) at++;
      const target = parent;
      // Like Chrome, the text goes in as it is, where asked (taken before the CSSOM changes).
      const before = source?.text ?? null;
      const after = splice(sheet, params.location, params.ruleText)(before);
      let index: number;
      try {
        index = ownCall<number>(target, 'insertRule', params.ruleText, at < 0 ? target.cssRules.length : at);
      } catch (e) {
        // By name: the sheet may be another frame's, with a DOMException of its own. Chrome 156's
        // messages: a rule before an @import, and one that cannot be in a group rule (@import).
        if ((e as { name?: unknown } | null)?.name === 'HierarchyRequestError')
          throw new CdpError(
            target === sheet
              ? `SyntaxError The rule '${params.ruleText}' could not be added in style sheet.`
              : 'SyntaxError Rule text is not valid.'
          );
        throw e;
      }
      const rule = target.cssRules[index];
      if (!isCssom(rule, 'CSSStyleRule')) {
        ownCall(target, 'deleteRule', index);
        throw new CdpError('Failed to parse rule text');
      }
      // The generation of the text left (-1: not made yet): undo and redo put back theirs only if
      // no one (a session, the page) changed it since; the text is unknown otherwise, and stays so
      // for later ones (-2).
      let left = -1;
      const record = (text: string | null) => {
        const known = left === -1 || sheets.texts.generation(sheet) === left ? text : null;
        if (known === null) sheets.texts.invalidate(sheet);
        else sheets.texts.set(sheet, known);
        left = known === null ? -2 : sheets.texts.generation(sheet);
        editedBy(sheets, sheet, known ?? undefined);
      };
      record(after);
      const text = rule.cssText;
      // Redo inserts a new rule object, which the next undo removes.
      let added: CSSRule = rule;
      history.record({
        undo: () => {
          const at = Array.from(target.cssRules).indexOf(added);
          if (at >= 0) ownCall(target, 'deleteRule', at);
          record(before);
          stylesChanged();
        },
        redo: () => {
          const i = ownCall<number>(target, 'insertRule', text, Math.min(index, target.cssRules.length));
          added = target.cssRules[i] ?? added;
          record(after);
          stylesChanged();
        },
      });
      stylesChanged();
      return { rule: rules.cssRule(sheet, rule) };
    },

    collectClassNames(params: Protocol.CSS.CollectClassNamesRequest): Protocol.CSS.CollectClassNamesResponse {
      const names = new Set<string>();
      for (const { rule } of sheets.entries(sheets.get(params.styleSheetId))) {
        if (!isCssom(rule, 'CSSStyleRule')) continue;
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
    trackComputedStyleUpdatesForNode(params: Protocol.CSS.TrackComputedStyleUpdatesForNodeRequest) {
      updates.trackNode(params.nodeId);
    },
    trackComputedStyleUpdates(params: Protocol.CSS.TrackComputedStyleUpdatesRequest) {
      updates.trackProperties(params.propertiesToTrack);
    },
    takeComputedStyleUpdates: (): Promise<Protocol.CSS.TakeComputedStyleUpdatesResponse> => updates.take(),
    getEnvironmentVariables: (): Protocol.CSS.GetEnvironmentVariablesResponse => ({
      environmentVariables: environmentVariables(ctx.frames.top.document),
    }),
    setEffectivePropertyValueForNode(params: Protocol.CSS.SetEffectivePropertyValueForNodeRequest) {
      const el = element(params.nodeId);
      if (!(isHtmlElement(el) || isSvgElement(el))) throw new CdpError('Element has no inline style');
      const old = shownAttribute(el, 'style', el.getAttribute('style'));
      perform(
        () => el.style.setProperty(params.propertyName, params.value),
        () => (old === null ? el.removeAttribute('style') : el.setAttribute('style', old))
      );
    },
  });
}
