import type { Protocol } from 'devtools-protocol';
import { FRAME_ID, type Context } from '../core/context';
import { OWN_ATTRIBUTE, PSEUDO_TYPES, isOwn, markOwn, PseudoElement, type PseudoType } from '../core/nodes';
import { containerMatches, parentOf, queriedAxes } from '../core/container-query';
import { compareSpecificity, specificity, splitTopLevel } from '../core/selectors';
import { CdpError } from '../core/server';
import { resolveElement } from './dom';
import { historyOf } from '../core/history';
import { adoptedOf, quietly, watchAdopted } from '../core/adopted';
import { ForcedPseudoClasses, type TreeScope } from './forced-pseudo';

type CSSStyle = Protocol.CSS.CSSStyle;
type CSSProperty = Protocol.CSS.CSSProperty;
type StyleOrigin = Protocol.CSS.StyleSheetOrigin;
/** `extraFields` also carries `isTableSetVisuallyTable`, which devtools-protocol does not declare. */
type ComputedStyleResponse = Protocol.CSS.GetComputedStyleForNodeResponse & {
  extraFields: Protocol.CSS.ComputedStyleExtraFields & { isTableSetVisuallyTable: boolean };
};

const INLINE_PREFIX = 'inline:';

/** What the CSS domain watches in the document and shadow roots for style sheet changes. */
const OBSERVED: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributeFilter: ['href', 'rel', 'disabled', 'media', 'type'],
};

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
 * Like Chrome, after the declared properties come the longhands the style actually holds,
 * without ranges: normal ones first, then !important ones, each in declaration order.
 * Longhands a `border` resets but cannot set (`border-image-*`) are implicit.
 */
function appliedProperties(decl: CSSStyleDeclaration, list: Declaration[]): CSSProperty[] {
  const names = list.filter(d => !d.disabled).map(d => d.raw.slice(0, d.raw.indexOf(':')).trim().toLowerCase());
  const borderImage = names.some(n => n.startsWith('border-image'));
  const normal: CSSProperty[] = [];
  const important: CSSProperty[] = [];
  for (const name of Array.from(decl)) {
    const value = decl.getPropertyValue(name);
    if (decl.getPropertyPriority(name) === 'important') {
      important.push({ name, value: `${value} !important`, important: true });
      continue;
    }
    const implicit = !borderImage && name.startsWith('border-image-') && names.includes('border');
    normal.push({ name, value, ...(implicit && { implicit }) });
  }
  return [...normal, ...important];
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
    // Like Chrome, values of !important declarations keep the flag.
    const shown = important ? `${value} !important` : value;
    const property: CSSProperty = {
      name,
      value: shown,
      ...(important && { important }),
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
    const longhands: CSSProperty[] = Array.from(probe, longhand => ({
      name: longhand,
      value: important ? `${probe.getPropertyValue(longhand)} !important` : probe.getPropertyValue(longhand),
      ...(important && { important }),
    }));
    if (longhands.length > 1 || (longhands.length === 1 && longhands[0]?.name !== name)) {
      shorthandEntries.push({ name, value: shown, ...(important && { important }) });
      property.longhandProperties = longhands;
    }
  }
  cssProperties.push(...appliedProperties(decl, list));
  return {
    styleSheetId,
    cssProperties,
    shorthandEntries,
    cssText: text,
    range: { startLine: line, startColumn: column, endLine: line, endColumn: column + text.length },
  };
}

/** A rule with declarations: a style rule, or declarations after rules nested in one. */
type StyleRule = CSSStyleRule | CSSNestedDeclarations;

interface Entry {
  rule: StyleRule;
  /** Keys of the cascade layers the rule is in, outermost first (see SheetRegistry.entries). */
  layer: string[];
}

/** Rules around `rule`, innermost first. */
function ancestorsOf(rule: CSSRule): CSSRule[] {
  const result: CSSRule[] = [];
  for (let parent = rule.parentRule; parent; parent = parent.parentRule) result.push(parent);
  return result;
}

