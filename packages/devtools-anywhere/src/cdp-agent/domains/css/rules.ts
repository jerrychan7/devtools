import type { Protocol } from 'devtools-protocol';
import { splitTopLevel } from '../../core/selectors';

/** A rule with declarations: a style rule, or declarations after rules nested in one. */
export type StyleRule = CSSStyleRule | CSSNestedDeclarations;

export interface Entry {
  rule: StyleRule;
  /** Keys of the cascade layers the rule is in, outermost first (see SheetRegistry.entries). */
  layer: string[];
}

/** Rules around `rule`, innermost first. */
export function ancestorsOf(rule: CSSRule): CSSRule[] {
  const result: CSSRule[] = [];
  for (let parent = rule.parentRule; parent; parent = parent.parentRule) result.push(parent);
  return result;
}

/** The style rule or @scope that `&` refers to in `rule`. */
export function nestingParent(rule: CSSRule): CSSStyleRule | CSSScopeRule | null {
  return ancestorsOf(rule).find(r => r instanceof CSSStyleRule || r instanceof CSSScopeRule) ?? null;
}

/** The selector Chrome shows for a rule: nested declarations show that of their style rule. */
export function selectorLabel(rule: StyleRule): string {
  if (rule instanceof CSSStyleRule) return rule.selectorText;
  const parent = nestingParent(rule);
  return parent instanceof CSSStyleRule ? parent.selectorText : '&';
}

/** Replaces `&` outside strings and escapes. */
export function replaceNesting(selector: string, replacement: string): string {
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
export function resolveSelector(selector: string, rule: CSSRule, forSpecificity = false): string {
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
export function ruleType(rule: CSSRule): Protocol.CSS.CSSRuleType | null {
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
export function scopeText(rule: CSSScopeRule): string {
  const start = rule.start === null ? '' : `(${rule.start})`;
  const end = rule.end === null ? '' : `to (${rule.end})`;
  return [start, end].filter(Boolean).join(' ');
}

/** Cascade layer keys: dotted names are split, and anonymous layers get unique keys. */
export const anonymousLayers = new WeakMap<CSSRule, string>();
export let anonymousLayerSeq = 0;
export function layerKeys(name: string | null, owner: CSSRule): string[] {
  if (name) return name.split('.').map(n => n.trim());
  let key = anonymousLayers.get(owner);
  if (!key) {
    key = `\u0002${++anonymousLayerSeq}`;
    anonymousLayers.set(owner, key);
  }
  return [key];
}

/** The layer an @import-ed sheet is in, outermost first. */
export function importedLayer(sheet: CSSStyleSheet): string[] {
  const owner = sheet.ownerRule;
  if (!(owner instanceof CSSImportRule) || !owner.parentStyleSheet) return [];
  const outer = importedLayer(owner.parentStyleSheet);
  return owner.layerName === null ? outer : [...outer, ...layerKeys(owner.layerName, owner)];
}

/**
 * Whether a sheet's own conditions hold: the media of its <link>, <style> or @import, and the
 * supports() of its @import, up through the sheets that import it.
 */
export function sheetApplies(sheet: CSSStyleSheet): boolean {
  for (let s: CSSStyleSheet | null = sheet; s; s = s.ownerRule?.parentStyleSheet ?? null) {
    if (s.media.mediaText && !matchMedia(s.media.mediaText).matches) return false;
    const owner = s.ownerRule;
    if (owner instanceof CSSImportRule && owner.supportsText && !CSS.supports(owner.supportsText)) {
      return false;
    }
  }
  return true;
}
