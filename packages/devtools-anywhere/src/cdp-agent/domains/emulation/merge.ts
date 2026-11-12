import { frames } from '../../core/frames/frames';
import { ownCall, ownGet, ownRemoveProperty, ownSet, ownSetProperty } from '../css/sheets/watch/cssom-watch';
import {
  type Declaration,
  mapDeclarations,
  splitDeclarations,
  splitMediaQueries,
  splitPriority,
  withoutTakenSemicolon,
} from './css-tokens';

/**
 * The original of a text the page changed while the emulation had rewritten it, from the original
 * (`original`), what the rewrite made of it (`applied`) and what the text reads now (`current`): the
 * page's change is kept, and the declarations it did not change take their original text back, where
 * the original has one. Without that, a page changing one declaration of a rewritten style would make
 * the rewritten text its own, and the emulation would never restore what it replaced. The other sides
 * of a shorthand the page changed one side of are not restored: they keep their rewritten values.
 */
export type Merge = (original: string, applied: string, current: string) => string;

/**
 * The declarations of a declaration block, by name, with their text: split by the block's tokens (css-tokens.ts),
 * so that a semicolon or a comment mark in a string is none of the block's.
 */
const declarationsOf = splitDeclarations;

/**
 * A declaration block of no element in the page, to read what the browser makes of a text. The element is made by
 * the top document's own createElement(), which a page may have wrapped (docs/limitations.md, page wrappers).
 */
const scratch = (): CSSStyleDeclaration => frames.top.document.createElement('div').style;

/**
 * The value of each declaration of `block`, as the browser reads it once parsed: a value written back
 * by the CSSOM (`0` as `0px`, a shorthand in its own serialization) reads the same as the value the
 * rewrite wrote, so that only a change the page made shows.
 */
function valuesOf(block: string): Map<string, string> {
  const style = scratch();
  ownSet(style, 'cssText', block);
  const values = new Map<string, string>();
  for (const { name } of declarationsOf(block)) {
    const value = ownCall<string>(style, 'getPropertyValue', name);
    const priority = ownCall<string>(style, 'getPropertyPriority', name);
    values.set(name, priority === 'important' ? `${value} !important` : value);
  }
  return values;
}

/** A declaration block as the browser reads it: each name's value (valuesOf), and each name's declared text. */
interface Reading {
  values: Map<string, string>;
  texts: Map<string, string>;
}

const readingOf = (block: string): Reading => ({
  values: valuesOf(block),
  texts: new Map(declarationsOf(block).map(d => [d.name, d.value.replace(/\s+/g, ' ')] as const)),
});

/**
 * Whether the declaration `name` reads the same in both blocks: by the value the browser reads for it, or, where that value
 * is empty, by the text declared. A shorthand with a longhand after it (or an env() or a var() on one of its sides) reads
 * as empty, as its sides have no one value, so two such shorthands are the same only when their texts are.
 */
function sameReading(a: Reading, b: Reading, name: string): boolean {
  const value = a.values.get(name);
  if (value === undefined || value !== b.values.get(name)) return false;
  return value !== '' || a.texts.get(name) === b.texts.get(name);
}

/**
 * Declaration blocks: a declaration whose value is still the one the rewrite gave it takes the value the
 * original declares for its name back; everything else is the page's, as it wrote it, byte for byte (what is
 * between its declarations included: a comment, an empty declaration, the last semicolon). A block the
 * browser writes back with an empty value in it (the longhands of a shorthand whose value is pending,
 * a var() or an env(), which it cannot write whole) is kept as the browser wrote it: written back as
 * text, the empty declarations would drop the values they stand for, and the sides they set.
 */
export const mergeDeclarations: Merge = (original, applied, current) => {
  if (declarationsOf(current).some(d => d.value === '')) return current;
  const kept = new Map(declarationsOf(original).map(d => [d.name, d.value] as const));
  const was = readingOf(applied);
  const now = readingOf(current);
  return mapDeclarations(current, name => {
    const own = kept.get(name);
    return own && sameReading(was, now, name) ? own : null;
  });
};