/** The style rule or @scope that `&` refers to in `rule`. */
function nestingParent(rule: CSSRule): CSSStyleRule | CSSScopeRule | null {
  return ancestorsOf(rule).find(r => r instanceof CSSStyleRule || r instanceof CSSScopeRule) ?? null;
}

/** The selector Chrome shows for a rule: nested declarations show that of their style rule. */
function selectorLabel(rule: StyleRule): string {
  if (rule instanceof CSSStyleRule) return rule.selectorText;
  const parent = nestingParent(rule);
  return parent instanceof CSSStyleRule ? parent.selectorText : '&';
}

/** Replaces `&` outside strings and escapes. */
function replaceNesting(selector: string, replacement: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i] ?? '';
    if (ch === '\\') {
      out += ch + (selector[++i] ?? '');
    } else if (quote) {
      if (ch === quote) quote = '';
      out += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else {
      out += ch === '&' ? replacement : ch;
    }
  }
  return out;
}

/**
 * One selector of `rule` with `&` resolved, ready for Element.matches: in a nested rule `&`
 * is `:is(<parent selectors>)`; in @scope it is the scoping root (`:scope`), and selectors
 * without `&` or `:scope` are relative to the root. For specificity, `&` in @scope counts as
 * `:where(:scope)`, and the implied root does not count.
 */
function resolveSelector(selector: string, rule: CSSRule, forSpecificity = false): string {
  const parent = nestingParent(rule);
  if (parent instanceof CSSStyleRule) {
    const list = splitTopLevel(parent.selectorText, ',')
      .map(s => resolveSelector(s.trim(), parent, forSpecificity))
      .join(', ');
    return replaceNesting(selector.includes('&') ? selector : `& ${selector}`, `:is(${list})`);
  }
  if (parent instanceof CSSScopeRule) {
    const relative = !selector.includes('&') && !/:scope(?![\w-])/.test(selector);
    if (forSpecificity) return replaceNesting(selector, ':where(:scope)');
    return replaceNesting(relative ? `:scope ${selector}` : selector, ':scope');
  }
  return replaceNesting(selector, ':scope');
}

/** The rule type Chrome reports for an at-rule (or style rule) around a rule. */
function ruleType(rule: CSSRule): Protocol.CSS.CSSRuleType | null {
  if (rule instanceof CSSStyleRule) return 'StyleRule';
  if (rule instanceof CSSMediaRule) return 'MediaRule';
  if (rule instanceof CSSSupportsRule) return 'SupportsRule';
  if (rule instanceof CSSContainerRule) return 'ContainerRule';
  if (rule instanceof CSSLayerBlockRule) return 'LayerRule';
  if (rule instanceof CSSScopeRule) return 'ScopeRule';
  if (rule instanceof CSSStartingStyleRule) return 'StartingStyleRule';
  return null;
}

/** The prelude of @scope as Chrome reports it: `(.a) to (.b)`. */
function scopeText(rule: CSSScopeRule): string {
  const start = rule.start === null ? '' : `(${rule.start})`;
  const end = rule.end === null ? '' : `to (${rule.end})`;
  return [start, end].filter(Boolean).join(' ');
}

/** Cascade layer keys: dotted names are split, and anonymous layers get unique keys. */
const anonymousLayers = new WeakMap<CSSRule, string>();
let anonymousLayerSeq = 0;
function layerKeys(name: string | null, owner: CSSRule): string[] {
  if (name) return name.split('.').map(n => n.trim());
  let key = anonymousLayers.get(owner);
  if (!key) {
    key = `\u0002${++anonymousLayerSeq}`;
    anonymousLayers.set(owner, key);
  }
  return [key];
}

/** The layer an @import-ed sheet is in, outermost first. */
function importedLayer(sheet: CSSStyleSheet): string[] {
  const owner = sheet.ownerRule;
  if (!(owner instanceof CSSImportRule) || !owner.parentStyleSheet) return [];
  const outer = importedLayer(owner.parentStyleSheet);
  return owner.layerName === null ? outer : [...outer, ...layerKeys(owner.layerName, owner)];
}

