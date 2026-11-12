import { frames } from '../../core/frames/frames';
import { splitTopLevel } from '../../core/style/selectors';
import { ownCall, ownSet } from '../css/sheets/watch/cssom-watch';

/**
 * The original of a text the page changed while the emulation had rewritten it, from the original
 * (`original`), what the rewrite made of it (`applied`) and what the text reads now (`current`): the
 * page's change is kept, and the declarations it did not change take their original text back, where
 * the original has one. Without that, a page changing one declaration of a rewritten style would make
 * the rewritten text its own, and the emulation would never restore what it replaced. The other sides
 * of a shorthand the page changed one side of are not restored: they keep their rewritten values.
 */
export type Merge = (original: string, applied: string, current: string) => string;

interface Declaration {
  name: string;
  text: string;
}

/** A comment, which a declaration block may have in it (the CSSOM drops it, the rewrite keeps it). */
const COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * The declarations of a declaration block, by name (lower case, except a custom property's, which
 * is case-sensitive), with their text. A part without a colon is no declaration.
 */
function declarationsOf(block: string): Declaration[] {
  const out: Declaration[] = [];
  for (const part of splitTopLevel(block.replace(COMMENT, ''), ';')) {
    const text = part.trim();
    const colon = text.indexOf(':');
    if (colon <= 0) continue;
    const name = text.slice(0, colon).trim();
    out.push({ name: name.startsWith('--') ? name : name.toLowerCase(), text });
  }
  return out;
}

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

/**
 * Declaration blocks: a declaration whose value is still the one the rewrite gave it takes the
 * original declaration of its name back; the others are the page's, as it wrote them.
 */
export const mergeDeclarations: Merge = (original, applied, current) => {
  const kept = new Map(declarationsOf(original).map(d => [d.name, d.text] as const));
  const was = valuesOf(applied);
  const now = valuesOf(current);
  return declarationsOf(current)
    .map(d => {
      const own = kept.get(d.name);
      return own !== undefined && was.get(d.name) === now.get(d.name) ? own : d.text;
    })
    .join('; ');
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
 * Lists separated by commas (media queries, the entries of `sizes`): an entry the page did not change
 * takes back the original entry it was rewritten from, wherever it now is in the list.
 */
export const mergeList: Merge = (original, applied, current) => {
  const kept = splitTopLevel(original, ',');
  const shown = splitTopLevel(applied, ',').map(part => part.trim());
  const now = splitTopLevel(current, ',');
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
