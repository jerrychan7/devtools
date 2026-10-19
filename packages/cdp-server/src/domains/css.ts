import type { Protocol } from 'devtools-protocol';
import { FRAME_ID, type Context } from '../core/context';
import { OWN_ATTRIBUTE, PSEUDO_TYPES, PseudoElement, type PseudoType } from '../core/nodes';
import { compareSpecificity, specificity, splitTopLevel } from '../core/selectors';
import { CdpError } from '../core/server';
import { resolveElement } from './dom';
import { ForcedPseudoClasses } from './forced-pseudo';

type CSSStyle = Protocol.CSS.CSSStyle;
type CSSProperty = Protocol.CSS.CSSProperty;
type StyleOrigin = Protocol.CSS.StyleSheetOrigin;
/** `extraFields` also carries `isTableSetVisuallyTable`, which devtools-protocol does not declare. */
type ComputedStyleResponse = Protocol.CSS.GetComputedStyleForNodeResponse & {
  extraFields: Protocol.CSS.ComputedStyleExtraFields & { isTableSetVisuallyTable: boolean };
};

const INLINE_PREFIX = 'inline:';

/** A pseudo-element at the end of a selector: `a::before`, legacy `a:after`, `::marker`. */
const PSEUDO_SUFFIX =
  /(?:::(before|after|marker|first-line|first-letter|placeholder|selection|backdrop|file-selector-button|cue|(?:part|slotted|highlight|view-transition[\w-]*)\([^)]*\))|:(before|after|first-line|first-letter))$/i;

/** Splits `a.b::before` into the host selector `a.b` and the pseudo-element `before`. */
function splitPseudoElement(selector: string): { host: string; pseudo: string | null } {
  const m = PSEUDO_SUFFIX.exec(selector);
  if (!m) return { host: selector, pseudo: null };
  const host = selector.slice(0, m.index).trim();
  return { host: host && !/[\s>+~]$/.test(host) ? host : `${host}*`, pseudo: (m[1] || m[2] || '').toLowerCase() };
}

/**
 * The text the client last set on a style, with the CSSOM text it produced. The CSSOM drops
 * comments and invalid declarations, but Chrome keeps them as properties: disabled ones (the
 * Styles pane comments a property out when it is unchecked) and ones with parsedOk false.
 * The source is used as long as the page has not changed the style since.
 */
const sources = new WeakMap<CSSStyleDeclaration, { text: string; applied: string }>();

/** Sets `text` on a style, keeping it to report disabled and invalid declarations. */
function setStyleText(decl: CSSStyleDeclaration, text: string, apply: () => void) {
  apply();
  sources.set(decl, { text, applied: decl.cssText });
}

interface Declaration {
  raw: string;
  disabled: boolean;
}

/** Declarations of a style text in order, those in comments disabled. */
function declarations(text: string): Declaration[] {
  const result: Declaration[] = [];
  const comment = /\/\*([\s\S]*?)\*\//g;
  let last = 0;
  const enabled = (part: string) => splitTopLevel(part, ';').forEach(raw => result.push({ raw, disabled: false }));
  for (let m = comment.exec(text); m; m = comment.exec(text)) {
    enabled(text.slice(last, m.index));
    last = m.index + m[0].length;
    const inner = (m[1] ?? '').trim().replace(/;$/, '');
    if (inner.includes(':')) result.push({ raw: inner, disabled: true });
  }
  enabled(text.slice(last));
  return result;
}

/**
 * Serializes declarations as `name: value;` separated by spaces, the text the client edits;
 * disabled ones as `/* name: value; *\/`. Each declared property gets a range; longhands of
 * shorthands follow without one.
 */
