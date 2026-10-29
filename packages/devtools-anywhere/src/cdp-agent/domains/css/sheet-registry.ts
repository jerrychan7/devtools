import type { Protocol } from 'devtools-protocol';
import { FRAME_ID } from '../../core/context';
import { isOwn } from '../../core/nodes';
import { CdpError } from '../../core/session';
import { adoptedOf } from '../../core/adopted';
import { type TreeScope } from './forced-pseudo';
import { type Entry, type StyleRule, importedLayer, layerKeys, selectorLabel } from './rules';
import { type StyleOrigin, buildStyle } from './style';

/**
 * Tracks the page's style sheets. Every style rule gets a stable id within its sheet, which
 * also serves as its line in the text served by CSS.getStyleSheetText (one rule per line),
 * so ranges the client sends back keep pointing at the same rule even if the page adds or
 * removes rules in between.
 */
export class SheetRegistry {
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

  private fetch: typeof window.fetch;
  private shadowRoots: () => ShadowRoot[];

  constructor(fetch: typeof window.fetch, shadowRoots: () => ShadowRoot[]) {
    this.fetch = fetch;
    this.shadowRoots = shadowRoots;
  }

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
export function isConstructed(sheet: CSSStyleSheet): boolean {
  let top = sheet;
  while (top.ownerRule?.parentStyleSheet) top = top.ownerRule.parentStyleSheet;
  return !top.ownerNode && !top.ownerRule;
}