/**
 * Whether `text`, a style attribute, reads as the browser serializes a block: `name: value; ` for each declaration,
 * or a text that ends in an open value, which only the CSSOM leaves so with a semicolon after it. Such a text may
 * be the CSSOM's, whose block is not always the one the text parsed again gives (writeDeclarations).
 */
export const serialized = (text: string): boolean =>
  withoutTakenSemicolon(text) !== text ||
  declarationsOf(text)
    .map(d => `${d.name}: ${d.value}; `)
    .join('')
    .trimEnd() === text;

/** The names of the properties `style` holds, in the block's order (`style[i]`). */
const orderOf = (style: CSSStyleDeclaration): string[] =>
  Array.from({ length: ownGet<number>(style, 'length') }, (_, i) => ownCall<string>(style, 'item', i));

/**
 * Writes `text` to `style`, a declaration block the browser serialized (a rule's style, or the style of an element
 * whose attribute the CSSOM wrote last), and returns nothing: the block reads what the browser makes of it.
 *
 * Where `text` declares the names the block's own text declares (the rewrite and the merge change values only),
 * each declaration whose value differs is set on its own, by its name. Setting `cssText` would parse
 * the whole text again, which is not the same block: the browser puts the `!important` declarations after the
 * others, so a rule that has one before a plain one would change its order; a value that leaves a function, a
 * block, a string or a url() open is serialized as written, with a semicolon and the next declarations after it,
 * which the text parsed again takes into that value; a longhand is written into the shorthand of its sides,
 * wherever it is in the block (`padding: 1px; padding-inline-start: 3px; padding-left: 2px` reads
 * `padding: 1px 1px 1px 2px; padding-inline-start: 3px`), so the text parsed again has it before a declaration it
 * came after; and the sides of a pending shorthand of which one was set since are written with no value, which the
 * text parsed again drops. An open value shows as the text's last declaration, with what follows it: that one is
 * never set (withoutTakenSemicolon tells it). A text that declares other names is set whole, without a last
 * semicolon an open value would take. Each write is made through `write`.
 *
 * A property is set in place, but for one the browser moves: see restoreOrder, which puts it back.
 */
export function writeDeclarations(
  style: CSSStyleDeclaration,
  text: string,
  write: (set: () => void) => void = set => set()
): void {
  const current = ownGet<string>(style, 'cssText');
  const now = declarationsOf(current);
  const next = declarationsOf(text);
  const values = new Map(now.map(d => [d.name, d.value] as const));
  if (now.length !== next.length || values.size !== now.length || next.some(d => !values.has(d.name)))
    return write(() => ownSet(style, 'cssText', withoutTakenSemicolon(text)));
  const open = withoutTakenSemicolon(current) !== current ? now[now.length - 1]?.name : undefined;
  const order = orderOf(style);
  let changed = false;
  for (const d of next) {
    if (d.value === values.get(d.name) || d.name === open) continue;
    const { value, priority } = splitPriority(d.value);
    write(() => ownSetProperty(style, d.name, value, priority ? 'important' : ''));
    changed = true;
  }
  if (changed) restoreOrder(style, order, next, write);
}

/**
 * Puts the properties of `style` back in `order`, the order they had (`style[i]`) before the declarations of
 * `declared` were set. The browser sets a property in place, but takes it out and adds it at the end of the block
 * where a later declaration is its logical or physical counterpart (`padding-inline-start` before `padding-top`,
 * `inline-size` before `height`, the sides of `padding` before `padding-inline-end`), as the cascade of the two goes
 * by their order: left there, the moved property would win over the one that came after it. The order is the
 * block's own, which its text does not always tell (writeDeclarations), so it is put back by the properties the
 * block holds, not by the text: from the first one that is out of place on, each is removed, and they are added
 * again in their order, with the values they have now. Added at the end, none of them moves.
 *
 * A side of a shorthand whose value is pending (a var() or an env() in it) has no value of its own: the shorthand
 * that `declared` has for it is set whole, where its first side was. A property with no value to set is left where
 * it is, before the ones added again: `all`, or a side of a pending shorthand of which another side was set since
 * (the browser writes those sides with no value). A property that was declared before one of those is then after
 * it, and the block's text lists it there.
 */