function buildStyle(styleSheetId: string, decl: CSSStyleDeclaration, line: number, column: number): CSSStyle {
  const cssProperties: CSSProperty[] = [];
  const shorthandEntries: Protocol.CSS.ShorthandEntry[] = [];
  const probe = document.createElement('div').style;
  const source = sources.get(decl);
  const list =
    source && source.applied === decl.cssText
      ? declarations(source.text)
      : splitTopLevel(decl.cssText, ';').map(raw => ({ raw, disabled: false }));
  let text = '';
  for (const { raw, disabled } of list) {
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const name = raw.slice(0, colon).trim();
    let value = raw.slice(colon + 1).trim();
    if (!name) continue;
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/\s*!\s*important$/i, '');
    const declText = `${name}: ${value}${important ? ' !important' : ''};`;
    // Whether the browser accepts the declaration.
    probe.cssText = declText;
    const parsedOk = probe.length > 0;
    const propertyText = disabled ? `/* ${declText} */` : declText;
    if (text) text += ' ';
    const start = column + text.length;
    text += propertyText;
    const property: CSSProperty = {
      name,
      value,
      important,
      implicit: false,
      text: propertyText,
      // Like Chrome, only reported when false.
      ...(!parsedOk && { parsedOk }),
      disabled,
      range: { startLine: line, startColumn: start, endLine: line, endColumn: start + propertyText.length },
    };
    cssProperties.push(property);
    if (disabled || !parsedOk) continue;
    // Expand shorthands into their longhands, like Chrome does: listed on the shorthand (the
    // Styles pane shows them when it is expanded) and as properties of their own.
    const longhands = Array.from(probe, longhand => ({ name: longhand, value: probe.getPropertyValue(longhand) }));
    if (longhands.length > 1 || (longhands.length === 1 && longhands[0]?.name !== name)) {
      shorthandEntries.push({ name, value, important });
      property.longhandProperties = longhands;
      for (const longhand of longhands) cssProperties.push({ ...longhand, important, implicit: false });
    }
  }
  return {
    styleSheetId,
    cssProperties,
    shorthandEntries,
    cssText: text,
    range: { startLine: line, startColumn: column, endLine: line, endColumn: column + text.length },
  };
}

interface Entry {
  rule: CSSStyleRule;
  media: Protocol.CSS.CSSMedia[];
}

/**
 * Tracks the page's style sheets. Every style rule gets a stable id within its sheet, which
 * also serves as its line in the text served by CSS.getStyleSheetText (one rule per line),
 * so ranges the client sends back keep pointing at the same rule even if the page adds or
 * removes rules in between.
 */
class SheetRegistry {
  private sheetIds = new WeakMap<CSSStyleSheet, string>();
  private sheets = new Map<string, CSSStyleSheet>();
  private ruleIds = new WeakMap<CSSStyleRule, number>();
  private nextRuleId = new WeakMap<CSSStyleSheet, number>();
  private seq = 0;
  inspectorSheet: CSSStyleSheet | null = null;

  constructor(private fetch: typeof window.fetch) {}

  idOf(sheet: CSSStyleSheet): string {
    let id = this.sheetIds.get(sheet);
    if (!id) {
      id = `sheet-${++this.seq}`;
      this.sheetIds.set(sheet, id);
      this.sheets.set(id, sheet);
    }
    return id;
  }

  /**
   * Gives `replacement` the id of `sheet`, e.g. the new sheet of a <style> whose text was
   * replaced: like in Chrome, the style sheet keeps its id.
   */
  rebind(sheet: CSSStyleSheet, replacement: CSSStyleSheet) {
    const id = this.idOf(sheet);
    this.sheetIds.set(replacement, id);
    this.sheets.set(id, replacement);
    if (this.inspectorSheet === sheet) this.inspectorSheet = replacement;
  }

  get(styleSheetId: string): CSSStyleSheet {
    const sheet = this.sheets.get(styleSheetId);
    if (!sheet) throw new CdpError('No style sheet with given id found');
    return sheet;
  }

  /** Document style sheets, including @import-ed ones, that we can read. */
  all(): CSSStyleSheet[] {
    const result: CSSStyleSheet[] = [];
    const visit = (sheet: CSSStyleSheet) => {
      // devtools-anywhere's own sheets (e.g. forced pseudo-class companions) are not the page's.
      const owner = sheet.ownerNode;
      if (owner instanceof Element && owner.hasAttribute(OWN_ATTRIBUTE) && sheet !== this.inspectorSheet) return;
      result.push(sheet);
      for (const rule of this.rulesOf(sheet))
        if (rule instanceof CSSImportRule && rule.styleSheet) visit(rule.styleSheet);
    };
    Array.from(document.styleSheets).forEach(visit);
    return result;
  }

  /**
   * Copies of cross-origin sheets, whose rules page scripts cannot read: the CSS text is
   * fetched again (which needs CORS headers) and parsed. null: the fetch failed.
   */
  private copies = new WeakMap<CSSStyleSheet, CSSStyleSheet | null>();
  private loading = new Map<CSSStyleSheet, Promise<void>>();

