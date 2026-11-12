import type { Protocol } from 'devtools-protocol';
import { Tok, tokenize } from '../css/sheets/parse/css-lexer';
import { asciiLower, decodeEscapes, splitMediaQueries, trimWhitespace } from './css-tokens';
import type { Rewrite } from './rewrite';

/**
 * The media features Emulation.setEmulatedMedia can set here, with their values. Chrome ignores a name it
 * does not know. A value it does not know takes its feature back to the real value, whichever call set it
 * (MediaEmulation). Within one call, the last value given for a name decides. A query names the same
 * values: one with another value is unknown, and is left as it is (rewriteQuery). prefers-reduced-data is
 * not one of them: Chrome 157 does not emulate it (set to either value, it matches nothing), so its queries
 * are not rewritten.
 */
const FEATURES: Record<string, string[]> = {
  'prefers-color-scheme': ['light', 'dark'],
  'prefers-reduced-motion': ['no-preference', 'reduce'],
  'prefers-reduced-transparency': ['no-preference', 'reduce'],
  'prefers-contrast': ['no-preference', 'more', 'less', 'custom'],
  'forced-colors': ['none', 'active'],
  // In order: a screen that shows p3 shows srgb too.
  'color-gamut': ['srgb', 'p3', 'rec2020'],
};
/** Values for which a feature is false in a boolean context, `(prefers-reduced-motion)`. */
const FALSE_IN_BOOLEAN = new Set(['none', 'no-preference']);
/** Media conditions that always and never hold, put in place of an emulated feature. */
const TRUE = '(min-width: 0px)';
const FALSE = '(not (min-width: 0px))';
/** A media type no medium is: put in place of the types other than the emulated one. */
const NO_TYPE = 'devtools-anywhere-none';
/** Words that are never a media type: `layer` too, as the media type production leaves it out (Media Queries 4). */
const KEYWORDS = new Set(['and', 'layer', 'not', 'only', 'or']);

/**
 * Whether `(name: wanted)` holds where the feature `name` is `value`. `wanted` is one of the feature's values
 * (rewriteQuery checks it first), and so is `value` (mediaRewrite does), so both have a place in the order.
 */
function holds(name: string, value: string, wanted: string | undefined): boolean {
  if (wanted === undefined) return !FALSE_IN_BOOLEAN.has(value);
  if (name !== 'color-gamut') return wanted === value;
  const order = FEATURES[name] ?? [];
  return order.indexOf(wanted) <= order.indexOf(value);
}

/**
 * One media query, trimmed, rewritten. Its media type becomes `all` when it is the emulated type (or
 * `all`), and NO_TYPE otherwise; with no emulated type, no type is changed. The type is the first
 * identifier, or the one after `not` or `only`, when the identifier after it is `and` or nothing; a
 * query of another form has no type to change. A feature is `(name)` or `(name: value)` with a single
 * identifier as its value, and it becomes TRUE or FALSE when the emulation sets it; a value the feature
 * does not have makes its block unknown, so the block is left as it is. A block of any other form is left
 * as it is, but a feature inside it is still rewritten.
 */
function rewriteQuery(query: string, type: string, features: ReadonlyMap<string, string>): string {
  const { kinds, starts } = tokenize(query);
  const n = kinds.length;
  const kind = (i: number) => kinds[i] ?? Tok.Eof;
  const text = (i: number) => query.slice(starts[i] ?? query.length, starts[i + 1] ?? query.length);
  /** The first token from `i` that is neither whitespace nor a comment. */
  const skip = (i: number) => {
    let j = i;
    while (kind(j) === Tok.Ws || kind(j) === Tok.Comment) j++;
    return j;
  };
  /**
   * The text of the identifier token `i` with its escapes decoded and its ASCII letters lowercased, or
   * undefined when that token is not an identifier: how CSS compares the words of a media query.
   */
  const word = (i: number) => (kind(i) === Tok.Ident ? asciiLower(decodeEscapes(text(i))) : undefined);
  /** Whether the token `i` closes a block: a `)`, or the end of the query, where CSS closes it. */
  const closes = (i: number) => i >= n || kind(i) === Tok.RParen;

  const first = skip(0);
  const keyword = word(first);
  const typeAt = keyword === 'not' || keyword === 'only' ? skip(first + 1) : first;
  const name = word(typeAt);
  const next = skip(typeAt + 1);
  // The types are left alone when the emulation sets none.
  const isType = type !== '' && name !== undefined && !KEYWORDS.has(name) && (next >= n || word(next) === 'and');
  const typeText = name === 'all' || name === type ? 'all' : NO_TYPE;

  /**
   * The feature block whose `(` is token `open`, if the emulation sets it and the block names one of its
   * values: its last token, and what it becomes.
   */
  const feature = (open: number): { end: number; becomes: string } | null => {
    const nameAt = skip(open + 1);
    const key = word(nameAt);
    if (key === undefined) return null;
    const emulated = features.get(key);
    if (emulated === undefined) return null;
    const after = skip(nameAt + 1);
    if (closes(after)) return { end: after, becomes: holds(key, emulated, undefined) ? TRUE : FALSE };
    if (kind(after) !== Tok.Colon) return null;
    const valueAt = skip(after + 1);
    const value = word(valueAt);
    const close = skip(valueAt + 1);
    if (value === undefined || !closes(close)) return null;
    // A value the feature does not have is unknown, not false, and `not` keeps it unknown: left to the browser.
    if (!FEATURES[key]?.includes(value)) return null;
    return { end: close, becomes: holds(key, emulated, value) ? TRUE : FALSE };
  };

  let out = '';
  for (let i = 0; i < n; i++) {
    if (isType && i === typeAt) {
      out += typeText;
      continue;
    }
    if (kind(i) === Tok.LParen) {
      const block = feature(i);
      if (block) {
        out += block.becomes;
        i = block.end;
        continue;
      }
    }
    out += text(i);
  }
  return out;
}

