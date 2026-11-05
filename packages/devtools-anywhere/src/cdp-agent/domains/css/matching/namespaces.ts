import { isCssom, isShadowRoot, realmOf } from '../../../core/realm';
import { quietly } from '../../../core/nodes/adopted';
import { ownEdit } from '../sheets/cssom-watch';
import type { TreeScope } from './forced-pseudo';

/**
 * Matching in the namespaces a sheet declares (@namespace): Element.matches() knows no prefix
 * but `*` and none, and no default namespace. The selectors are put, after the sheet's @namespace
 * rules, in a sheet of our own adopted by the element's tree for as long as its computed style is
 * read: each one that matches sets a custom property of its own, which every element resets, so
 * that none is inherited. The page's code does not run meanwhile, and the change of its adopted
 * sheets goes unreported.
 */
export function matchInNamespaces(el: Element, tree: TreeScope, namespaces: string, selectors: string[]): boolean[] {
  if (!selectors.length) return [];
  const realm = realmOf(el);
  const name = (i: number) => `--devtools-anywhere-ns-${i}`;
  const reset = `*|*{${selectors.map((_, i) => `${name(i)}:0`).join(';')}}`;
  // One rule each: an invalid selector drops its rule only.
  const rules = selectors.map((s, i) => `${s}{${name(i)}:1}`).join('\n');
  const probe = new realm.CSSStyleSheet();
  try {
    ownEdit(() => probe.replaceSync(`${namespaces}\n${reset}\n${rules}`));
  } catch {
    return selectors.map(() => false);
  }
  const proto = isShadowRoot(tree) ? realm.ShadowRoot.prototype : realm.Document.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
  const get = descriptor?.get;
  const set = descriptor?.set;
  if (!get || !set) return selectors.map(() => false);
  return quietly(() => {
    const before: unknown = get.call(tree);
    const adopted = Array.isArray(before) ? before.filter(s => isCssom(s, 'CSSStyleSheet')) : [];
    set.call(tree, [...adopted, probe]);
    try {
      const style = realm.getComputedStyle(el);
      return selectors.map((_, i) => style.getPropertyValue(name(i)).trim() === '1');
    } finally {
      set.call(tree, adopted);
    }
  });
}
