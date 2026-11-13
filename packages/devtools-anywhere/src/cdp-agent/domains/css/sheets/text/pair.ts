// Pairing a sheet's text with its CSSOM rules: the text is outlined (css-outline.ts) and each
// CSSOM rule found at the node it was written as, comparing kinds, at-rule names and preludes
// (selectors loosened to what the CSSOM writes back). Gives the SheetSource the other modules of
// this directory read and update.
import { isCssom } from '../../../../core/realm';
import { ownCall, ownStyle } from '../watch/cssom-watch';
import { type CssOutline, ROOT } from '../parse/css-outline';
import { outline } from '../parse/css-outline-wasm';
import { atName, loose } from './loose';
import { cssSupports } from './commented';
import { lineStarts } from './text-lines';

/**
 * The text a style sheet was written in, as Chrome serves it: that of its <style>, of its file
 * (fetched again), or the one a script gave replace() or replaceSync(), kept up to date by the
 * CSS domain's own edits. Its rules are found in it by css-outline.ts and paired with the CSSOM's
 * in order; when that fails, or the page changed the sheet through the CSSOM since, there is
 * none and the CSS domain falls back to a text serialized from the CSSOM.
 */
export interface SheetSource {
  text: string;
  lines: number[];
  /** The text's outline: its rules are the nodes below. */
  outline: CssOutline;
  /** The outline node (rule index) each CSSOM rule was written as. */
  nodes: Map<CSSRule, number>;
  /** The top-level rules, in the order of the text. */
  topRules: CSSRule[];
  /** The node of each of `topRules`, at the same index: no object for each pair. */
  topNodes: number[];
  /**
   * The sheet's @namespace rules as the CSSOM serializes them: a selector parsed alone is parsed
   * after them, so that its namespace prefixes are declared.
   */
  namespaces: string;
}

/** The at-rule name each kind of CSSOM rule is written with; a kind not listed pairs with none. */
const AT_NAMES: Record<string, string> = {
  CSSMediaRule: 'media',
  CSSSupportsRule: 'supports',
  CSSContainerRule: 'container',
  CSSLayerBlockRule: 'layer',
  CSSLayerStatementRule: 'layer',
  CSSScopeRule: 'scope',
  CSSStartingStyleRule: 'starting-style',
  CSSImportRule: 'import',
  CSSNamespaceRule: 'namespace',
  CSSFontFaceRule: 'font-face',
  CSSKeyframesRule: 'keyframes',
  CSSPageRule: 'page',
  CSSPropertyRule: 'property',
  CSSCounterStyleRule: 'counter-style',
  CSSFontFeatureValuesRule: 'font-feature-values',
  CSSFontPaletteValuesRule: 'font-palette-values',
  CSSViewTransitionRule: 'view-transition',
  CSSPositionTryRule: 'position-try',
  CSSFunctionRule: 'function',
};

const MARGINS = /^(top|bottom)-(left-corner|left|center|right|right-corner)$|^(left|right)-(top|middle|bottom)$/;

export const tagOf = (rule: CSSRule) => Object.prototype.toString.call(rule).slice(8, -1);
const NO_RULES: ArrayLike<CSSRule> = [];
/** The rules in `rule`, read in place: a style rule's list is most often empty. */
export const childRules = (rule: CSSRule): ArrayLike<CSSRule> => {
  const list: unknown = 'cssRules' in rule ? rule.cssRules : undefined;
  return list && typeof list === 'object' && (list as CSSRuleList).length ? (list as CSSRuleList) : NO_RULES;
};
/**
 * Pairs the CSSOM's rules with those of the text's outline, in order: outline rules the CSSOM
 * dropped (invalid ones, runs of declarations it found all invalid) are passed over; a CSSOM rule
 * left without one fails the pairing.
 *
 * The @import and @namespace rules the CSSOM has first pair with the first such rules of the text
 * wherever they are: CSS.addRule puts a rule asked for before them after them in the CSSOM, its
 * text where asked (as Chrome 156 does), so that the text has a style rule before them.
 *
 * With `omit`, the rules it tells are passed over, the nested ones too: rules the text was not
 * written with (block-text.ts).
 */
