// The text the page wrote a rule's declarations in, found in the text its sheet or the rule itself was written
// in: what the browser serializes of a block is not always the block (a shorthand whose value has a var() or an
// env(), once a longhand is set after it, reads as longhands with no value), and the emulation rewrites such a
// block from what was written (domains/emulation/rewrite/rewrite.ts). The rules are paired with the text as the CSS domain
// pairs them (pair.ts), which reads them through the functions the page has (docs/limitations.md, page wrappers).
import { isCssom, isHtml, isSvg } from '../../../../core/realm';
import { ROOT } from '../parse/css-outline';
import { outline } from '../parse/css-outline-wasm';
import { ownGet } from '../watch/cssom-watch';
import { brokenLists, listBroken, wasInserted, writtenText } from '../watch/written-blocks';
import { pair, pairList, type SheetSource, type Wrap } from './pair';
import { styleSpan } from './ranges';

/** A text paired with the rules written in it, kept while both stay the same. */
interface Paired {
  text: string;
  rules: CSSRule[];
  source: SheetSource | null;
  /** How many lists were broken when the rules were paired (brokenLists): another list broken since, and they are paired again. */
  breaks: number;
}
/** By what was written: a sheet, or a rule the page inserted. */
const paired = new WeakMap<object, Paired>();

/** A selector nested in a style rule, put where the browser parses it alone. */
const NESTED: Wrap = prelude => `:root{${prelude}{}}`;

const sameRules = (a: CSSRule[], b: CSSRule[]) => a.length === b.length && a.every((rule, i) => rule === b[i]);

/** Whether `rule` is in a style rule: its selector is then a nested one. */
function nested(rule: CSSRule): boolean {
  for (let up = rule.parentRule; up; up = up.parentRule) if (isCssom(up, 'CSSStyleRule')) return true;
  return false;
}

/** `rules` paired with `text`, the text they were written in: as a sheet's, or as rules nested in a style rule. */
function pairWith(text: string, rules: CSSRule[], inStyleRule: boolean): SheetSource | null {
  // The rules inserted since are not in the text (`rules` are the ones it was written with), and those of a list
  // a rule was deleted from are no longer found by their place in it.
  const omit = (rule: CSSRule) =>
    !rules.includes(rule) && (wasInserted(rule) || listBroken(rule.parentRule ?? rule.parentStyleSheet ?? rule));
  if (!inStyleRule) return pair(text, rules, omit);
  const o = outline(text);
  const source: SheetSource = {
    text,
    lines: [],
    outline: o,
    nodes: new Map(),
    topRules: [],
    topNodes: [],
    namespaces: '',
  };
  return pairList(source, o.firstChild(ROOT), rules, NESTED, false, undefined, omit) ? source : null;
}

/** The declarations of `rule` as `text` writes them, `rules` being the rules written in `text`. */
function blockIn(key: object, text: string, rules: CSSRule[], inStyleRule: boolean, rule: CSSRule): string | undefined {
  let hit = paired.get(key);
  if (!hit || hit.text !== text || hit.breaks !== brokenLists() || !sameRules(hit.rules, rules))
    paired.set(key, (hit = { text, rules, source: pairWith(text, rules, inStyleRule), breaks: brokenLists() }));
  const node = hit.source?.nodes.get(rule);
  if (!hit.source || node === undefined) return undefined;
  const [from, to] = styleSpan(hit.source, node, rule);
  return text.slice(from, to);
}

/**
 * The text the declarations of `rule` were written in, or undefined where it is not known: from the text of the
 * innermost inserted rule that `rule` is, or is in; else from its sheet's text, which is the one given to
 * replace() or replaceSync(), or, with `ownText`, the text of its <style> or what `fileText` gives for a sheet of
 * a file. The rules are found in the text by their place, as the CSS domain finds them (pair.ts): the ones
 * inserted since are passed over, and a list a rule of the text was deleted from, or one changed where it was not
 * told (written-blocks.ts, listBroken), gives nothing for its rules, as which of the text's rules are left is not
 * known.
 */
export function writtenBlock(
  rule: CSSRule,
  fileText: (sheet: CSSStyleSheet) => string | undefined,
  ownText: boolean
): string | undefined {
  for (let at: CSSRule | null = rule; at; at = at.parentRule) {
    const given = writtenText(at);
    // The rule inserted alone in its text; one inserted in a rule inserted after it is not in that text.
    if (given) return blockIn(at, given.text, [at], nested(at), rule);
    // Inserted with a text that was not kept: no env() in it.
    if (wasInserted(at)) return undefined;
  }
  const sheet = rule.parentStyleSheet;
  if (!sheet || listBroken(sheet)) return undefined;
  const owner = ownGet<Node | null>(sheet, 'ownerNode');
  const text =
    writtenText(sheet)?.text ??
    (!ownText
      ? undefined
      : isHtml(owner, 'style') || isSvg(owner, 'style')
        ? (owner.textContent ?? undefined)
        : fileText(sheet));
  if (text === undefined) return undefined;
  return blockIn(
    sheet,
    text,
    Array.from(ownGet<CSSRuleList>(sheet, 'cssRules')).filter(top => !wasInserted(top)),
    false,
    rule
  );
}
