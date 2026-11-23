// Generated content of ::before and ::after, as Chrome puts it in the tree: a pseudo-element that
// shows `content` is an ignored node (uninteresting) of its host, first or last, with one child per
// item of its text: a StaticText per run of strings and attr(), one per counter, an ignored node
// over a StaticText per quote, an image per url(). With alternative text (`content: … / "alt"`) it
// is a StaticText of that text, without children; with empty alternative text it is not in the
// tree. Laid out as a box (inline-block, block, floated or positioned) it is a generic over its
// items instead, not in the tree when a block without text; as a flex or grid container, an ignored
// node over the generic of its anonymous item. Part of accessibility.js (ax-node.ts).
import { styleOf } from '../../core/realm';
import { contentText } from './ax-counter';
import { OPAQUE } from './ax-tree';

export type GeneratedPseudo = '::before' | '::after';

/** An item of a pseudo-element's content, as a child of its node. */
export interface GeneratedPart {
  kind: 'text' | 'quote' | 'image';
  text: string;
}

/** A pseudo-element's content in the tree: its alternative text, or its parts and how it is laid out. */
export type GeneratedContent = { alt: string } | { parts: GeneratedPart[]; box: 'inline' | 'block' | 'flex' };

const ITEM =
  /"(?:[^"\\]|\\.)*"|attr\(\s*[\w-]+\s*\)|counters?\([^)]*\)|(?:no-)?(?:open|close)-quote|url\((?:"(?:[^"\\]|\\.)*"|[^)]*)\)|image-set\([^)]*\)|[\w-]+\([^)]*\)/g;

/**
 * Whether a pseudo-element shows in the tree: a ::before or ::after with content, displayed, on an
 * element that renders its children (no replaced element, no SVG).
 */
function shows(el: Element, pseudo: GeneratedPseudo): boolean {
  if (OPAQUE.has(el.localName) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
  const style = styleOf(el, pseudo);
  return !/^(none|normal)$/.test(style.content) && style.display !== 'none';
}

/** Whether a pseudo-element is visibility: hidden: Chrome keeps its node, ignored and empty. */
export const pseudoHidden = (el: Element, pseudo: GeneratedPseudo) =>
  /^(hidden|collapse)$/.test(styleOf(el, pseudo).visibility);

/**
 * The content of an element's ::before or ::after in the tree, or null when it has no node. The
 * text of a run has its spaces collapsed, the leading one of a ::before's first dropped; a run of
 * spaces only is named with two, as in Chrome.
 */
export function generatedContent(el: Element, pseudo: GeneratedPseudo): GeneratedContent | null {
  if (!shows(el, pseudo)) return null;
  const { content, display } = styleOf(el, pseudo);
  const box = display === 'inline' ? 'inline' : /flex|grid/.test(display) ? 'flex' : 'block';
  const [shown = '', alt] = content.split(/\s\/\s/);
  if (alt !== undefined && box === 'inline') {
    const text = contentText(alt, el, pseudo, true);
    return text ? { alt: text } : null;
  }
  const parts: GeneratedPart[] = [];
  let prefix = '';
  let run = false;
  for (const [item] of shown.matchAll(ITEM)) {
    const before = prefix;
    prefix += ` ${item}`;
    if (/^(url|image-set)\(/.test(item)) {
      parts.push({ kind: 'image', text: '' });
      run = false;
    } else if (item.endsWith('quote')) {
      // A quote's text depends on the quotes before it: the text of the items so far, less theirs.
      const text = contentText(prefix, el, pseudo, false).slice(contentText(before, el, pseudo, false).length);
      if (text) parts.push({ kind: 'quote', text });
      run = false;
    } else if (/^counters?\(/.test(item)) {
      // Rendered, a counter in the style none shows nothing (its alternative text has the number).
      const text = /,\s*none\s*\)$/.test(item) ? '' : contentText(item, el, pseudo, true);
      if (text) parts.push({ kind: 'text', text });
      run = false;
    } else {
      // A string or attr(), which Chrome resolves in the computed value already.
      const text = contentText(item.startsWith('"') ? item : '', el, pseudo, false);
      if (!text) continue;
      const last = parts.at(-1);
      if (run && last) last.text += text;
      else parts.push({ kind: 'text', text });
      run = true;
    }
  }
  parts.forEach((part, i) => {
    if (part.kind !== 'text') return;
    let text = part.text.replace(/[ \t\n\f\r]+/g, ' ');
    if (text === ' ') text = '  ';
    else if (i === 0 && pseudo === '::before' && text.startsWith(' ')) text = text.slice(1);
    part.text = text;
  });
  // An inline-block holds its place without text; a block does not.
  if (!parts.length && box !== 'inline' && !display.startsWith('inline-')) return null;
  return { parts, box };
}