export function pair(text: string, rules: CSSRule[], omit?: (rule: CSSRule) => boolean): SheetSource | null {
  const o = outline(text);
  const namespaces = namespaceText(rules);
  const source: SheetSource = {
    text,
    lines: lineStarts(text),
    outline: o,
    nodes: new Map(),
    topRules: [],
    topNodes: [],
    namespaces,
  };
  let lead = rules.findIndex(r => !isCssom(r, 'CSSImportRule') && !isCssom(r, 'CSSNamespaceRule'));
  if (lead < 0) lead = rules.length;
  // Out of order only as a fallback for a text CSS.addRule put a rule in before the @namespace
  // rules of: any other text with rules before them has none in the CSSOM, and pairs in order.
  let used: Set<number> | undefined;
  let node = o.firstChild(ROOT);
  for (let i = 0; i < lead; i++) {
    const rule = rules[i] as CSSRule;
    const tag = tagOf(rule);
    while (node >= 0 && !matches(source, node, rule, tag, TOP)) node = o.next(node);
    if (node < 0) return null;
    (used ??= new Set()).add(node);
    source.nodes.set(rule, node);
    source.topRules.push(rule);
    source.topNodes.push(node);
    node = o.next(node);
  }
  if (!pairList(source, o.firstChild(ROOT), lead ? rules.slice(lead) : rules, TOP, true, used, omit)) return null;
  // In the order of the text, which SheetTexts.splice relies on.
  if (used) {
    const { topRules, topNodes } = source;
    const order = topNodes
      .map((_, i) => i)
      .sort((a, b) => o.start(topNodes[a] as number) - o.start(topNodes[b] as number));
    source.topRules = order.map(i => topRules[i] as CSSRule);
    source.topNodes = order.map(i => topNodes[i] as number);
  }
  return source;
}

/** The @namespace rules among `rules` as the CSSOM serializes them, on one line. */
export function namespaceText(rules: CSSRule[]): string {
  const texts: string[] = [];
  for (const r of rules) {
    const tag = tagOf(r);
    if (tag === 'CSSNamespaceRule') texts.push(r.cssText);
    // They follow only @import and @layer statements: none comes after any other rule.
    else if (tag !== 'CSSImportRule' && tag !== 'CSSLayerStatementRule') break;
  }
  return texts.join(' ');
}

/** `wrap` puts a prelude where it was, for the browser to parse it alone. */
export type Wrap = (prelude: string) => string;
export const TOP: Wrap = p => `${p}{}`;

/**
 * Pairs `cssom` with the outline's rules from `first` on (siblings, but those in `skip`) into
 * `source.nodes` (and with `top`, `topRules` and `topNodes`). The rules `omit` tells, at any depth,
 * are passed over: the ones the text was not written with.
 */
export function pairList(
  source: SheetSource,
  first: number,
  cssom: ArrayLike<CSSRule>,
  wrap: Wrap,
  top = false,
  skip?: Set<number>,
  omit?: (rule: CSSRule) => boolean
): boolean {
  const o = source.outline;
  let node = first;
  for (let i = 0; i < cssom.length; i++) {
    const rule = cssom[i] as CSSRule;
    if (omit?.(rule)) continue;
    const tag = tagOf(rule);
    for (; ; node = o.next(node)) {
      if (node < 0) return false;
      if (skip?.has(node) || !matches(source, node, rule, tag, wrap)) continue;
      source.nodes.set(rule, node);
      if (top) {
        source.topRules.push(rule);
        source.topNodes.push(node);
      }
      const inner: Wrap =
        tag === 'CSSStyleRule' ? p => `:root{${p}{}}` : tag === 'CSSKeyframesRule' ? p => `@keyframes x{${p}{}}` : wrap;
      if (!pairList(source, o.firstChild(node), childRules(rule), inner, false, undefined, omit)) return false;
      node = o.next(node);
      break;
    }
  }
  return true;
}

