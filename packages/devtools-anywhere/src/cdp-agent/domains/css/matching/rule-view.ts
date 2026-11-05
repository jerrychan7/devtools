import type { Protocol } from 'devtools-protocol';
import { isCssom } from '../../../core/realm';
import { queriedAxes } from '../../../core/style/container-query';
import type { NodeRegistry } from '../../../core/nodes/nodes';
import { specificity, splitTopLevel } from '../../../core/style/selectors';
import type { TreeScope } from './forced-pseudo';
import { shownMedia } from '../../emulation/rewrite';
import { type StyleRule, ancestorsOf, mediaList, resolveSelector, ruleType, scopeText, selectorLabel } from './rules';
import type { SheetRegistry } from '../sheets/sheet-registry';
import { rangeOf, selectorSpans, sourceStyle } from '../sheets/sheet-text';
import { type CSSStyle, buildStyle } from '../style';

/** Rules of the page's sheets in the shape the CSS domain reports them in. */
export class RuleView {
  private readonly sheets: SheetRegistry;
  private readonly nodes: NodeRegistry;

  constructor(sheets: SheetRegistry, nodes: NodeRegistry) {
    this.sheets = sheets;
    this.nodes = nodes;
  }

  ruleStyle(sheet: CSSStyleSheet, rule: StyleRule): CSSStyle {
    const source = this.sheets.sourceOf(sheet);
    const node = source?.nodes.get(rule);
    if (source && node) return sourceStyle(this.sheets.idOf(sheet), rule.style, source, node);
    const line = this.sheets.ruleId(sheet, rule);
    return buildStyle(this.sheets.idOf(sheet), rule.style, line, selectorLabel(rule).length + 3);
  }

  selectorList(sheet: CSSStyleSheet, rule: StyleRule): Protocol.CSS.SelectorList {
    // Like Chrome, nested declarations show their style rule's selectors, without selectors of their own.
    if (!isCssom(rule, 'CSSStyleRule')) return { selectors: [], text: selectorLabel(rule) };
    const source = this.sheets.sourceOf(sheet);
    const node = source?.nodes.get(rule);
    const parts = splitTopLevel(rule.selectorText, ',').map(p => p.trim());
    const spans = source && node ? selectorSpans(source.text, node) : [];
    // As written, where they are.
    if (source && spans.length === parts.length)
      return {
        selectors: spans.map(([start, end], i) => ({
          // CSS white space only: U+2028 and others JavaScript trims are characters of a selector.
          text: source.text.slice(start, end).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, ''),
          specificity: specificity(resolveSelector(parts[i] ?? '', rule, true)),
          range: rangeOf(source, start, end),
        })),
        text: rule.selectorText,
      };
    const line = this.sheets.ruleId(sheet, rule);
    let column = 0;
    const selectors = splitTopLevel(rule.selectorText, ',').map(raw => {
      const text = raw.trim();
      const start = column + raw.indexOf(text);
      column += raw.length + 1;
      return {
        text,
        specificity: specificity(resolveSelector(text, rule, true)),
        range: { startLine: line, startColumn: start, endLine: line, endColumn: start + text.length },
      };
    });
    return { selectors, text: rule.selectorText };
  }

  /** An @media, its condition where it is written when the sheet's text is known. */
  media(sheet: CSSStyleSheet, rule: CSSMediaRule): Protocol.CSS.CSSMedia {
    // Emulated media rewrite the condition (domains/emulation): the page's is shown, active as rewritten.
    const text = shownMedia(rule.media);
    const list = mediaList(text, this.sheets.realmOf(sheet));
    if (text !== rule.conditionText) {
      const live = mediaList(rule.conditionText, this.sheets.realmOf(sheet));
      list.forEach((query, i) => (query.active = live[i]?.active ?? query.active));
    }
    const source = this.sheets.sourceOf(sheet);
    const node = source?.nodes.get(rule);
    return {
      text,
      source: 'mediaRule',
      sourceURL: this.sheets.sourceURL(sheet),
      ...(source && node && { range: rangeOf(source, node.preludeStart, node.preludeEnd) }),
      styleSheetId: this.sheets.idOf(sheet),
      mediaList: list,
    };
  }

  /** A rule with the at-rules and style rules around it, in the fields Chrome reports them in. */
  cssRule(sheet: CSSStyleSheet, rule: StyleRule, tree?: TreeScope): Protocol.CSS.CSSRule {
    const styleSheetId = this.sheets.idOf(sheet);
    const result: Protocol.CSS.CSSRule = {
      styleSheetId,
      selectorList: this.selectorList(sheet, rule),
      origin: this.sheets.origin(sheet),
      style: this.ruleStyle(sheet, rule),
    };
    if (tree) result.originTreeScopeNodeId = this.nodes.backendIdOf(tree);
    const ancestors = ancestorsOf(rule);
    const nestingSelectors: string[] = [];
    const media: Protocol.CSS.CSSMedia[] = [];
    const containerQueries: Protocol.CSS.CSSContainerQuery[] = [];
    const supports: Protocol.CSS.CSSSupports[] = [];
    const layers: Protocol.CSS.CSSLayer[] = [];
    const scopes: Protocol.CSS.CSSScope[] = [];
    const ruleTypes: Protocol.CSS.CSSRuleType[] = [];
    // Where an at-rule's condition is written.
    const source = this.sheets.sourceOf(sheet);
    const at = (a: CSSRule) => {
      const node = source?.nodes.get(a);
      return source && node ? { range: rangeOf(source, node.preludeStart, node.preludeEnd) } : {};
    };
    for (const a of ancestors) {
      const type = ruleType(a);
      if (type) ruleTypes.push(type);
      if (isCssom(a, 'CSSStyleRule')) nestingSelectors.push(a.selectorText);
      else if (isCssom(a, 'CSSMediaRule')) media.push(this.media(sheet, a));
      else if (isCssom(a, 'CSSSupportsRule'))
        supports.push({ text: a.conditionText, active: CSS.supports(a.conditionText), ...at(a), styleSheetId });
      else if (isCssom(a, 'CSSContainerRule'))
        containerQueries.push({
          text: a.containerQuery,
          ...at(a),
          styleSheetId,
          ...(a.containerName && { name: a.containerName }),
          ...queriedAxes(a.containerQuery),
          conditionText: a.conditionText,
        });
      // Chrome lists layers outermost first, unlike the other at-rules.
      else if (isCssom(a, 'CSSLayerBlockRule')) layers.unshift({ text: a.name, ...at(a), styleSheetId });
      else if (isCssom(a, 'CSSScopeRule')) scopes.push({ text: scopeText(a), ...at(a), styleSheetId });
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
}
