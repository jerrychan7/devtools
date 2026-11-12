import { frames } from '../../core/frames/frames';
import { ownCall, ownSet } from '../css/sheets/watch/cssom-watch';
import { mapDeclarations, splitDeclarations, splitMediaQueries } from './css-tokens';

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
 * The value of each declaration of `block`, as the browser reads it once parsed: a value written back
 * by the CSSOM (`0` as `0px`, a shorthand in its own serialization) reads the same as the value the
 * rewrite wrote, so that only a change the page made shows.
 */
function valuesOf(block: string): Map<string, string> {
  const style = frames.top.document.createElement('div').style;
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