  rulesOf(sheet: CSSStyleSheet | CSSGroupingRule): CSSRule[] {
    try {
      return Array.from(sheet.cssRules);
    } catch {
      const copy = sheet instanceof CSSStyleSheet ? this.copies.get(sheet) : null;
      return copy ? Array.from(copy.cssRules) : [];
    }
  }

  /** Whether the sheet's rules come from a fetched copy, so editing them has no effect. */
  isCopy(sheet: CSSStyleSheet): boolean {
    try {
      void sheet.cssRules;
      return false;
    } catch {
      return !!this.copies.get(sheet);
    }
  }

  /** Fetches copies of the cross-origin sheets not loaded yet; resolves when all are done. */
  loadCopies(onLoaded: (sheet: CSSStyleSheet) => void): Promise<void> {
    for (const sheet of this.all()) {
      if (!sheet.href || this.copies.has(sheet) || this.loading.has(sheet)) continue;
      try {
        void sheet.cssRules;
        continue;
      } catch {
        // Cross-origin: load a copy below.
      }
      const load = this.fetch(sheet.href, { credentials: 'omit' })
        .then(res => (res.ok ? res.text() : Promise.reject(new Error(res.statusText))))
        .then(text => {
          const copy = new CSSStyleSheet();
          copy.replaceSync(text);
          this.copies.set(sheet, copy);
          onLoaded(sheet);
        })
        .catch(() => void this.copies.set(sheet, null))
        .finally(() => this.loading.delete(sheet));
      this.loading.set(sheet, load);
    }
    return Promise.all(this.loading.values()).then(() => {});
  }

  ruleId(sheet: CSSStyleSheet, rule: CSSStyleRule): number {
    let id = this.ruleIds.get(rule);
    if (id === undefined) {
      id = this.nextRuleId.get(sheet) ?? 0;
      this.nextRuleId.set(sheet, id + 1);
      this.ruleIds.set(rule, id);
    }
    return id;
  }

  /** Style rules of a sheet in order, with the @media rules around them. */
  entries(sheet: CSSStyleSheet, onlyActive = false): Entry[] {
    const result: Entry[] = [];
    const sheetId = this.idOf(sheet);
    const visit = (rules: CSSRule[], media: Protocol.CSS.CSSMedia[]) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          this.ruleId(sheet, rule);
          result.push({ rule, media });
        } else if (rule instanceof CSSMediaRule) {
          if (onlyActive && !matchMedia(rule.conditionText).matches) continue;
          visit(this.rulesOf(rule), [
            { text: rule.conditionText, source: 'mediaRule', styleSheetId: sheetId },
            ...media,
          ]);
        } else if (rule instanceof CSSSupportsRule) {
          if (onlyActive && !CSS.supports(rule.conditionText)) continue;
          visit(this.rulesOf(rule), media);
        } else if (rule instanceof CSSGroupingRule) {
          visit(this.rulesOf(rule), media);
        }
      }
    };
    visit(this.rulesOf(sheet), []);
    return result;
  }

  findRule(sheet: CSSStyleSheet, line: number): CSSStyleRule {
    const entry = this.entries(sheet).find(e => this.ruleIds.get(e.rule) === line);
    if (!entry) throw new CdpError('No rule at given range');
    return entry.rule;
  }

  /** The text of a sheet with every style rule on the line of its id. */
  text(sheet: CSSStyleSheet): string {
    const lines: string[] = [];
    for (const { rule } of this.entries(sheet)) {
      const id = this.ruleId(sheet, rule);
      while (lines.length < id) lines.push('');
      lines[id] = `${rule.selectorText} { ${buildStyle('', rule.style, 0, 0).cssText} }`;
    }
    return lines.join('\n');
  }

  origin(sheet: CSSStyleSheet): StyleOrigin {
    return sheet === this.inspectorSheet ? 'inspector' : 'regular';
  }

  header(sheet: CSSStyleSheet): Protocol.CSS.CSSStyleSheetHeader {
    const text = this.text(sheet);
    const lines = text.split('\n');
    const isInspector = sheet === this.inspectorSheet;
    return {
      styleSheetId: this.idOf(sheet),
      frameId: FRAME_ID,
      sourceURL: sheet.href ?? (isInspector ? '' : location.href),
      origin: this.origin(sheet),
      title: sheet.title ?? '',
      disabled: sheet.disabled,
      isInline: !sheet.href && !isInspector,
      isMutable: isInspector,
      isConstructed: false,
      startLine: 0,
      startColumn: 0,
      length: text.length,
      endLine: lines.length - 1,
      endColumn: lines.at(-1)?.length ?? 0,
    };
  }
}

