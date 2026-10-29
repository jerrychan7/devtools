import type { Protocol } from 'devtools-protocol';
import { queriedAxes } from '../../core/container-query';
import type { NodeRegistry } from '../../core/nodes';
import { specificity, splitTopLevel } from '../../core/selectors';
import type { TreeScope } from './forced-pseudo';
import { type StyleRule, ancestorsOf, mediaList, resolveSelector, ruleType, scopeText, selectorLabel } from './rules';
import type { SheetRegistry } from './sheet-registry';
import { sourceSelectors } from './source';
import { type CSSStyle, buildStyle } from './style';

/** Rules of the page's sheets in the shape the CSS domain reports them in. */
export class RuleView {
  constructor(
    private readonly sheets: SheetRegistry,
    private readonly nodes: NodeRegistry
  ) {}

  ruleStyle(sheet: CSSStyleSheet, rule: StyleRule): CSSStyle {
    const line = this.sheets.ruleId(sheet, rule);
    return buildStyle(this.sheets.idOf(sheet), rule.style, line, selectorLabel(rule).length + 3);
  }

  selectorList(sheet: CSSStyleSheet, rule: StyleRule): Protocol.CSS.SelectorList {
    // Like Chrome, nested declarations show their style rule's selectors, without selectors of their own.
    if (!(rule instanceof CSSStyleRule)) return { selectors: [], text: selectorLabel(rule) };
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
}