/**
 * Whether a sheet's own conditions hold: the media of its <link>, <style> or @import, and the
 * supports() of its @import, up through the sheets that import it.
 */
function sheetApplies(sheet: CSSStyleSheet): boolean {
  for (let s: CSSStyleSheet | null = sheet; s; s = s.ownerRule?.parentStyleSheet ?? null) {
    if (s.media.mediaText && !matchMedia(s.media.mediaText).matches) return false;
    const owner = s.ownerRule;
    if (owner instanceof CSSImportRule && owner.supportsText && !CSS.supports(owner.supportsText)) {
      return false;
    }
  }
  return true;
}

/**
 * Tracks the page's style sheets. Every style rule gets a stable id within its sheet, which
 * also serves as its line in the text served by CSS.getStyleSheetText (one rule per line),
 * so ranges the client sends back keep pointing at the same rule even if the page adds or
 * removes rules in between.
 */
class SheetRegistry {
  private sheetIds = new WeakMap<CSSStyleSheet, string>();
  /** Weak, so that sheets the page drops can be collected. */
  private sheets = new Map<string, WeakRef<CSSStyleSheet>>();
  private ruleIds = new WeakMap<StyleRule, number>();
  private nextRuleId = new WeakMap<CSSStyleSheet, number>();
  private seq = 0;
  inspectorSheet: CSSStyleSheet | null = null;
  /** Whether a sheet is ours rather than the page's (forced pseudo-class companions). */
  isOwnSheet: (sheet: CSSStyleSheet) => boolean = () => false;
  /** Whether a <style> came from the HTML parser rather than from a script. */
  fromParser: (style: HTMLStyleElement) => boolean = () => true;

  constructor(
    private fetch: typeof window.fetch,
    private shadowRoots: () => ShadowRoot[]
  ) {}