/** Channels of a computed `rgb()` / `rgba()` color, or null for other notations. */
function rgba(value: string): [number, number, number, number] | null {
  const match = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
}

/**
 * The color text is drawn on: like Chrome, translucent backgrounds are blended over those of the
 * ancestors (down to the white page), and null when an image or gradient makes it unknown.
 */
function backgroundBehind(el: Element, style: CSSStyleDeclaration): string | null {
  const layers: [number, number, number, number][] = [];
  for (let node: Element | null = el, s = style; node;) {
    if (s.backgroundImage !== 'none') return null;
    const color = rgba(s.backgroundColor);
    if (!color) return null;
    if (color[3] > 0) layers.push(color);
    if (color[3] >= 1) break;
    const root = node.getRootNode();
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    if (node) s = getComputedStyle(node);
  }
  let [r, g, b] = [255, 255, 255];
  for (const [lr, lg, lb, la] of layers.reverse()) {
    r = lr * la + r * (1 - la);
    g = lg * la + g * (1 - la);
    b = lb * la + b * (1 - la);
  }
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

export function registerCss(ctx: Context) {
  const { server, nodes } = ctx;
  const sheets = new SheetRegistry(ctx.probe.fetch);
  const forced = new ForcedPseudoClasses(
    () => sheets.all(),
    sheet => sheets.rulesOf(sheet)
  );

  /** After the page's styles changed: keep forced states and pseudo-elements in sync. */
  function stylesChanged() {
    if (forced.isActive) forced.rebuild();
    ctx.refreshPseudoElements?.();
  }
  let enabled = false;
  let known = new Set<CSSStyleSheet>();
  let observer: MutationObserver | null = null;

  function header(sheet: CSSStyleSheet) {
    const h = sheets.header(sheet);
    if (sheet.ownerNode && sheet !== sheets.inspectorSheet) h.ownerNode = nodes.backendIdOf(sheet.ownerNode);
    return h;
  }

  /** Reports added and removed sheets since the last call. */
  function syncSheets() {
    const current = new Set(sheets.all());
    for (const sheet of current) if (!known.has(sheet)) server.emit('CSS.styleSheetAdded', { header: header(sheet) });
    for (const sheet of known)
      if (!current.has(sheet)) server.emit('CSS.styleSheetRemoved', { styleSheetId: sheets.idOf(sheet) });
    known = current;
    if (forced.isActive) forced.rebuild();
    return loadCopies();
  }

  /** `load` reaches the document for every image and script too: only style elements matter. */
  const onLoad = (event: Event) => {
    if (event.target instanceof HTMLLinkElement || event.target instanceof HTMLStyleElement) void syncSheets();
  };

  /** Loads copies of cross-origin sheets; the client re-reads a sheet once its copy is in. */
  const loadCopies = () =>
    sheets.loadCopies(sheet => server.emit('CSS.styleSheetChanged', { styleSheetId: sheets.idOf(sheet) }));

  /** Rules of fetched copies are shown, but editing them would not affect the page. */
  function assertEditable(sheet: CSSStyleSheet) {
    if (sheets.isCopy(sheet)) throw new CdpError('This style sheet comes from another origin and cannot be edited');
  }

  function ruleStyle(sheet: CSSStyleSheet, rule: CSSStyleRule): CSSStyle {
    const line = sheets.ruleId(sheet, rule);
    return buildStyle(sheets.idOf(sheet), rule.style, line, rule.selectorText.length + 3);
  }

  function selectorList(sheet: CSSStyleSheet, rule: CSSStyleRule): Protocol.CSS.SelectorList {
    const line = sheets.ruleId(sheet, rule);
    let column = 0;
    const selectors = splitTopLevel(rule.selectorText, ',').map(raw => {
      const text = raw.trim();
      const start = column + raw.indexOf(text);
      column += raw.length + 1;
      return {
        text,
        specificity: specificity(text),
        range: { startLine: line, startColumn: start, endLine: line, endColumn: start + text.length },
      };
    });
    return { selectors, text: rule.selectorText };
  }

  function cssRule(sheet: CSSStyleSheet, entry: Entry): Protocol.CSS.CSSRule {
    const rule: Protocol.CSS.CSSRule = {
      styleSheetId: sheets.idOf(sheet),
      selectorList: selectorList(sheet, entry.rule),
      origin: sheets.origin(sheet),
      style: ruleStyle(sheet, entry.rule),
    };
    if (entry.media.length) rule.media = entry.media;
    return rule;
  }

  /** A style rule ready for matching: its selectors split, with forced pseudo-classes rewritten. */
  type Candidate = {
    sheet: CSSStyleSheet;
    entry: Entry;
    order: number;
    selectors: { selector: string; index: number; pseudo: string | null; host: string }[];
  };

  function candidates(): Candidate[] {
    const result: Candidate[] = [];
    let order = 0;
    for (const sheet of sheets.all()) {
      if (sheet.disabled) continue;
      for (const entry of sheets.entries(sheet, true)) {
        order++;
        const selectors = splitTopLevel(entry.rule.selectorText, ',').map((s, index) => {
          const selector = s.trim();
          const split = splitPseudoElement(selector);
          return { selector, index, pseudo: split.pseudo, host: forced.rewrite(split.host) };
        });
        result.push({ sheet, entry, order, selectors });
      }
    }
    return result;
  }

  /**
   * The candidates of the request being answered: one request matches the element, its
   * pseudo-elements and its ancestors against the same rules, so they are collected once.
   */
  let requestCandidates: Candidate[] | null = null;

  /**
   * Rules matching `el`, or with `pseudo`, its pseudo-element, in cascade order (lowest
   * priority first). Selectors ending in a pseudo-element only match that pseudo-element.
   */
  function matchedRules(el: Element, pseudo: PseudoType | null = null): Protocol.CSS.RuleMatch[] {
    const matches: { match: Protocol.CSS.RuleMatch; spec: Protocol.CSS.Specificity; order: number }[] = [];
    for (const { sheet, entry, order, selectors } of requestCandidates ?? candidates()) {
      const matched = selectors.filter(s => {
        if (s.pseudo !== pseudo) return false;
        try {
          return el.matches(s.host);
        } catch {
          return false; // Unsupported selector.
        }
      });
      if (!matched.length) continue;
      const matching = matched.map(m => m.index);
      const spec = matched.map(m => specificity(m.selector)).reduce((m, s) => (compareSpecificity(s, m) > 0 ? s : m));
      matches.push({ match: { rule: cssRule(sheet, entry), matchingSelectors: matching }, spec, order });
    }
    // Inspector rules win over regular ones of equal specificity, as they come last.
    return matches.sort((x, y) => compareSpecificity(x.spec, y.spec) || x.order - y.order).map(m => m.match);
  }

  function inlineStyle(el: Element): CSSStyle | undefined {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return undefined;
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
    for (let parent = from; parent; parent = parent.parentElement) {
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
      setStyleText(el.style, edit.text, () => el.setAttribute('style', edit.text));
      return buildStyle(edit.styleSheetId, el.style, 0, 0);
    }
    const sheet = sheets.get(edit.styleSheetId);
    assertEditable(sheet);
    const rule = sheets.findRule(sheet, edit.range.startLine);
    setStyleText(rule.style, edit.text, () => (rule.style.cssText = edit.text));
    return ruleStyle(sheet, rule);
  }

  server.register('CSS', {
    enable() {
      if (enabled) return;
      enabled = true;
      known = new Set();
      syncSheets();
      const ownsSheet = (n: Node | null) =>
        (n instanceof HTMLStyleElement || n instanceof HTMLLinkElement) && !n.hasAttribute(OWN_ATTRIBUTE);
      observer = new MutationObserver(records => {
        // Adding or removing a <style> or <link>, changing the text of a <style> or the href
        // of a <link> all replace style sheets.
        const touchesSheets = records.some(
          r =>
            ownsSheet(r.target) ||
            ownsSheet(r.target.parentNode) ||
            [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].some(ownsSheet)
        );
        forced.removed(records.flatMap(r => Array.from(r.removedNodes)));
        if (touchesSheets) syncSheets();
      });
      observer.observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
        attributeFilter: ['href', 'rel', 'disabled', 'media', 'type'],
      });
      // A <link> stylesheet (or a <style> with @import) becomes available once loaded.
      document.addEventListener('load', onLoad, true);
    },

    disable() {
      enabled = false;
      forced.clear();
      observer?.disconnect();
      document.removeEventListener('load', onLoad, true);
    },

    async getMatchedStylesForNode(
      params: Protocol.CSS.GetMatchedStylesForNodeRequest
    ): Promise<Protocol.CSS.GetMatchedStylesForNodeResponse> {
      const { el, pseudo } = target(params.nodeId);
      await loadCopies();
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
          inherited: inheritedEntries(el.parentElement),
          cssKeyframesRules: [],
        };
        const style = inlineStyle(el);
        if (style) result.inlineStyle = style;
        return result;
      } finally {
        requestCandidates = null;
      }
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
      const background = pseudo ? null : backgroundBehind(el, style);
      return {
        ...(background && { backgroundColors: [background] }),
        computedFontSize: style.fontSize,
        computedFontWeight: style.fontWeight,
      };
    },

    getStyleSheetText: (params: Protocol.CSS.GetStyleSheetTextRequest): Protocol.CSS.GetStyleSheetTextResponse => ({
      text: sheets.text(sheets.get(params.styleSheetId)),
    }),

    setStyleSheetText(params: Protocol.CSS.SetStyleSheetTextRequest): Protocol.CSS.SetStyleSheetTextResponse {
      const sheet = sheets.get(params.styleSheetId);
      const owner = sheet.ownerNode;
      assertEditable(sheet);
      if (!(owner instanceof HTMLStyleElement)) throw new CdpError('Style sheet is not editable');
      owner.textContent = params.text;
      // The <style> now has a new sheet: it takes the place of the old one.
      if (owner.sheet && owner.sheet !== sheet) {
        sheets.rebind(sheet, owner.sheet);
        if (known.delete(sheet)) known.add(owner.sheet);
      }
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
      rule.selectorText = params.selector;
      stylesChanged();
      return { selectorList: selectorList(sheet, rule) };
    },

    createStyleSheet(): Protocol.CSS.CreateStyleSheetResponse {
      if (!sheets.inspectorSheet?.ownerNode?.isConnected) {
        const style = document.createElement('style');
        style.setAttribute(OWN_ATTRIBUTE, 'inspector-stylesheet');
        document.head.appendChild(style);
        // A connected <style> always has a sheet.
        if (!style.sheet) throw new CdpError('Could not create the inspector style sheet');
        sheets.inspectorSheet = style.sheet;
        known.add(style.sheet);
        server.emit('CSS.styleSheetAdded', { header: header(style.sheet) });
      }
      return { styleSheetId: sheets.idOf(sheets.inspectorSheet) };
    },

    addRule(params: Protocol.CSS.AddRuleRequest): Protocol.CSS.AddRuleResponse {
      const sheet = sheets.get(params.styleSheetId);
      assertEditable(sheet);
      const index = sheet.insertRule(params.ruleText, sheet.cssRules.length);
      const rule = sheet.cssRules[index];
      if (!(rule instanceof CSSStyleRule)) {
        sheet.deleteRule(index);
        throw new CdpError('Failed to parse rule text');
      }
      stylesChanged();
      return { rule: cssRule(sheet, { rule, media: [] }) };
    },

    collectClassNames(params: Protocol.CSS.CollectClassNamesRequest): Protocol.CSS.CollectClassNamesResponse {
      const names = new Set<string>();
      for (const { rule } of sheets.entries(sheets.get(params.styleSheetId))) {
        for (const [, name] of rule.selectorText.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) if (name) names.add(name);
      }
      return { classNames: Array.from(names) };
    },

    getPlatformFontsForNode: (): Protocol.CSS.GetPlatformFontsForNodeResponse => ({ fonts: [] }),
    getMediaQueries: (): Protocol.CSS.GetMediaQueriesResponse => ({ medias: [] }),
    forcePseudoState(params: Protocol.CSS.ForcePseudoStateRequest) {
      forced.set(element(params.nodeId), params.forcedPseudoClasses);
      ctx.refreshPseudoElements?.();
    },
    trackComputedStyleUpdates: () => {},
    takeComputedStyleUpdates: (): Protocol.CSS.TakeComputedStyleUpdatesResponse => ({ nodeIds: [] }),
    setEffectivePropertyValueForNode(params: Protocol.CSS.SetEffectivePropertyValueForNodeRequest) {
      const el = element(params.nodeId);
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) throw new CdpError('Element has no inline style');
      el.style.setProperty(params.propertyName, params.value);
    },
  });
}
