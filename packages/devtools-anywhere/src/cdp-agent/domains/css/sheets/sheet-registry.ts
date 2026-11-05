import type { Protocol } from 'devtools-protocol';
import { isCssom, isHtml, isShadowRoot } from '../../../core/realm';
import type { FrameRegistry } from '../../../core/frames/frames';
import { isOwn } from '../../../core/nodes/nodes';
import { CdpError } from '../../../core/session';
import { adoptedOf } from '../../../core/nodes/adopted';
import { type TreeScope } from '../matching/forced-pseudo';
import { type Entry, type StyleRule, importedLayer, layerKeys, realmOfSheet, selectorLabel } from '../matching/rules';
import { type StyleOrigin, buildStyle } from '../style';
import { type SheetSource, SheetTexts, offsetsOf, selectorSpans, styleSpan } from './sheet-text';
import { type CssRule, outline } from './css-outline';
import { lineStarts } from './text-lines';

/** Chrome's error for a range that is not that of what an edit changes. */
export const RANGE_MISMATCH = "NotFoundError Source range didn't match existing source range";
/** Chrome's, for a style's range (setStyleTexts), and for a range past the text's end. */
export const STYLE_MISMATCH = "NotFoundError Source range didn't match existing style source range";
export const OUT_OF_BOUNDS = 'Specified range is out of bounds';

/** Throws Chrome's error for a range that starts past its end, before any other check. */
export function assertOrdered(range: Protocol.CSS.SourceRange): void {
  if (range.startLine > range.endLine || (range.startLine === range.endLine && range.startColumn > range.endColumn))
    throw new CdpError('Range start must not succeed its end');
}

/** A rule with a style of its own (setStyleTexts edits it). */
export type Styled = StyleRule | CSSKeyframeRule;

/**
 * Tracks the page's style sheets. Every style rule gets a stable id within its sheet, which
 * also serves as its line in the text served by CSS.getStyleSheetText (one rule per line),
 * so ranges the client sends back keep pointing at the same rule even if the page adds or
 * removes rules in between.
 */
/**
 * What every style sheet id starts with: '' or `m{ns}.` in a page whose agent is merged into its
 * parent's (core/frames/merged-frames.ts).
 */
let idPrefix = '';

/** Sets what the style sheet ids of every session start with (see {@link idPrefix}). */
export function setSheetIdPrefix(prefix: string): void {
  idPrefix = prefix;
}

export class SheetRegistry {
  private sheetIds = new WeakMap<CSSStyleSheet, string>();
  /** Weak, so that sheets the page drops can be collected. */
  private sheets = new Map<string, WeakRef<CSSStyleSheet>>();
  private ruleIds = new WeakMap<StyleRule, number>();
  private nextRuleId = new WeakMap<CSSStyleSheet, number>();
  private seq = 0;
  /** Inspector style sheets (CSS.createStyleSheet), in any frame. */
  private inspectorSheets = new WeakSet<CSSStyleSheet>();
  /** The inspector style sheet each document reuses (one made without `force`). */
  private inspectorOfDocument = new WeakMap<Document, CSSStyleSheet>();
  /** Whether a sheet is ours rather than the page's (forced pseudo-class companions). */
  isOwnSheet: (sheet: CSSStyleSheet) => boolean = () => false;
  /** Whether a <style> came from the HTML parser rather than from a script. */
  fromParser: (style: HTMLStyleElement) => boolean = () => true;

  private fetch: typeof globalThis.fetch;
  private shadowRoots: () => ShadowRoot[];
  private frames: FrameRegistry;
  /** The texts sheets were written in. */
  readonly texts = new SheetTexts(sheet => this.rulesOf(sheet));

  constructor(fetch: typeof globalThis.fetch, shadowRoots: () => ShadowRoot[], frames: FrameRegistry) {
    this.fetch = fetch;
    this.shadowRoots = shadowRoots;
    this.frames = frames;
  }