  idOf(sheet: CSSStyleSheet): string {
    let id = this.sheetIds.get(sheet);
    if (!id) {
      id = `sheet-${++this.seq}`;
      this.sheetIds.set(sheet, id);
      this.sheets.set(id, new WeakRef(sheet));
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
    this.sheets.set(id, new WeakRef(replacement));
    if (this.inspectorSheet === sheet) this.inspectorSheet = replacement;
  }

  get(styleSheetId: string): CSSStyleSheet {
    const sheet = this.sheets.get(styleSheetId)?.deref();
    if (!sheet) {
      this.sheets.delete(styleSheetId);
      throw new CdpError('No style sheet with given id found');
    }
    return sheet;
  }

  /**
   * The document and the shadow roots with their top-level style sheets in cascade order: those
   * of <style> and <link>, then adopted ones.
   */
  trees(): { tree: TreeScope; sheets: CSSStyleSheet[] }[] {
    if (this.memo?.trees) return this.memo.trees;
    const result: { tree: TreeScope; sheets: CSSStyleSheet[] }[] = [];
    for (const tree of [document, ...this.shadowRoots()]) {
      const list: CSSStyleSheet[] = [];
      for (const sheet of Array.from(tree.styleSheets)) {
        // devtools-anywhere's own sheets are not the page's.
        const owner = sheet.ownerNode;
        if (owner && isOwn(owner) && sheet !== this.inspectorSheet) continue;
        list.push(sheet);
      }
      for (const sheet of adoptedOf(tree)) if (!this.isOwnSheet(sheet)) list.push(sheet);
      if (list.length) result.push({ tree, sheets: list });
    }
    if (this.memo) this.memo.trees = result;
    return result;
  }

  /** Sheets looked up once for all of a request (see `batch`). */
  private memo: {
    trees?: { tree: TreeScope; sheets: CSSStyleSheet[] }[];
    scoped?: { sheet: CSSStyleSheet; tree: TreeScope }[];
  } | null = null;

  /** Runs `fn` looking up the page's sheets only once: the page does not change them meanwhile. */
  async batch<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.memo) return fn();
    this.memo = {};
    try {
      return await fn();
    } finally {
      this.memo = null;
    }
  }

  /** Style sheets, including @import-ed ones, with the tree they apply to, in cascade order. */
  scoped(): { sheet: CSSStyleSheet; tree: TreeScope }[] {
    if (this.memo?.scoped) return this.memo.scoped;
    const result: { sheet: CSSStyleSheet; tree: TreeScope }[] = [];
    for (const { tree, sheets } of this.trees()) {
      const visit = (sheet: CSSStyleSheet) => {
        result.push({ sheet, tree });
        for (const rule of this.rulesOf(sheet))
          if (rule instanceof CSSImportRule && rule.styleSheet) visit(rule.styleSheet);
      };
      sheets.forEach(visit);
    }
    if (this.memo) this.memo.scoped = result;
    return result;
  }

  /** Style sheets, including @import-ed ones, that we can read. */
  all(): CSSStyleSheet[] {
    return Array.from(new Set(this.scoped().map(s => s.sheet)));
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

  ruleId(sheet: CSSStyleSheet, rule: StyleRule): number {
    let id = this.ruleIds.get(rule);
    if (id === undefined) {
      id = this.nextRuleId.get(sheet) ?? 0;
      this.nextRuleId.set(sheet, id + 1);
      this.ruleIds.set(rule, id);
    }
    return id;
  }

  /**
   * Style rules of a sheet in order, nested ones (and nested declarations) after their parent.
   * `onlyActive` leaves out rules in @media and @supports that do not apply and in
   * @starting-style. `layers` collects the keys of cascade layers in order of first
   * appearance (a layer's key joins its path with \u0001), which is their cascade order.
   */
  entries(sheet: CSSStyleSheet, onlyActive = false, layers?: Map<string, number>): Entry[] {
    const result: Entry[] = [];
    const declare = (path: string[]) => {
      if (!layers) return;
      for (let i = 1; i <= path.length; i++) {
        const key = path.slice(0, i).join('\u0001');
        if (!layers.has(key)) layers.set(key, layers.size);
      }
    };
    const visit = (rules: CSSRule[], layer: string[]) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          this.ruleId(sheet, rule);
          result.push({ rule, layer });
          visit(this.rulesOf(rule), layer);
        } else if (rule instanceof CSSNestedDeclarations) {
          this.ruleId(sheet, rule);
          result.push({ rule, layer });
        } else if (rule instanceof CSSMediaRule) {
          if (onlyActive && !matchMedia(rule.conditionText).matches) continue;
          visit(this.rulesOf(rule), layer);
        } else if (rule instanceof CSSSupportsRule) {
          if (onlyActive && !CSS.supports(rule.conditionText)) continue;
          visit(this.rulesOf(rule), layer);
        } else if (rule instanceof CSSStartingStyleRule) {
          if (!onlyActive) visit(this.rulesOf(rule), layer);
        } else if (rule instanceof CSSLayerBlockRule) {
          const path = [...layer, ...layerKeys(rule.name, rule)];
          declare(path);
          visit(this.rulesOf(rule), path);
        } else if (rule instanceof CSSLayerStatementRule) {
          for (const name of rule.nameList) declare([...layer, ...layerKeys(name, rule)]);
        } else if (rule instanceof CSSGroupingRule) {
          visit(this.rulesOf(rule), layer);
        }
      }
    };
    const layer = importedLayer(sheet);
    declare(layer);
    visit(this.rulesOf(sheet), layer);
    return result;
  }

  findRule(sheet: CSSStyleSheet, line: number): StyleRule {
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
      lines[id] = `${selectorLabel(rule)} { ${buildStyle('', rule.style, 0, 0).cssText} }`;
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
    const constructed = isConstructed(sheet);
    // Like Chrome, sheets in shadow trees, constructed ones and those of a <style> a script
    // inserted have no source URL and are not inline.
    const owner = sheet.ownerNode;
    const local =
      constructed ||
      owner?.getRootNode() instanceof ShadowRoot ||
      (owner instanceof HTMLStyleElement && !this.fromParser(owner));
    return {
      styleSheetId: this.idOf(sheet),
      frameId: FRAME_ID,
      sourceURL: sheet.href ?? (isInspector || local ? '' : location.href),
      origin: this.origin(sheet),
      title: sheet.title ?? '',
      disabled: sheet.disabled,
      isInline: !sheet.href && !isInspector && !local,
      isMutable: isInspector || constructed,
      isConstructed: constructed,
      ...(constructed && { loadingFailed: false }),
      startLine: 0,
      startColumn: 0,
      length: text.length,
      endLine: lines.length - 1,
      endColumn: lines.at(-1)?.length ?? 0,
    };
  }
}

