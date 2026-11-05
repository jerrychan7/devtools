import { isCssom, realmOf } from '../../../core/realm';
import { nativeAdopted, quietly } from '../../../core/nodes/adopted';
import { parentOf } from '../../../core/style/container-query';
import { ownEdit } from '../sheets/cssom-watch';
import type { TreeScope } from './forced-pseudo';

/**
 * Rules of a sheet, to be matched after its @namespace rules: each makes the rule matching what is
 * to be found out (`sel { … }`, or one in an @scope) of the declarations it is given.
 */
export interface InNamespaces {
  namespaces: string;
  rules: ((declarations: string) => string)[];
}

/**
 * Matching in the namespaces a sheet declares (@namespace): Element.matches() knows no prefix
 * but `*` and none, and no default namespace. The selectors of each sheet are put, after its
 * @namespace rules, in a sheet of our own; all of them are adopted at once by the elements' tree
 * for as long as their computed styles are read (each adoption costs a walk of the whole tree,
 * and the style of the elements the rules may match recalculated). Each selector that matches
 * sets a custom property of its own. An element inherits those of its parent (in the flat tree):
 * where the parent has one too, the element's is found out again with a rule resetting them
 * first, of no specificity, for its own name and classes (one for every element, or for all the
 * ancestors every time, would make the style of many recalculated).
 *
 * The page's code does not run meanwhile: the native accessors of `adoptedStyleSheets` are used,
 * past any wrapper of the page. Returns, by sheet, by element, whether each selector matches.
 */
export function matchInNamespaces(els: Element[], tree: TreeScope, sheets: InNamespaces[]): boolean[][][] {
  const none = () => sheets.map(s => els.map(() => s.rules.map(() => false)));
  const accessors = nativeAdopted(tree);
  const first = els[0];
  if (!accessors || !first) return none();
  const realm = realmOf(first);
  const name = (k: number, i: number) => `--devtools-anywhere-ns-${k}-${i}`;
  /** The values of the properties on `targets`, by sheet, by target, by rule; null on failure. */
  const probe = (targets: Element[], reset: Element[]): boolean[][][] | null => {
    const own = reset
      .map(el => `*|${CSS.escape(el.localName)}${Array.from(el.classList, c => `.${CSS.escape(c)}`).join('')}`)
      .join(',');
    const probes: CSSStyleSheet[] = [];
    try {
      for (const [k, { namespaces, rules: made }] of sheets.entries()) {
        const zero = made.map((_, i) => `${name(k, i)}:0`).join(';');
        // An element slotted in the tree inherits from its slot.
        const resets = own ? `:where(${own}){${zero}}\n::slotted(:where(${own})){${zero}}` : '';
        // One rule each: an invalid selector drops its rule only.
        const rules = made.map((rule, i) => rule(`${name(k, i)}:1`)).join('\n');
        const sheet = new realm.CSSStyleSheet();
        ownEdit(() => sheet.replaceSync(`${namespaces}\n${resets}\n${rules}`));
        probes.push(sheet);
      }
    } catch {
      return null;
    }
    return quietly(() => {
      const before: unknown = accessors.get.call(tree);
      const adopted = Array.isArray(before) ? before.filter(s => isCssom(s, 'CSSStyleSheet')) : [];
      accessors.set.call(tree, [...adopted, ...probes]);
      try {
        const styles = targets.map(el => realm.getComputedStyle(el));
        return sheets.map(({ rules }, k) =>
          styles.map(style => rules.map((_, i) => style.getPropertyValue(name(k, i)).trim() === '1'))
        );
      } finally {
        accessors.set.call(tree, adopted);
      }
    });
  };
  const parents = els.map(el => el.assignedSlot ?? parentOf(el));
  const targets = [...new Set([...els, ...parents.filter((p): p is Element => p !== null)])];
  const values = probe(targets, []);
  if (!values) return none();
  const of = (k: number, el: Element | null) => (el ? (values[k]?.[targets.indexOf(el)] ?? []) : []);
  const result = sheets.map((_, k) => els.map(el => [...of(k, el)]));
  // Those set on the parent as well may be inherited.
  const unsure = els.filter((el, j) =>
    sheets.some((_, k) => of(k, parents[j] ?? null).some((v, i) => v && of(k, el)[i]))
  );
  if (unsure.length) {
    const again = probe(unsure, unsure);
    if (!again) return none();
    unsure.forEach((el, n) => {
      const j = els.indexOf(el);
      for (const [k, row] of result.entries()) row[j] = [...(again[k]?.[n] ?? [])];
    });
  }
  return result;
}