  /** The window whose document the sheet belongs to ({@link realmOfSheet}). */
  realmOf(sheet: CSSStyleSheet): Window & typeof globalThis {
    return realmOfSheet(sheet, this.frames);
  }

  idOf(sheet: CSSStyleSheet): string {
    let id = this.sheetIds.get(sheet);
    if (!id) {
      id = `${idPrefix}sheet-${++this.seq}`;
      this.sheetIds.set(sheet, id);
      this.sheets.set(id, new WeakRef(sheet));
    }
    return id;
  }

  /** Like Chrome, a sheet removed (or replaced: a new text, href) is gone with its id. */
  forget(sheet: CSSStyleSheet): void {
    const id = this.sheetIds.get(sheet);
    if (id) this.sheets.delete(id);
    this.sheetIds.delete(sheet);
  }

  isInspector(sheet: CSSStyleSheet): boolean {
    return this.inspectorSheets.has(sheet);
  }

  /** The inspector style sheet `doc` reuses, while its <style> is in the document. */
  inspectorOf(doc: Document): CSSStyleSheet | null {
    const sheet = this.inspectorOfDocument.get(doc);
    return sheet?.ownerNode?.isConnected ? sheet : null;
  }

  /** Takes `sheet` for an inspector style sheet of `doc`, the one it reuses unless `force`d. */
  addInspector(sheet: CSSStyleSheet, doc: Document, force: boolean) {
    this.inspectorSheets.add(sheet);
    if (!force) this.inspectorOfDocument.set(doc, sheet);
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
   * The documents of the frames and the shadow roots with their top-level style sheets in
   * cascade order: those of <style> and <link>, then adopted ones. Like Chrome, each same-origin
   * iframe's document has sheets of its own, which apply only to it.
   */
  trees(): { tree: TreeScope; sheets: CSSStyleSheet[] }[] {
    if (this.memo?.trees) return this.memo.trees;
    const result: { tree: TreeScope; sheets: CSSStyleSheet[] }[] = [];
    for (const tree of [...Array.from(this.frames, f => f.document), ...this.shadowRoots()]) {
      const list: CSSStyleSheet[] = [];
      for (const sheet of Array.from(tree.styleSheets)) {
        // devtools-anywhere's own sheets are not the page's.
        const owner = sheet.ownerNode;
        if (owner && isOwn(owner) && !this.isInspector(sheet)) continue;
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
          if (isCssom(rule, 'CSSImportRule') && rule.styleSheet) visit(rule.styleSheet);
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
      const copy = isCssom(sheet, 'CSSStyleSheet') ? this.copies.get(sheet) : null;
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

  /** Whether the sheet's rules cannot be read: from another origin, without a copy. */
  isUnreadable(sheet: CSSStyleSheet): boolean {
    try {
      void sheet.cssRules;
      return false;
    } catch {
      return !this.copies.get(sheet);
    }
  }

  /**
   * Fetches the texts of the sheets of files not loaded yet (from the HTTP cache, mostly), and
   * makes copies of the cross-origin ones from theirs; resolves when all are done.
   */
  loadCopies(onLoaded: (sheet: CSSStyleSheet) => void): Promise<void> {
    for (const sheet of this.all()) {
      const href = sheet.href;
      if (!href || this.texts.has(sheet) || this.copies.has(sheet) || this.loading.has(sheet)) continue;
      let readable = true;
      try {
        void sheet.cssRules;
      } catch {
        readable = false;
      }
      const load = this.fetch(href, readable ? { cache: 'force-cache' } : { credentials: 'omit' })
        .then(res => (res.ok ? res.text() : Promise.reject(new Error(res.statusText))))
        .then(text => {
          if (!readable) {
            const copy = new CSSStyleSheet();
            copy.replaceSync(text);
            this.copies.set(sheet, copy);
          }
          this.texts.set(sheet, text, true);
          // A readable sheet's rules were there already: only a copy brings new ones.
          if (!readable) onLoaded(sheet);
        })
        // Not tried again: a readable sheet keeps its serialized text.
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
        if (isCssom(rule, 'CSSStyleRule')) {
          this.ruleId(sheet, rule);
          result.push({ rule, layer });
          visit(this.rulesOf(rule), layer);
        } else if (isCssom(rule, 'CSSNestedDeclarations')) {
          this.ruleId(sheet, rule);
          result.push({ rule, layer });
        } else if (isCssom(rule, 'CSSMediaRule')) {
          if (onlyActive && !this.realmOf(sheet).matchMedia(rule.conditionText).matches) continue;
          visit(this.rulesOf(rule), layer);
        } else if (isCssom(rule, 'CSSSupportsRule')) {
          if (onlyActive && !CSS.supports(rule.conditionText)) continue;
          visit(this.rulesOf(rule), layer);
        } else if (isCssom(rule, 'CSSStartingStyleRule')) {
          if (!onlyActive) visit(this.rulesOf(rule), layer);
        } else if (isCssom(rule, 'CSSLayerBlockRule')) {
          const path = [...layer, ...layerKeys(rule.name, rule)];
          declare(path);
          visit(this.rulesOf(rule), path);
        } else if (isCssom(rule, 'CSSLayerStatementRule')) {
          for (const name of rule.nameList) declare([...layer, ...layerKeys(name, rule)]);
        } else if (isCssom(rule, 'CSSGroupingRule')) {
          visit(this.rulesOf(rule), layer);
        }
      }
    };
    const layer = importedLayer(sheet);
    declare(layer);
    visit(this.rulesOf(sheet), layer);
    return result;
  }

  /**
   * The rule whose style (`style`) or selectors (`selector`) are at `range`: in the text the
   * sheet was written in, or in the serialized one, where a rule's line is its id.
   */
  findRule(sheet: CSSStyleSheet, range: Protocol.CSS.SourceRange, at: 'style' | 'selector'): Styled {
    assertOrdered(range);
    const source = this.sourceOf(sheet);
    // A text this session has, whose rules no longer pair with the sheet's (another session
    // replaced them). As measured in Chrome 156, the style rules of the old text stand for those
    // of the sheet in order: the n-th one's range is the n-th style rule's, if there is one.
    const old = !source && this.texts.unpaired(sheet) ? this.texts.textOf(sheet) : null;
    if (old !== null) {
      const fail = () => new CdpError(at === 'style' ? STYLE_MISMATCH : RANGE_MISMATCH);
      const offsets = offsetsOf({ text: old, lines: lineStarts(old), nodes: new Map(), top: [] }, range);
      if (!offsets) throw new CdpError(OUT_OF_BOUNDS);
      const written: CssRule[] = [];
      const walk = (list: CssRule[]) =>
        list.forEach(n => {
          if (n.kind === 'qualified' && n.blockStart >= 0) written.push(n);
          walk(n.rules);
        });
      walk(outline(old));
      const n = written.findIndex(node => {
        const spans = selectorSpans(old, node);
        const [s, e] = at === 'style' ? styleSpan(old, node) : [spans[0]?.[0], spans[spans.length - 1]?.[1]];
        return s === offsets[0] && e === offsets[1];
      });
      const rule = n < 0 ? undefined : this.entries(sheet).filter(e => isCssom(e.rule, 'CSSStyleRule'))[n]?.rule;
      if (!rule) throw fail();
      return rule;
    }
    if (!source) {
      const entry = this.entries(sheet).find(e => this.ruleIds.get(e.rule) === range.startLine);
      if (!entry) throw new CdpError('No rule at given range');
      return entry.rule;
    }
    const offsets = offsetsOf(source, range);
    if (!offsets) throw new CdpError(OUT_OF_BOUNDS);
    for (const [rule, node] of source.nodes) {
      const styled =
        isCssom(rule, 'CSSStyleRule') ||
        isCssom(rule, 'CSSNestedDeclarations') ||
        (at === 'style' && isCssom(rule, 'CSSKeyframeRule'));
      if (!styled) continue;
      // Selectors are only tokenized for a rule whose prelude starts there.
      if (at === 'selector' && node.preludeStart !== offsets[0]) continue;
      const spans = at === 'selector' ? selectorSpans(source.text, node) : [];
      const [start, end] =
        at === 'style' ? styleSpan(source.text, node) : [spans[0]?.[0] ?? -1, spans[spans.length - 1]?.[1] ?? -1];
      if (start === offsets[0] && end === offsets[1] && (at === 'style' || node.kind === 'qualified')) return rule;
    }
    throw new CdpError(at === 'style' ? STYLE_MISMATCH : RANGE_MISMATCH);
  }

  /** The text the sheet was written in, with its rules in it; null when unknown. */
  sourceOf(sheet: CSSStyleSheet): SheetSource | null {
    return this.texts.source(sheet);
  }

  /**
   * The text of a sheet: the one it was written in, or one serialized from its rules. As in
   * Chrome 156, after another session replaced the rules this one keeps the text it had.
   */
  text(sheet: CSSStyleSheet): string {
    const source = this.sourceOf(sheet);
    if (source) return source.text;
    return (this.texts.unpaired(sheet) ? this.texts.textOf(sheet) : null) ?? this.serialized(sheet);
  }

  /** The text of a sheet with every style rule on the line of its id. */
  serialized(sheet: CSSStyleSheet): string {
    const lines: string[] = [];
    for (const { rule } of this.entries(sheet)) {
      const id = this.ruleId(sheet, rule);
      while (lines.length < id) lines.push('');
      lines[id] = `${selectorLabel(rule)} { ${buildStyle('', rule.style, 0, 0).cssText} }`;
    }
    return lines.join('\n');
  }

  /** The URL the rules of a sheet come from: its own, or the base URL of its document. */
  sourceURL(sheet: CSSStyleSheet): string {
    return sheet.href ?? sheet.ownerNode?.baseURI ?? this.realmOf(sheet).document.baseURI;
  }

  origin(sheet: CSSStyleSheet): StyleOrigin {
    return this.isInspector(sheet) ? 'inspector' : 'regular';
  }

  header(sheet: CSSStyleSheet): Protocol.CSS.CSSStyleSheetHeader {
    const text = this.text(sheet);
    const lines = text.split('\n');
    // Like Chrome, a <style> starts at the start of its text, not where it is in the document's
    // source (which would need the document fetched again).
    const isInspector = this.isInspector(sheet);
    const constructed = isConstructed(sheet);
    // Like Chrome, sheets in shadow trees, constructed ones and those of a <style> a script
    // inserted have no source URL and are not inline. The others name the frame they are in, and
    // inline ones the base URL of its document: like Chrome, that of the parent for a srcdoc
    // iframe (Chrome takes the base URL the sheet was parsed with, ours is the current one).
    const owner = sheet.ownerNode;
    const local =
      constructed ||
      (owner && isShadowRoot(owner.getRootNode())) ||
      (isHtml(owner, 'style') && !this.fromParser(owner));
    return {
      styleSheetId: this.idOf(sheet),
      frameId: this.frames.ofWindow(this.realmOf(sheet)).id,
      sourceURL: sheet.href ?? (isInspector || local || !owner ? '' : owner.baseURI),
      origin: this.origin(sheet),
      title: sheet.title ?? '',
      disabled: sheet.disabled,
      isInline: !sheet.href && !isInspector && !local,
      isMutable: isInspector || constructed,
      isConstructed: constructed,
      // Like Chrome, for constructed sheets and those of files.
      ...((constructed || !!sheet.href) && { loadingFailed: false }),
      startLine: 0,
      startColumn: 0,
      length: text.length,
      endLine: lines.length - 1,
      endColumn: lines.at(-1)?.length ?? 0,
    };
  }
}

/** A sheet made with `new CSSStyleSheet()`. */
export function isConstructed(sheet: CSSStyleSheet): boolean {
  let top = sheet;
  while (top.ownerRule?.parentStyleSheet) top = top.ownerRule.parentStyleSheet;
  return !top.ownerNode && !top.ownerRule;
}
