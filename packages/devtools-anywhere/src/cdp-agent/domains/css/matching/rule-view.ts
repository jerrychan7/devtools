import type { Protocol } from 'devtools-protocol';
import { isCssom } from '../../../core/realm';
import { queriedAxes } from '../../../core/style/container-query';
import type { NodeRegistry } from '../../../core/nodes/nodes';
import { specificity, splitTopLevel } from '../../../core/style/selectors';
import type { TreeScope } from './forced-pseudo';
import { shownMedia } from '../../emulation/rewrite';
import { type StyleRule, ancestorsOf, mediaList, resolveSelector, ruleType, scopeText, selectorLabel } from './rules';
import type { SheetRegistry } from '../sheets/sheet-registry';
import { sourceSelectors } from '../sheets/source';
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
    const line = this.sheets.ruleId(sheet, rule);
    return buildStyle(this.sheets.idOf(sheet), rule.style, line, selectorLabel(rule).length + 3);
  }

  selectorList(sheet: CSSStyleSheet, rule: StyleRule): Protocol.CSS.SelectorList {
    // Like Chrome, nested declarations show their style rule's selectors, without selectors of their own.
    if (!isCssom(rule, 'CSSStyleRule')) return { selectors: [], text: selectorLabel(rule) };
    const line = this.sheets.ruleId(sheet, rule);
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
    for (const a of ancestors) {
      const type = ruleType(a);
      if (type) ruleTypes.push(type);
      if (isCssom(a, 'CSSStyleRule')) nestingSelectors.push(a.selectorText);
      else if (isCssom(a, 'CSSMediaRule')) {
        // Emulated media rewrite the condition (domains/emulation): the page's is shown, active as rewritten.
        const text = shownMedia(a.media);
        const list = mediaList(text, this.sheets.realmOf(sheet));
        if (text !== a.conditionText) {
          const live = mediaList(a.conditionText, this.sheets.realmOf(sheet));
          list.forEach((query, i) => (query.active = live[i]?.active ?? query.active));
        }
        media.push({
          text,
          source: 'mediaRule',
          sourceURL: this.sheets.sourceURL(sheet),
          styleSheetId,
          mediaList: list,
        });
      } else if (isCssom(a, 'CSSSupportsRule'))
        supports.push({ text: a.conditionText, active: CSS.supports(a.conditionText), styleSheetId });
      else if (isCssom(a, 'CSSContainerRule'))
        containerQueries.push({
          text: a.containerQuery,
          styleSheetId,
          ...(a.containerName && { name: a.containerName }),
          ...queriedAxes(a.containerQuery),
          conditionText: a.conditionText,
        });
      // Chrome lists layers outermost first, unlike the other at-rules.
      else if (isCssom(a, 'CSSLayerBlockRule')) layers.unshift({ text: a.name, styleSheetId });
      else if (isCssom(a, 'CSSScopeRule')) scopes.push({ text: scopeText(a), styleSheetId });
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
