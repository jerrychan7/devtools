// The page's own declaration blocks, where the emulation rewrote them: what each block was written as, for showing.
// rewrite.ts keeps the records. The CSS text modules that read them are loaded outside a page too, so this
// module reads no DOM when it loads, and the copy shownStyle makes is parsed by the native CSSOM.
import { ownCall, ownGet, ownSheet, ownStyle } from '../css/sheets/watch/cssom-watch';

/** A text the page had, and what it was rewritten to: `applied` as it reads after the write. */
export interface Rewritten {
  original: string;
  applied: string;
  /** What the rewrite gave the original, as last written: while the text still reads `applied`, it is not written again. */
  target: string;
}

/** The records of the declaration blocks the emulation rewrote, held weakly (rewrite.ts keeps them). */
export const styles = new WeakMap<CSSStyleDeclaration, Rewritten>();

/** A declaration block as the page wrote it, for showing (and for an edit to undo to): the original of a rewritten one. */
export function shownCssText(style: CSSStyleDeclaration): string {
  const rewritten = styles.get(style);
  return rewritten && rewritten.applied === style.cssText ? rewritten.original : style.cssText;
}

/**
 * The declaration block to show for `style`: a copy holding the page's own declarations where the emulation
 * rewrote them (shownCssText), or `style` itself. The copy is the block of a rule in a sheet of the agent's own,
 * parsed natively, so no rewrite applies to it.
 */
export function shownStyle(style: CSSStyleDeclaration): CSSStyleDeclaration {
  const original = shownCssText(style);
  if (original === style.cssText) return style;
  const sheet = ownSheet();
  ownCall(sheet, 'replaceSync', `a {${original}}`);
  const rule = ownCall<CSSRule | null>(ownGet<CSSRuleList>(sheet, 'cssRules'), 'item', 0);
  return rule ? ownStyle(rule as CSSStyleRule) : style;
}
