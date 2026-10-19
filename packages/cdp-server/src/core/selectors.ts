import type { Protocol } from 'devtools-protocol';

type Specificity = Protocol.CSS.Specificity;

/** Splits on top-level occurrences of `separator`, ignoring those inside (), [] and quotes. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
const add = (x: Specificity, y: Specificity): Specificity => ({ a: x.a + y.a, b: x.b + y.b, c: x.c + y.c });
const compare = (x: Specificity, y: Specificity) => x.a - y.a || x.b - y.b || x.c - y.c;
const max = (list: Specificity[]) => list.reduce((m, s) => (compare(s, m) > 0 ? s : m), { a: 0, b: 0, c: 0 });

/** Specificity of one complex selector (no top-level commas), per Selectors Level 4. */
export function specificity(selector: string): Specificity {
  let result: Specificity = { a: 0, b: 0, c: 0 };
  const s = selector.trim();
  let i = 0;
  const ident = () => {
    const m = /^-?(?:[\w-]|\\.)+/.exec(s.slice(i));
    i += m ? m[0].length : 1;
    return m ? m[0] : '';
  };
  /** Reads a parenthesized argument starting at s[i] === '('. */
  const argument = () => {
    let depth = 0;
    const start = i;
    for (; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) break;
    }
    i++;
    return s.slice(start + 1, i - 1);
  };
  const listMax = (list: string) => max(splitTopLevel(list, ',').map(specificity));

  while (i < s.length) {
    const ch = s[i];
    if (ch === '#') {
      i++;
      ident();
      result.a++;
    } else if (ch === '.') {
      i++;
      ident();
      result.b++;
    } else if (ch === '[') {
      while (i < s.length && s[i] !== ']') i++;
      i++;
      result.b++;
    } else if (ch === ':') {
      const isElement = s[i + 1] === ':';
      i += isElement ? 2 : 1;
      const name = ident().toLowerCase();
      const arg = s[i] === '(' ? argument() : null;
      if (isElement || LEGACY_PSEUDO_ELEMENTS.has(name)) result.c++;
      else if (name === 'where') {
        // Contributes nothing.
      } else if (name === 'is' || name === 'not' || name === 'has' || name === 'matches') {
        if (arg !== null) result = add(result, listMax(arg));
      } else if ((name === 'nth-child' || name === 'nth-last-child') && arg !== null && / of /i.test(arg)) {
        result = add(add(result, { a: 0, b: 1, c: 0 }), listMax(arg.slice(arg.search(/ of /i) + 4)));
      } else {
        result.b++;
      }
    } else if (ch === '*' || ch === ' ' || ch === '>' || ch === '+' || ch === '~' || ch === '|') {
      i++;
    } else {
      ident();
      result.c++;
    }
  }
  return result;
}

export { compare as compareSpecificity };
