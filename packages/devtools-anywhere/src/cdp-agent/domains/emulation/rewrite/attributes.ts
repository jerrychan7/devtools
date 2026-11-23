import { splitLast, splitMediaQueries } from './css-tokens';
import type { Rewrite } from './rewrite';

/**
 * The `sizes` of an <img> or <source>, a comma-separated list of entries, each an optional media
 * condition and a length (`(min-width: 600px) 50vw, 100px`). The media rewrite changes each
 * condition alone, where it changes one: everything else is left as the page wrote it. The entries and
 * their parts are found by their tokens, as the browser finds them: a comma in a comment separates nothing.
 */
export function sizesRewrite(media: Rewrite): Rewrite {
  return text =>
    splitMediaQueries(text)
      .map(entry => rewriteEntry(entry, media))
      .join(',');
}

/** One entry: its last component is the length, what comes before it its media condition. */
function rewriteEntry(entry: string, media: Rewrite): string {
  const parts = splitLast(entry);
  if (!parts) return entry;
  const [start, end] = parts.before;
  return entry.slice(0, start) + media(entry.slice(start, end)) + entry.slice(end);
}
