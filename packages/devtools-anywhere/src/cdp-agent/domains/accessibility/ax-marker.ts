// List markers, as Chrome puts them in the tree: the ::marker of a list item (generatesMarker) is
// a ListMarker node, its host's first child, named after the marker's text and with one ignored
// child per run of that text; a quote is an ignored node over a StaticText of its own instead.
// Not part of the host's name. Part of accessibility.js (ax-node.ts).
import { styleOf } from '../../core/realm';
import { contentText, counterText, counterValues, markerAffixes, unescape } from './ax-counter';
import { attr, generatesMarker } from './ax-tree';

/** A marker's text: its name, the texts of its children, and whether it is alternative text only. */
export interface MarkerText {
  name: string;
  parts: string[];
  /** Whether each part is a quote. */
  quotes: boolean[];
  /** `content: … / "alt"`: Chrome shows the marker as a StaticText of the alternative text. */
  alt: boolean;
}

/**
 * The items of a `content` value, in order: strings and attr() as `plain` text, counters with
 * their numbers, quotes with theirs (`alt`: none, as quotes only show in the rendered text). A
 * quote's text depends on the quotes before it: the text of the quotes so far, less theirs.
 */
function contentParts(content: string, el: Element, alt = false): { text: string; plain: boolean; quote?: boolean }[] {
  const parts: { text: string; plain: boolean; quote?: boolean }[] = [];
  let quotes = '';
  for (const [item, text, name] of content.matchAll(
    /"((?:[^"\\]|\\.)*)"|attr\(\s*([\w-]+)\s*\)|[\w-]+\([^)]*\)|(?:no-)?(?:open|close)-quote/g
  )) {
    if (text !== undefined) parts.push({ text: unescape(text), plain: true });
    else if (name !== undefined) parts.push({ text: attr(el, name) ?? '', plain: true });
    else if (item.endsWith('quote')) {
      const before = alt ? '' : contentText(quotes, el, '::before', false);
      quotes += ` ${item}`;
      parts.push({
        text: alt ? '' : contentText(quotes, el, '::before', false).slice(before.length),
        plain: false,
        quote: true,
      });
    } else parts.push({ text: contentText(item, el, '::before', true), plain: false });
  }
  return parts;
}

/**
 * The text of an element's list marker, or null when it shows none. From ::marker's content when
 * it has one: its strings as the name, or no name with a counter or a quote in it (Chrome gives
 * those to the children only), one child per run of strings and per counter or quote. Else from
 * list-style-type: a string, or the list-item counter in the style with its suffix ("1. ", "• ").
 * None with empty alternative text (`content: "x" / ""`), which Chrome leaves out.
 */
export function markerText(el: Element): MarkerText | null {
  if (!generatesMarker(el)) return null;
  const content = styleOf(el, '::marker').content;
  if (content !== 'normal') {
    const [shown = '', alt] = content.split(/\s\/\s/);
    if (alt !== undefined) {
      const name = contentParts(alt, el, true)
        .map(p => p.text)
        .join('');
      // Empty alternative text: Chrome leaves the marker out of the tree.
      if (!name) return null;
      return {
        name,
        parts: [],
        quotes: [],
        alt: true,
      };
    }
    const items = contentParts(shown, el);
    const parts: string[] = [];
    const quotes: boolean[] = [];
    let run = false;
    for (const { text, plain, quote } of items) {
      if (plain && !text) continue;
      if (plain && run) parts[parts.length - 1] += text;
      else {
        parts.push(text);
        quotes.push(!!quote);
      }
      run = plain;
    }
    return { name: items.every(p => p.plain) ? parts.join('') : '', parts, quotes, alt: false };
  }
  const type = styleOf(el).listStyleType;
  const [prefix, suffix] = markerAffixes(type, el.ownerDocument);
  const text = /^["']/.test(type)
    ? unescape(type.slice(1, -1))
    : prefix + counterText(counterValues(el, '::before', 'list-item').pop() ?? 0, type, el.ownerDocument) + suffix;
  return { name: text, parts: text ? [text] : [], quotes: text ? [false] : [], alt: false };
}
