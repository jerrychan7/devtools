// List markers, as Chrome puts them in the tree: the ::marker of a list item (generatesMarker) is
// a ListMarker node, its host's first child, named after the marker's text and with one ignored
// child per run of that text. Not part of the host's name. Part of accessibility.js (ax-node.ts).
import { styleOf } from '../../core/realm';
import { contentText, counterText, counterValues, markerSuffix, unescape } from './ax-counter';
import { attr, generatesMarker } from './ax-tree';

/** A marker's text: its name, the texts of its children, and whether it is alternative text only. */
export interface MarkerText {
  name: string;
  parts: string[];
  /** `content: … / "alt"`: Chrome shows the marker as a StaticText of the alternative text. */
  alt: boolean;
}

/**
 * The items of a `content` value, in order: strings and attr() as `plain` text, counters with
 * their numbers, quotes without a text (worked out in the rendered text only, ax-counter.ts).
 */
function contentParts(content: string, el: Element): { text: string; plain: boolean }[] {
  const parts: { text: string; plain: boolean }[] = [];
  for (const [item, text, name] of content.matchAll(
    /"((?:[^"\\]|\\.)*)"|attr\(\s*([\w-]+)\s*\)|[\w-]+\([^)]*\)|(?:no-)?(?:open|close)-quote/g
  )) {
    if (text !== undefined) parts.push({ text: unescape(text), plain: true });
    else if (name !== undefined) parts.push({ text: attr(el, name) ?? '', plain: true });
    else parts.push({ text: item.endsWith('quote') ? '' : contentText(item, el, '::before', true), plain: false });
  }
  return parts;
}

/**
 * The text of an element's list marker, or null when it shows none. From ::marker's content when
 * it has one: its strings as the name, or no name with a counter or a quote in it (Chrome gives
 * those to the children only), one child per run of strings and per counter or quote. Else from
 * list-style-type: a string, or the list-item counter in the style with its suffix ("1. ", "• ").
 */
export function markerText(el: Element): MarkerText | null {
  if (!generatesMarker(el)) return null;
  const content = styleOf(el, '::marker').content;
  if (content !== 'normal') {
    const [shown = '', alt] = content.split(/\s\/\s/);
    if (alt !== undefined)
      return {
        name: contentParts(alt, el)
          .map(p => p.text)
          .join(''),
        parts: [],
        alt: true,
      };
    const items = contentParts(shown, el);
    const parts: string[] = [];
    let run = false;
    for (const { text, plain } of items) {
      if (plain && !text) continue;
      if (plain && run) parts[parts.length - 1] += text;
      else parts.push(text);
      run = plain;
    }
    return { name: items.every(p => p.plain) ? parts.join('') : '', parts, alt: false };
  }
  const type = styleOf(el).listStyleType;
  const text = /^["']/.test(type)
    ? unescape(type.slice(1, -1))
    : counterText(counterValues(el, '::before', 'list-item').pop() ?? 0, type) + markerSuffix(type);
  return { name: text, parts: text ? [text] : [], alt: false };
}