/** A sheet made with `new CSSStyleSheet()`. */
function isConstructed(sheet: CSSStyleSheet): boolean {
  let top = sheet;
  while (top.ownerRule?.parentStyleSheet) top = top.ownerRule.parentStyleSheet;
  return !top.ownerNode && !top.ownerRule;
}

/** Channels of a computed `rgb()` / `rgba()` color, or null for other notations. */
function rgba(value: string): [number, number, number, number] | null {
  const match = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
}

type RGBA = [number, number, number, number];
/** A color: its channels, or for one in another color space (`oklch()`, `color()`...) its text, which Chrome reports as is. */
type Color = RGBA | string;

/** Computed colors: rgb() and the notations Chrome keeps for other color spaces. */
const COLOR = /\b(?:rgba?|color|lab|lch|oklab|oklch)\([^()]*\)/g;

/** A computed color, or null for a translucent one outside sRGB, which we cannot blend. */
function parseColor(value: string): Color | null {
  const channels = rgba(value);
  if (channels) return channels;
  const alpha = /\/\s*([\d.]+)(%?)\s*\)$/.exec(value);
  if (alpha && Number(alpha[1]) / (alpha[2] ? 100 : 1) < 1) return null;
  return value;
}

const isOpaque = (c: Color) => typeof c === 'string' || c[3] >= 1;

/**
 * The colors of one element's background, topmost last: its color, then the stops of its
 * topmost gradient (like Chrome, the layers below it are not looked at). null when an image
 * makes the background unknown.
 */
function backgroundLayers(style: CSSStyleDeclaration): Color[][] | null {
  const layers: Color[][] = [];
  const color = parseColor(style.backgroundColor);
  if (!color) return null;
  if (typeof color === 'string' || color[3] > 0) layers.push([color]);
  const image = style.backgroundImage;
  if (image !== 'none') {
    const top = splitTopLevel(image, ',')[0]?.trim() ?? '';
    if (!/^(?:repeating-)?(?:linear|radial|conic)-gradient\(.*\)$/.test(top)) return null;
    const stops: Color[] = [];
    for (const [stop] of top.matchAll(COLOR)) {
      const c = parseColor(stop);
      if (!c) return null;
      stops.push(c);
    }
    if (!stops.length) return null;
    layers.push(stops);
  }
  return layers;
}

/**
 * The colors text is drawn on, as Chrome reports them: translucent backgrounds are blended over
 * those of the ancestors (down to the white page), each stop of a gradient giving a color of its
 * own; null when an image makes them unknown.
 */
