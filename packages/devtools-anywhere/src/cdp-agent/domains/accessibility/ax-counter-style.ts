// Counter styles of @counter-style rules (CSS Counter Styles 3), read from the document's style
// sheets (CSSCounterStyleRule): a counter's text by the rule's system, symbols, additive-symbols,
// range, pad, negative and fallback, and a list marker's prefix and suffix. Part of
// accessibility.js (ax-counter.ts).
import { unescape } from './ax-counter';

/** A @counter-style rule's descriptors, as the CSSOM gives them ("" when not set). */
interface CounterStyleRule {
  name: string;
  system: string;
  symbols: string;
  additiveSymbols: string;
  negative: string;
  prefix: string;
  suffix: string;
  range: string;
  pad: string;
  fallback: string;
}

/** The names a rule cannot take: these keep their predefined styles. */
const RESERVED = /^(decimal|disc|square|circle|disclosure-open|disclosure-closed|none|inherit|initial|unset)$/;

/** The rules of each document by name, kept while one command works on the tree. */
const cache = new WeakMap<Document, Map<string, CounterStyleRule>>();

function collect(rules: CSSRuleList, out: Map<string, CounterStyleRule>): void {
  for (const rule of rules) {
    // CSSRule.COUNTER_STYLE_RULE; by number, as the rule may be of another realm.
    if (rule.type === 11) {
      const r = rule as unknown as CounterStyleRule;
      out.set(r.name, r);
    } else if ('cssRules' in rule) {
      try {
        collect((rule as CSSGroupingRule).cssRules, out);
      } catch {
        // Not readable.
      }
    }
  }
}

/** The @counter-style rule named `name` in a document, the last one when several are. */
function ruleOf(doc: Document, name: string): CounterStyleRule | undefined {
  if (RESERVED.test(name)) return undefined;
  let rules = cache.get(doc);
  if (!rules) {
    rules = new Map();
    for (const sheet of [...doc.styleSheets, ...(doc.adoptedStyleSheets ?? [])]) {
      try {
        collect(sheet.cssRules, rules);
      } catch {
        // A style sheet of another origin cannot be read.
      }
    }
    cache.set(doc, rules);
    queueMicrotask(() => cache.delete(doc));
  }
  return rules.get(name);
}

