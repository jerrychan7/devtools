import { splitTopLevel } from '../../core/style/selectors';
import type { Rewrite } from './rewrite';

/**
 * The `sizes` of an <img> or <source>, a comma-separated list of entries, each an optional media
 * condition and a length (`(min-width: 600px) 50vw, 100px`). The media rewrite changes each
 * condition alone, where it changes one: everything else is left as the page wrote it.
 */
export function sizesRewrite(media: Rewrite): Rewrite {
  return text =>
    splitTopLevel(text, ',')
      .map(entry => rewriteEntry(entry, media))
      .join(',');
}

/** The top-level tokens of `text`, as [start, end) ranges: white space separates them outside parentheses. */
function tokensOf(text: string): [number, number][] {
  const tokens: [number, number][] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (depth === 0 && /\s/.test(c)) {
      if (start >= 0) tokens.push([start, i]);
      start = -1;
      continue;
    }
    if (start < 0) start = i;
    if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
  }
  if (start >= 0) tokens.push([start, text.length]);
  return tokens;
}

/** One entry: its last token is the length, the tokens before it its media condition. */
function rewriteEntry(entry: string, media: Rewrite): string {
  const tokens = tokensOf(entry);
  const first = tokens[0];
  const beforeLength = tokens[tokens.length - 2];
  if (!first || !beforeLength || tokens.length < 2) return entry;
  const [start] = first;
  const [, end] = beforeLength;
  return entry.slice(0, start) + media(entry.slice(start, end)) + entry.slice(end);
}
