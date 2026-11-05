import type { Protocol } from 'devtools-protocol';
import { splitTopLevel } from '../../core/style/selectors';
import type { Rewrite } from './rewrite';

/**
 * The media features Emulation.setEmulatedMedia can set here, with their values. Chrome ignores
 * a value it does not know (the feature keeps its real value); so do we, and with names too.
 */
const FEATURES: Record<string, string[]> = {
  'prefers-color-scheme': ['light', 'dark'],
  'prefers-reduced-motion': ['no-preference', 'reduce'],
  'prefers-reduced-data': ['no-preference', 'reduce'],
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

/** Whether `(name: wanted)` holds where the feature `name` is `value`. */
function holds(name: string, value: string, wanted: string | undefined): boolean {
  if (wanted === undefined) return !FALSE_IN_BOOLEAN.has(value);
  if (name !== 'color-gamut') return wanted === value;
  const order = FEATURES[name] ?? [];
  const at = order.indexOf(wanted);
  return at >= 0 && at <= order.indexOf(value);
}

/**
 * The rewrite of media query lists for Emulation.setEmulatedMedia's params, or null when they
 * emulate nothing: each query for the emulated media type (`print`) has its type made `all`, and
 * the queries for another type one matching nothing; each emulated feature is made a condition
 * that holds or not, as it would with the emulated value.
 */
export function mediaRewrite(params: Protocol.Emulation.SetEmulatedMediaRequest): Rewrite | null {
  const type = (params.media ?? '').toLowerCase();
  const features = new Map<string, string>();
  for (const { name, value } of params.features ?? []) {
    const key = name.toLowerCase();
    const v = value.toLowerCase();
    if (FEATURES[key]?.includes(v)) features.set(key, v);
  }
  if (!type && !features.size) return null;
  const feature = features.size
    ? new RegExp(`\\(\\s*(${[...features.keys()].join('|')})\\s*(?::\\s*([\\w-]+)\\s*)?\\)`, 'gi')
    : null;
  return text =>
    splitTopLevel(text, ',')
      .map(query => {
        let out = query.trim();
        if (type) {
          out = out.replace(
            /^((?:not|only)\s+)?([a-z][\w-]*)(?=\s+and\b|$)/i,
            (_, prefix: string | undefined, t: string) =>
              `${prefix ?? ''}${t.toLowerCase() === 'all' || t.toLowerCase() === type ? 'all' : NO_TYPE}`
          );
        }
        if (feature) {
          out = out.replace(feature, (_, name: string, wanted: string | undefined) => {
            const key = name.toLowerCase();
            return holds(key, features.get(key) ?? '', wanted?.toLowerCase()) ? TRUE : FALSE;
          });
        }
        return out;
      })
      .join(', ');
}
