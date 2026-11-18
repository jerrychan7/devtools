import { isCssom, isShadowRoot, realmOf } from '../../../core/realm';
import { nativeAdopted, quietly } from '../../../core/nodes/adopted';
import { ownCall } from '../sheets/watch/cssom-watch';
import { Tok, tokenize } from '../sheets/parse/css-lexer';
import type { TreeScope } from './forced-pseudo';

/** Whether `namespaces` (@namespace rules as the CSSOM serializes them) declares a default one. */
export const hasDefaultNamespace = (namespaces: string) => /@namespace\s+url\(/.test(namespaces);

/**
 * Whether Element.matches() matches `selector` as a sheet declaring namespaces would, when that
 * sheet declares no default namespace: matches() knows the prefixes `*|` (any namespace) and `|`
 * (none) wherever they are, in :is() and attribute selectors too, so only a named prefix needs
 * the sheet's declarations. A `|` before `=` (`[a|=v]`) or another `|` (`||`) is no prefix, and
 * one in a string is no token of its own.
 */
export function withoutNamedPrefix(selector: string): boolean {
  if (!selector.includes('|')) return true;
  const { kinds, starts } = tokenize(selector);
  let prev: number = Tok.Ws;
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    if (kind === Tok.Delim && selector.charCodeAt(starts[i] ?? 0) === 124) {
      const next = kinds[i + 1] === Tok.Delim ? selector.charCodeAt(starts[i + 1] ?? 0) : 0;
      if (next === 61) continue; // |=
      if (next === 124) return false; // || or a prefix of it: let the probe tell
      if (prev === Tok.Ident) return false;
    }
    prev = kind ?? Tok.Ws;
  }
  return true;
}

/**
 * Rules of a sheet, to be matched after its @namespace rules: each makes the rule matching what is
 * to be found out (`sel { … }`, or one in an @scope) of the declarations it is given, for the
 * elements `subject` picks out.
 */
export interface InNamespaces {
  namespaces: string;
  rules: ((declarations: string, subject: string) => string)[];
}

/**
 * Matching in the namespaces a sheet declares (@namespace): Element.matches() knows no prefix
 * but `*` and none, and no default namespace. The selectors of each sheet are put, after its
 * @namespace rules, in a sheet of our own; all of them are adopted at once by the elements' tree
 * for as long as their computed styles are read (each adoption costs a walk of the whole tree,
 * and the style of the elements the rules may match recalculated). Each selector that matches
 * sets a custom property of its own, to the index of the element it picks out: an element
 * inheriting that of its parent (in the flat tree) gets the parent's index, not its own, so one
 * adoption tells them all. (Resetting the properties on the elements first would do too, but
 * Chrome then recalculates the style of everything below them, as much as a second adoption.)
 *
 * The page's code does not run meanwhile: the native accessors of `adoptedStyleSheets` are used,
 * past any wrapper of the page. Returns, by sheet, by element, whether each selector matches.
 */
export function matchInNamespaces(els: Element[], tree: TreeScope, sheets: InNamespaces[]): boolean[][][] {
  const none = () => sheets.map(s => els.map(() => s.rules.map(() => false)));
  const accessors = nativeAdopted(tree);
  const first = els[0];
  if (!first) return none();
  const realm = realmOf(first);
  const name = (k: number, i: number) => `--devtools-anywhere-ns-${k}-${i}`;
  const compound = (el: Element) => `*|${CSS.escape(el.localName)}`;
  /**
   * A selector for the element, so that adopting the probe recalculates the style of few
   * elements, and only the element among those asked about: its id; else, in the probe's own
   * tree, its path from the root of the tree by :nth-child(), with its classes (a name alone, or a class many share, has many recalculated:
   * 10000 elements, `*|div` costs 18.5 + 15.8 ms, the path 4.7 + 4.4 ms); else (an element
   * slotted from outside, which a path in ::slotted() cannot reach) its name and classes. `*|`
   * for any namespace (the compound would otherwise be of the default one). Not in :where():
   * Chrome does not recalculate the elements a rule of an adopted sheet matches through :where()
   * alone.
   */
  const subject = (el: Element) => {
    const id = el.id && `${compound(el)}#${CSS.escape(el.id)}`;
    const classes = Array.from(el.classList, c => `.${CSS.escape(c)}`).join('');
    if (el.getRootNode() !== tree) return id || `${compound(el)}${classes}`;
    // Not an id another of them has too: it would pick out both.
    if (id && els.every(e => e === el || e.id !== el.id)) return id;
    return pathOf(el, classes);
  };
  /**
   * Its path, anchored at the root of the tree: the root element, or the shadow root's host. That
   * of an ancestor (with no classes) is the start of its descendants': each is made once.
   */
  const paths = new Map<Element, string>();
  const pathOf = (e: Element, own: string): string => {
    const known = own ? undefined : paths.get(e);
    if (known !== undefined) return known;
    const parent = e.parentElement;
    let path: string;
    if (!parent && !isShadowRoot(tree)) path = `${compound(e)}${own}:root`;
    else {
      let n = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) n++;
      const step = `${compound(e)}${own}:nth-child(${n})`;
      path = parent ? `${pathOf(parent, '')}>${step}` : `:host>${step}`;
    }
    if (!own) paths.set(e, path);
    return path;
  };
  /** The values of the properties on `els`, by sheet, by element, by rule; null on failure. */
  const probe = (): boolean[][][] | null => {
    const subjects = els.map(subject);
    const probes: CSSStyleSheet[] = [];
    try {
      for (const [k, { namespaces, rules: made }] of sheets.entries()) {
        // One rule each: an invalid selector drops its rule only.
        const rules = made.flatMap((rule, i) => subjects.map((own, j) => rule(`${name(k, i)}:${j}`, own))).join('\n');
        const sheet = new realm.CSSStyleSheet();
        ownCall(sheet, 'replaceSync', `${namespaces}\n${rules}`);
        probes.push(sheet);
      }
    } catch {
      return null;
    }
    return quietly(() => {
      const before: unknown = accessors.get.call(tree);
      const adopted = Array.isArray(before) ? before.filter(s => isCssom(s, 'CSSStyleSheet')) : [];
      // Throws for sheets of another realm than the tree's (a shadow root in a document without
      // a window, as a <template>'s): nothing then matches.
      try {
        accessors.set.call(tree, [...adopted, ...probes]);
        try {
          const styles = els.map(el => realm.getComputedStyle(el));
          return sheets.map(({ rules }, k) =>
            styles.map((style, j) => rules.map((_, i) => style.getPropertyValue(name(k, i)).trim() === `${j}`))
          );
        } finally {
          accessors.set.call(tree, adopted);
        }
      } catch {
        return null;
      }
    });
  };
  return probe() ?? none();
}