function backgroundsBehind(el: Element, style: CSSStyleDeclaration): string[] | null {
  const layers: Color[][] = [];
  for (let node: Element | null = el, s = style; node;) {
    const own = backgroundLayers(s);
    if (!own) return null;
    layers.unshift(...own);
    // The topmost opaque layer hides what is below it.
    if (own.some(layer => layer.every(isOpaque))) break;
    node = parentOf(node);
    if (node) s = getComputedStyle(node);
  }
  let opaque = 0;
  layers.forEach((layer, i) => {
    if (layer.every(isOpaque)) opaque = i;
  });
  let colors: ([number, number, number] | string)[] = [[255, 255, 255]];
  for (const layer of layers.slice(opaque)) {
    const next: ([number, number, number] | string)[] = [];
    for (const below of colors)
      for (const c of layer) {
        if (typeof c === 'string' || c[3] >= 1) {
          next.push(typeof c === 'string' ? c : [c[0], c[1], c[2]]);
          continue;
        }
        // A translucent stop over a color outside sRGB: not blended, like an opaque one would hide it.
        if (typeof below === 'string') return null;
        const [lr, lg, lb, la] = c;
        const [r, g, b] = below;
        next.push([lr * la + r * (1 - la), lg * la + g * (1 - la), lb * la + b * (1 - la)]);
      }
    colors = next;
  }
  // Chrome truncates the blended channels. (It rounds them for a stop written in the modern
  // `rgb(0 0 0 / 0.5)` syntax, which the computed style does not tell from `rgba(0, 0, 0, 0.5)`.)
  const result = colors.map(c =>
    typeof c === 'string' ? c : `rgb(${Math.floor(c[0])}, ${Math.floor(c[1])}, ${Math.floor(c[2])})`
  );
  return Array.from(new Set(result));
}

/** Expressions of a media query list, as Chrome reports them in `mediaList`. */
function mediaList(text: string): Protocol.CSS.MediaQuery[] {
  return splitTopLevel(text, ',').map(query => {
    const expressions: Protocol.CSS.MediaQueryExpression[] = [];
    for (const m of query.matchAll(/\(\s*([\w-]+)\s*:\s*(-?[\d.]+)([a-z%]*)\s*\)/gi)) {
      const value = Number(m[2]);
      const unit = (m[3] ?? '').toLowerCase();
      // In media queries em and rem are relative to the initial font size (medium, 16px by
      // default), not to the font size of the root element.
      const scale = unit === 'px' ? 1 : unit === 'em' || unit === 'rem' ? 16 : null;
      expressions.push({
        value,
        unit,
        feature: (m[1] ?? '').toLowerCase(),
        ...(scale !== null && { computedLength: value * scale }),
      });
    }
    return { expressions, active: matchMedia(query.trim()).matches };
  });
}

/**
 * The source of a <style>, in two versions of the same length (indices are shared): `text`
 * without comments, to match selectors in (they may quote attribute values), and `braces`
 * also without strings and url(), where braces delimit blocks. Located rules are cached.
 */
interface Source {
  text: string;
  braces: string;
  located: WeakMap<CSSStyleRule, Located | null>;
}

interface Located {
  selectors: string[];
  open: number;
  close: number;
}

/** The source last read, kept while the <style> text does not change. */
let lastSource: { raw: string; source: Source } | null = null;

const blank = (m: string) => ' '.repeat(m.length);

function sourceOf(sheet: CSSStyleSheet): Source | null {
  const owner = sheet.ownerNode;
  if (!(owner instanceof HTMLStyleElement) || owner.sheet !== sheet) return null;
  const raw = owner.textContent;
  if (lastSource?.raw !== raw) {
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, blank);
    const braces = text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|url\([^)]*\)/gi, blank);
    lastSource = { raw, source: { text, braces, located: new WeakMap() } };
  }
  return lastSource.source;
}

/** A pattern for a selector, allowing any white space between its tokens. */
function selectorPattern(selector: string): string {
  return selector
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s*([>~]|\\\+)\s*/g, '\\s*$1\\s*')
    .replace(/ +/g, '\\s+');
}

/** The index of the `}` closing the block whose `{` is at `open`. */
function blockEnd(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return i;
  }
  return source.length;
}

/**
 * Where a style rule is in the source, as written: its selectors and the range of its block
 * (from its `{` to its `}`). Nested rules are looked for in the block of their parent only.
 */
function locate(source: Source, rule: CSSStyleRule): Located | null {
  const cached = source.located.get(rule);
  if (cached !== undefined) return cached;
  const result = find(source, rule);
  source.located.set(rule, result);
  return result;
}