/**
 * The value that Emulation.setEmulatedMedia gives a feature, read as Chrome reads it: the first identifier of
 * the value, once the comments before it are skipped, with its escapes decoded and its ASCII letters
 * lowercased. What follows it is ignored; a value that starts with whitespace, or with no identifier, is none.
 */
function emulatedValue(value: string): string | undefined {
  // As CSS reads it (CSS Syntax 3.3), a NUL is U+FFFD, a name character: it belongs to the identifier.
  const text = value.replaceAll('\u0000', '\uFFFD');
  const { kinds, starts } = tokenize(text);
  let i = 0;
  while (kinds[i] === Tok.Comment) i++;
  if (kinds[i] !== Tok.Ident) return undefined;
  return asciiLower(decodeEscapes(text.slice(starts[i], starts[i + 1] ?? text.length)));
}

/**
 * The value a feature takes from a value given to it, or undefined when Chrome does not read the value as one
 * the feature has: an unknown name is no feature at all. The name is compared as it is: Chrome takes
 * `Prefers-Color-Scheme` for no feature, and `constructor` is none either (an own property of FEATURES only).
 */
function featureValue(name: string, value: string): string | undefined {
  if (!Object.hasOwn(FEATURES, name)) return undefined;
  const v = emulatedValue(value);
  return v !== undefined && FEATURES[name]?.includes(v) ? v : undefined;
}

/**
 * The media emulation of a page, as Chrome keeps it for Emulation.setEmulatedMedia: one media type, and one
 * value per feature name, shared by the page's sessions. A call of a session sets the media type to its
 * `media` (none when it is omitted, as `media: ''`: the same), and replaces the features that session set:
 * the names it set before are taken back, whichever session set them since, and the features of the call
 * are set, the last value of a name deciding (a value Chrome does not read takes its name back). The
 * features of the other sessions stay. A session that ends is a call with nothing: its features are taken
 * back, and the media type is none, whichever session set it. Measured on Chrome 157 with several sessions.
 */
export class MediaEmulation {
  #type = '';
  readonly #features = new Map<string, string>();
  /** The feature names each session's last call gave: its next call, or its end, takes them back. */
  readonly #names = new WeakMap<object, string[]>();

  /** Applies a call of `session` with `params`; returns the rewrite now in effect, or null for none. */
  set(session: object, params: Protocol.Emulation.SetEmulatedMediaRequest): Rewrite | null {
    this.#type = asciiLower(params.media ?? '');
    for (const name of this.#names.get(session) ?? []) this.#features.delete(name);
    const names: string[] = [];
    for (const { name, value } of params.features ?? []) {
      names.push(name);
      const v = featureValue(name, value);
      if (v === undefined) this.#features.delete(name);
      else this.#features.set(name, v);
    }
    this.#names.set(session, names);
    return rewriteOf(this.#type, this.#features);
  }

  /** `session` ends, as a call with nothing: returns the rewrite now in effect, or null for none. */
  end(session: object): Rewrite | null {
    return this.set(session, {});
  }

  /** The color scheme the page's `prefers-color-scheme` is emulated as, or undefined when it is not. */
  colorScheme(): 'light' | 'dark' | undefined {
    const value = this.#features.get('prefers-color-scheme');
    return value === 'light' || value === 'dark' ? value : undefined;
  }
}

/**
 * The rewrite of media query lists for a media type and feature values, or null when they emulate nothing:
 * each query for the emulated media type (`print`) has its type made `all`, and the queries for another type
 * one matching nothing; each emulated feature is made a condition that holds or not, as it would with the
 * emulated value. The values are copied: a later change of the page's media emulation does not change it.
 */
function rewriteOf(type: string, features: ReadonlyMap<string, string>): Rewrite | null {
  if (!type && !features.size) return null;
  const values = new Map(features);
  return text =>
    splitMediaQueries(text)
      .map(query => rewriteQuery(trimWhitespace(query), type, values))
      .join(', ');
}

/**
 * The rewrite of media query lists for `params` as the only call a page has had, or null when they emulate
 * nothing (see MediaEmulation for calls that follow each other).
 */
export function mediaRewrite(params: Protocol.Emulation.SetEmulatedMediaRequest): Rewrite | null {
  return new MediaEmulation().set({}, params);
}

/**
 * `text`, a media query list, rewritten as mediaRewrite does for `params`, or unchanged when `params`
 * emulate nothing. It reads and writes no page state; nothing calls it. A matchMedia() hook would take the
 * page's rewrite instead (rewrite.ts, currentMediaRewrite), which follows the calls of every session.
 */
export function rewriteMediaQuery(text: string, params: Protocol.Emulation.SetEmulatedMediaRequest): string {
  const rewrite = mediaRewrite(params);
  return rewrite ? rewrite(text) : text;
}