/** A node's prelude loosened and, parsed alone, the kind and loosened selector of its rule. */
interface Seen {
  loose: string;
  parsed?: [string, string] | null;
}
/** Per source, what `matches` worked out of its nodes, which the rules compared with share. */
const SEEN = new WeakMap<SheetSource, Map<number, Seen>>();
let lastWritten: string | undefined;
let lastLoosened = '';

/** `prelude` parsed alone, where `wrap` puts it: its rule's kind and loosened selector or key. */
function parse(prelude: string, wrap: Wrap, namespaces: string): [string, string] | null {
  const sheet = new CSSStyleSheet();
  try {
    // Our own sheet: not reported as the page's change.
    ownCall(sheet, 'replaceSync', namespaces + wrap(prelude));
  } catch {
    return null;
  }
  // The innermost rule: the wrapping ones are around it.
  let first: CSSRule | undefined = Array.from(sheet.cssRules).find(r => !isCssom(r, 'CSSNamespaceRule'));
  for (let inner = first && childRules(first)[0]; inner; inner = childRules(inner)[0]) first = inner;
  if (!first) return null;
  const parsed: unknown = isCssom(first, 'CSSStyleRule') ? first.selectorText : Reflect.get(first, 'keyText');
  return typeof parsed === 'string' ? [tagOf(first), loose(parsed)] : null;
}

/** Whether `node` of `o` is where `rule`, of the CSSOM type `tag` (`tagOf`), was written. */
function matches(source: SheetSource, node: number, rule: CSSRule, tag: string, wrap: Wrap): boolean {
  const { text, outline: o, namespaces } = source;
  const kind = o.kind(node);
  if (tag === 'CSSNestedDeclarations') {
    // Some declaration of the run is a valid one the CSSOM kept: a run of invalid ones only was
    // dropped, though a later run sets the same property.
    const style = ownStyle(rule as CSSNestedDeclarations) as CSSStyleDeclaration | undefined;
    if (kind !== 'nested' || !style) return false;
    for (let d = o.firstDecl(node), e = d + o.declCountOf(node); d < e; d++) {
      if (o.commented(d)) continue;
      const name = text.slice(o.declStart(d), o.nameEnd(d));
      if (style.getPropertyValue(name) === '') continue;
      if (name.startsWith('--') || cssSupports(name, text.slice(o.valueStart(d), o.valueEnd(d)))) return true;
    }
    return false;
  }
  if (tag === 'CSSStyleRule' || tag === 'CSSKeyframeRule') {
    if (kind !== 'qualified') return false;
    const prelude = text.slice(o.preludeStart(node), o.preludeEnd(node));
    const written: unknown = Reflect.get(rule, tag === 'CSSStyleRule' ? 'selectorText' : 'keyText');
    if (typeof written !== 'string') return false;
    // As written most often; else without what the CSSOM drops or adds.
    if (prelude === written) return true;
    if (written !== lastWritten) lastLoosened = loose((lastWritten = written));
    const loosened = lastLoosened;
    let seen = SEEN.get(source);
    if (!seen) SEEN.set(source, (seen = new Map()));
    let seenNode = seen.get(node);
    if (!seenNode) seen.set(node, (seenNode = { loose: loose(prelude) }));
    if (seenNode.loose === loosened) return true;
    // Serialized otherwise (escapes, `from` for 0%): as the browser serializes the text alone,
    // after the sheet's @namespace rules (`svg|\61` is `svg|a` only where `svg` is declared).
    // Once a node: a rule the text lacks is compared with each node after it.
    if (seenNode.parsed === undefined) seenNode.parsed = parse(prelude, wrap, namespaces);
    return seenNode.parsed !== null && seenNode.parsed[0] === tag && seenNode.parsed[1] === loosened;
  }
  if (kind !== 'at') return false;
  const name = AT_NAMES[tag];
  const written = atName(o.name(text, node))
    .toLowerCase()
    .replace(/^-webkit-/, '');
  // The margin rules of @page are named after their box.
  if (tag === 'CSSMarginRule') return MARGINS.test(written);
  return written === name;
}