function find(source: Source, rule: CSSStyleRule): Located | null {
  const parts = splitTopLevel(rule.selectorText, ',').map(p => p.trim());
  const parent = nestingParent(rule);
  let from = 0;
  let to = source.text.length;
  if (parent) {
    if (!(parent instanceof CSSStyleRule)) return null;
    const outer = locate(source, parent);
    if (!outer) return null;
    from = outer.open;
    to = outer.close;
  }
  // The CSSOM adds the `&` an author may leave out: `.x` becomes `& .x`.
  const pattern = parts
    .map(p => (parent && p.startsWith('& ') ? `(&\\s+)?${selectorPattern(p.slice(2))}` : `()${selectorPattern(p)}`))
    .join('\\s*,\\s*');
  const m = new RegExp(`(?:^|[{;}])\\s*${pattern}\\s*\\{`, 'y');
  for (let i = from; i < to; i++) {
    // Rules start after a delimiter outside strings.
    if (i > from && !/[{;}]/.test(source.braces[i] ?? '')) continue;
    m.lastIndex = i;
    const match = m.exec(source.text);
    if (!match) continue;
    const open = i + match[0].length - 1;
    return {
      selectors: parts.map((p, k) => (parent && p.startsWith('& ') && !match[k + 1] ? p.slice(2) : p)),
      open,
      close: blockEnd(source.braces, open),
    };
  }
  return null;
}

/**
 * Nested selectors as written in the source, where Chrome shows them so. null when the source
 * is unknown (a <link>, a constructed sheet) or the rule is not found in it.
 */
function sourceSelectors(sheet: CSSStyleSheet, rule: CSSStyleRule, parts: string[]): string[] | null {
  if (!(nestingParent(rule) instanceof CSSStyleRule)) return null;
  if (!parts.some(p => p.startsWith('& '))) return null;
  const source = sourceOf(sheet);
  return source === null ? null : (locate(source, rule)?.selectors ?? null);
}

/**
 * Rules of a shadow tree for its host: the selector is `:host`, `:host(<arg>)` or
 * `:host-context(<arg>)` and pseudo-classes. Returns whether a host matches, or null.
 */
function hostMatcher(selector: string): ((host: Element) => boolean) | null {
  let matcher = hostMatchers.get(selector);
  if (matcher === undefined) hostMatchers.set(selector, (matcher = parseHost(selector)));
  return matcher;
}

/** Host matchers by selector. */
const hostMatchers = new Map<string, ((host: Element) => boolean) | null>();

function parseHost(selector: string): ((host: Element) => boolean) | null {
  const m = /^:host(-context)?(?:\((.*)\))?(.*)$/.exec(selector);
  if (!m) return null;
  const arg = m[2];
  const rest = m[3] ?? '';
  if (/[\s>+~]/.test(rest.replace(/\([^)]*\)/g, ''))) return null;
  if (!m[1]) {
    const own = `${arg ? `:is(${arg})` : '*'}${rest}`;
    return host => host.matches(own);
  }
  if (!arg) return null;
  // The host or any of its ancestors, across shadow boundaries.
  return host => {
    if (!host.matches(`*${rest}`)) return false;
    for (let node: Element | null = host; node;) {
      if (node.matches(arg)) return true;
      const parent: Node | null = node.parentNode;
      node = parent instanceof ShadowRoot ? parent.host : parent instanceof Element ? parent : null;
    }
    return false;
  };
}

export function registerCss(ctx: Context) {
  const { server, nodes } = ctx;
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
    for (const sheet of current) if (!known.has(sheet)) server.emit('CSS.styleSheetAdded', { header: header(sheet) });
    for (const sheet of known)
      if (!current.has(sheet)) server.emit('CSS.styleSheetRemoved', { styleSheetId: sheets.idOf(sheet) });
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
    sheets.loadCopies(sheet => server.emit('CSS.styleSheetChanged', { styleSheetId: sheets.idOf(sheet) }));

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
    // A pseudo-element's own element can be its container.
    const containerStart = pseudo ? el : parentOf(el);
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

  server.register('CSS', {
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
        server.emit('CSS.styleSheetAdded', { header: header(style.sheet) });
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