/** The symbols of a descriptor: its strings and identifiers, in order. */
function symbolsOf(value: string): string[] {
  const out: string[] = [];
  for (const [, dq, sq, ident] of value.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s,"']+)/g))
    out.push(unescape(dq ?? sq ?? ident ?? ''));
  return out;
}

/** A style resolved from a rule and the rules it extends: its algorithm and descriptors. */
interface Resolved {
  system: string;
  /** `fixed`'s first value. */
  first: number;
  symbols: string[];
  additive: [number, string][];
  negative: [string, string];
  prefix: string;
  suffix: string;
  range: [number, number][] | null;
  pad: [number, string] | null;
  fallback: string;
  /** For a rule that extends a predefined style: that style. */
  predefined?: string;
}

function resolve(doc: Document, name: string, seen = new Set<string>()): Resolved | null {
  const rule = ruleOf(doc, name);
  if (!rule || seen.has(name)) return null;
  seen.add(name);
  const [system = 'symbolic', arg = ''] = (rule.system || 'symbolic').trim().split(/\s+/);
  let base: Resolved;
  if (system === 'extends') {
    // Extending a style of no rule: a predefined one, decimal when not known.
    base = resolve(doc, arg, seen) ?? {
      system: 'predefined',
      first: 1,
      symbols: [],
      additive: [],
      negative: ['-', ''],
      prefix: '',
      suffix: '. ',
      range: null,
      pad: null,
      fallback: 'decimal',
      predefined: arg,
    };
  } else
    base = {
      system,
      first: system === 'fixed' && arg ? parseInt(arg, 10) : 1,
      symbols: symbolsOf(rule.symbols),
      additive: [],
      negative: ['-', ''],
      prefix: '',
      suffix: '. ',
      range: null,
      pad: null,
      fallback: 'decimal',
    };
  if (system !== 'extends' && rule.additiveSymbols)
    base.additive = rule.additiveSymbols.split(',').map(pair => {
      const weight = /-?\d+/.exec(pair)?.[0] ?? '0';
      return [parseInt(weight, 10), symbolsOf(pair.replace(weight, ''))[0] ?? ''];
    });
  const out = { ...base };
  if (rule.negative) {
    const [neg = '', after = ''] = symbolsOf(rule.negative);
    out.negative = [neg, after];
  }
  if (rule.prefix) out.prefix = symbolsOf(rule.prefix)[0] ?? '';
  if (rule.suffix) out.suffix = symbolsOf(rule.suffix)[0] ?? '';
  if (rule.range && rule.range !== 'auto')
    out.range = rule.range.split(',').map(r => {
      const [low = '', high = ''] = r.trim().split(/\s+/);
      return [low === 'infinite' ? -Infinity : +low, high === 'infinite' ? Infinity : +high];
    });
  if (rule.pad) {
    const count = /\d+/.exec(rule.pad)?.[0];
    out.pad = [count ? +count : 0, symbolsOf(rule.pad.replace(/\b\d+\b/, ''))[0] ?? ''];
  }
  if (rule.fallback) out.fallback = rule.fallback.trim();
  return out;
}

/** Whether a system writes negative numbers with the negative sign. */
const usesNegative = (system: string) => /^(symbolic|alphabetic|numeric|additive)$/.test(system);

function inRange(n: number, style: Resolved): boolean {
  if (style.range) return style.range.some(([low, high]) => n >= low && n <= high);
  if (/^(alphabetic|symbolic)$/.test(style.system)) return n >= 1;
  if (style.system === 'additive') return n >= 0;
  return true;
}

/** `n` (not below 0 for the systems with a negative sign) by a system, or null when it cannot be. */
function initial(n: number, style: Resolved): string | null {
  const { symbols } = style;
  const len = symbols.length;
  switch (style.system) {
    case 'cyclic':
      return len ? (symbols[(((n - 1) % len) + len) % len] ?? null) : null;
    case 'fixed':
      return n >= style.first && n < style.first + len ? (symbols[n - style.first] ?? null) : null;
    case 'symbolic':
      return len && n >= 1 ? (symbols[(n - 1) % len] ?? '').repeat(Math.ceil(n / len)) : null;
    case 'alphabetic': {
      if (len < 2 || n < 1) return null;
      let out = '';
      for (; n > 0; n = Math.floor((n - 1) / len)) out = (symbols[(n - 1) % len] ?? '') + out;
      return out;
    }
    case 'numeric': {
      if (len < 2) return null;
      if (n === 0) return symbols[0] ?? null;
      let out = '';
      for (; n > 0; n = Math.floor(n / len)) out = (symbols[n % len] ?? '') + out;
      return out;
    }
    case 'additive': {
      const weights = style.additive;
      if (n === 0) return weights.find(([w]) => w === 0)?.[1] ?? null;
      let out = '';
      for (const [weight, symbol] of weights) {
        if (weight <= 0) continue;
        const times = Math.floor(n / weight);
        out += symbol.repeat(times);
        n -= times * weight;
      }
      return n ? null : out;
    }
  }
  return null;
}

/** The number of grapheme clusters of a text, roughly: its code points less combining marks. */
const graphemes = (text: string) => [...text.replace(/\p{M}/gu, '')].length;

/**
 * `n` in the style of the @counter-style rule `name` of a document, or null when no rule has the
 * name. `predefined` writes a number in a predefined style (ax-counter.ts), for fallbacks and the
 * styles a rule extends.
 */
export function customCounterText(
  doc: Document,
  name: string,
  n: number,
  predefined: (n: number, style: string) => string,
  seen = new Set<string>()
): string | null {
  const style = resolve(doc, name);
  if (!style) return null;
  const fallback = () => {
    if (seen.has(name)) return predefined(n, 'decimal');
    seen.add(name);
    return customCounterText(doc, style.fallback, n, predefined, seen) ?? predefined(n, style.fallback);
  };
  if (style.predefined !== undefined) return predefined(n, style.predefined);
  if (!inRange(n, style)) return fallback();
  const negative = n < 0 && usesNegative(style.system);
  const text = initial(negative ? -n : n, style);
  if (text === null) return fallback();
  let out = text;
  if (style.pad) {
    const [count, symbol] = style.pad;
    const sign = negative ? graphemes(style.negative[0]) + graphemes(style.negative[1]) : 0;
    const missing = count - graphemes(text) - sign;
    if (missing > 0) out = symbol.repeat(missing) + out;
  }
  return negative ? style.negative[0] + out + style.negative[1] : out;
}

/** The prefix and suffix a list marker writes around its number in a rule's style, or null. */
export function customMarkerAffixes(doc: Document, name: string): [string, string] | null {
  const style = resolve(doc, name);
  return style ? [style.prefix, style.suffix] : null;
}