function restoreOrder(
  style: CSSStyleDeclaration,
  order: string[],
  declared: Declaration[],
  write: (set: () => void) => void
): void {
  const moved = orderOf(style);
  const from = order.findIndex((name, i) => name !== moved[i]);
  if (from < 0 || moved.length !== order.length) return;
  const after = order.slice(from).map(name => ({
    name,
    // A custom property with an empty value is set as a space, which is the same value: an empty one would remove it.
    value: ownCall<string>(style, 'getPropertyValue', name) || (name.startsWith('--') ? ' ' : ''),
    priority: ownCall<string>(style, 'getPropertyPriority', name),
  }));
  const wholes = after.some(d => d.value === '') ? pendingSides(declared) : undefined;
  const again = after.filter(d => d.value !== '' || wholes?.has(d.name));
  for (const d of again.slice().reverse()) write(() => ownRemoveProperty(style, d.name));
  const added = new Set<Declaration>();
  for (const d of again) {
    const whole = d.value === '' ? wholes?.get(d.name) : undefined;
    if (!whole) write(() => ownSetProperty(style, d.name, d.value, d.priority));
    else if (!added.has(whole)) {
      added.add(whole);
      const { value, priority } = splitPriority(whole.value);
      write(() => ownSetProperty(style, whole.name, value, priority ? 'important' : ''));
    }
  }
}

/** For each side of a shorthand of `declared` whose value is pending (the side reads as empty), that shorthand. */
function pendingSides(declared: Declaration[]): Map<string, Declaration> {
  const sides = new Map<string, Declaration>();
  const style = scratch();
  for (const d of declared) {
    ownSet(style, 'cssText', d.text);
    for (const side of orderOf(style))
      if (side !== d.name && ownCall<string>(style, 'getPropertyValue', side) === '') sides.set(side, d);
  }
  return sides;
}

/**
 * Whether two declaration blocks declare the same names with the same values, as the browser reads them (sameReading),
 * whatever their text.
 */
export const sameDeclarations = (a: string, b: string): boolean => {
  const left = readingOf(a);
  const right = readingOf(b);
  if (left.values.size !== right.values.size) return false;
  for (const name of left.values.keys()) if (!sameReading(left, right, name)) return false;
  return true;
};

/**
 * For each entry of `b`, the index of the entry of `a` it matches in a longest common subsequence of
 * both (-1 for none): which entries of a list the page kept, when it added or removed some of them.
 */
function alignment(a: string[], b: string[]): number[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // lengths[i * width + j]: the longest common subsequence of a from i and of b from j.
  const lengths: number[] = Array.from({ length: (n + 1) * width }, () => 0);
  const at = (i: number, j: number) => lengths[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lengths[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out: number[] = Array.from({ length: m }, () => -1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out[j] = i;
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) i++;
    else j++;
  }
  return out;
}

/**
 * Lists separated by commas (media queries, the entries of `sizes`), split at the commas CSS splits them at
 * (css-tokens.ts): an entry the page did not change takes back the original entry it was rewritten from,
 * wherever it now is in the list.
 */
export const mergeList: Merge = (original, applied, current) => {
  const kept = splitMediaQueries(original);
  const shown = splitMediaQueries(applied).map(part => part.trim());
  const now = splitMediaQueries(current);
  const from = alignment(
    shown,
    now.map(part => part.trim())
  );
  return now
    .map((part, i) => {
      const j = from[i] ?? -1;
      return (j >= 0 ? kept[j] : undefined) ?? part;
    })
    .join(',');
};
