import type { Protocol } from 'devtools-protocol';
import { Tok, tokenize } from '../css/sheets/parse/css-lexer';
import { asciiLower, decodeEscapes, splitMediaQueries, trimWhitespace } from './css-tokens';
import type { Rewrite } from './rewrite';

/**
 * The media features Emulation.setEmulatedMedia can set here, with their values. Chrome ignores
 * a value it does not know (the feature keeps its real value), and so do we, with names too. But such
 * a value given after a known one for the same feature cancels it: Chrome keeps only the last value
 * given for a name. A query names the same values: one with another value is unknown, and is left as
 * it is (rewriteQuery). prefers-reduced-data is not one of them: Chrome 157 does not emulate it (set to
 * either value, it matches nothing), so its queries are not rewritten.
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
 * The rewrite of media query lists for Emulation.setEmulatedMedia's params, or null when they
 * emulate nothing: each query for the emulated media type (`print`) has its type made `all`, and
 * the queries for another type one matching nothing; each emulated feature is made a condition
 * that holds or not, as it would with the emulated value.
 */
export function mediaRewrite(params: Protocol.Emulation.SetEmulatedMediaRequest): Rewrite | null {
  const type = asciiLower(params.media ?? '');
  const features = new Map<string, string>();
  for (const { name, value } of params.features ?? []) {
    // Own properties only: `constructor` is not a feature. The name is compared as it is: Chrome takes
    // `Prefers-Color-Scheme` for no feature. A value Chrome does not read clears the one before it, so the
    // feature keeps its real value, as it does without any emulation.
    if (!Object.hasOwn(FEATURES, name)) continue;
    const v = emulatedValue(value);
    if (v !== undefined && FEATURES[name]?.includes(v)) features.set(name, v);
    else features.delete(name);
  }
  if (!type && !features.size) return null;
  return text =>
    splitMediaQueries(text)
      .map(query => rewriteQuery(trimWhitespace(query), type, features))
      .join(', ');
}

/**
 * `text`, a media query list, rewritten as mediaRewrite does for `params`, or unchanged when `params`
 * emulate nothing. It reads and writes no page state, so a matchMedia() hook can use it; nothing calls
 * it yet.
 */
export function rewriteMediaQuery(text: string, params: Protocol.Emulation.SetEmulatedMediaRequest): string {
  const rewrite = mediaRewrite(params);
  return rewrite ? rewrite(text) : text;
}
