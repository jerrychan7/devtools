// Generated text of a pseudo-element, as Chrome names it: the computed `content` keeps counter()
// and quotes as written, so their text is worked out here. Chrome leaves counters out of the
// rendered text and keeps them in the alternative text; quotes only work in the rendered text.
// Counters come from counter-reset, counter-increment, counter-set and the list-item counter of
// lists, along the document. Part of accessibility.js (ax-name.ts).
import { isElement, styleOf } from '../../core/realm';
import { attr, domChildren, hasAttr } from './ax-tree';

type Pseudo = '::before' | '::after';

/** The counters a counter-* value names, with their numbers (`fallback` when none is given). */
function counterPairs(value: string, fallback: number): [string, number][] {
  if (!value || value === 'none') return [];
  const out: [string, number][] = [];
  const tokens = value.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i] ?? '';
    const next = Number(tokens[i + 1]);
    if (tokens[i + 1] !== undefined && /^-?\d+$/.test(tokens[i + 1] ?? '')) {
      out.push([name, next]);
      i++;
    } else out.push([name, fallback]);
  }
  return out;
}

/** Whether a pseudo-element is generated: its content is not none or normal. */
const generated = (style: CSSStyleDeclaration) => style.content !== 'none' && style.content !== 'normal';

/**
 * The list-item counter an element resets, increments and sets without its counter-* properties
 * saying so, in that order: lists reset it, list items increment it (down in a reversed ol), and
 * an li's value sets it.
 */
function listItem(el: Element, style: CSSStyleDeclaration): (number | null)[] {
  const ol = el.localName === 'ol' ? (el as HTMLOListElement) : null;
  let reset: number | null = null;
  if (ol || el.localName === 'ul' || el.localName === 'menu') {
    const items = [...el.children].filter(c => styleOf(c).display === 'list-item').length;
    const start = ol && hasAttr(ol, 'start') ? ol.start : ol?.reversed ? items : 1;
    reset = ol?.reversed ? start + 1 : start - 1;
  }
  const item = style.display === 'list-item';
  const parent = el.parentElement;
  const value = item && el.localName === 'li' ? attr(el, 'value') : null;
  return [
    reset,
    item ? (parent?.localName === 'ol' && (parent as HTMLOListElement).reversed ? -1 : 1) : null,
    value !== null && /^\s*-?\d+\s*$/.test(value) ? Number(value) : null,
  ];
}

/**
 * Walks the document in order up to the pseudo-element `pseudo` of `target`, past the elements
 * not shown: `onElement` at each element, `onPseudo` at each generated pseudo-element up to the
 * target's (included), `onLeave` as an element ends.
 */
function walkTo(
  target: Element,
  pseudo: Pseudo,
  onElement: (el: Element, style: CSSStyleDeclaration) => void,
  onPseudo: (el: Element, which: Pseudo, style: CSSStyleDeclaration) => void,
  onLeave: (el: Element) => void = () => {}
): void {
  let done = false;
  const visitPseudo = (el: Element, which: Pseudo) => {
    const style = styleOf(el, which);
    if (generated(style)) onPseudo(el, which, style);
    done = el === target && which === pseudo;
  };
  const visit = (el: Element) => {
    const style = styleOf(el);
    if (style.display === 'none') return;
    onElement(el, style);
    visitPseudo(el, '::before');
    for (const child of domChildren(el)) if (!done && isElement(child)) visit(child);
    if (done) return;
    visitPseudo(el, '::after');
    onLeave(el);
  };
  const root = target.ownerDocument.documentElement;
  if (root) visit(root);
}

/**
 * The instances of counter `name` in scope at the pseudo-element `pseudo` of `target`, outermost
 * first: each element and generated pseudo-element resets, increments then sets its counters. A
 * counter's instance lasts until its element's parent ends.
 */
export function counterValues(target: Element, pseudo: Pseudo, name: string): number[] {
  const instances: { value: number; scope: Node | null }[] = [];
  const apply = (style: CSSStyleDeclaration, scope: Node | null, implicit: (number | null)[] = []) => {
    (['counter-reset', 'counter-increment', 'counter-set'] as const).forEach((property, i) => {
      const pairs = counterPairs(style.getPropertyValue(property), i % 2);
      const own = implicit[i];
      if (own != null && !pairs.some(p => p[0] === name)) pairs.push([name, own]);
      for (const [counter, value] of pairs) {
        if (counter !== name) continue;
        const top = instances[instances.length - 1];
        if (!i || !top) instances.push({ value, scope });
        else if (i === 1) top.value += value;
        else top.value = value;
      }
    });
  };
  walkTo(
    target,
    pseudo,
    (el, style) => apply(style, el.parentNode, name === 'list-item' ? listItem(el, style) : []),
    (el, _, style) => apply(style, el),
    el => {
      while (instances[instances.length - 1]?.scope === el) instances.pop();
    }
  );
  return instances.map(i => i.value);
}

/** The styles that show one symbol whatever the number. */
const SYMBOLS: Record<string, string> = {
  disc: '•',
  circle: '◦',
  square: '■',
  'disclosure-open': '▾',
  'disclosure-closed': '▸',
};

/** The digits 0 to 9 of the numeric styles: from the code point of their zero, or written out. */
const NUMERIC: Record<string, number | string> = {
  'arabic-indic': 0x660,
  bengali: 0x9e6,
  cambodian: 0x17e0,
  khmer: 0x17e0,
  'cjk-decimal': '〇一二三四五六七八九',
  devanagari: 0x966,
  gujarati: 0xae6,
  gurmukhi: 0xa66,
  kannada: 0xce6,
  lao: 0xed0,
  malayalam: 0xd66,
  mongolian: 0x1810,
  myanmar: 0x1040,
  oriya: 0xb66,
  persian: 0x6f0,
  urdu: 0x6f0,
  tamil: 0xbe6,
  telugu: 0xc66,
  thai: 0xe50,
  tibetan: 0xf20,
};

/** The letters of the alphabetic styles, from 1 on (a, b, …, z, aa, ab, …); the last two only go up to their letters. */
const ALPHABETIC: Record<string, string> = {
  'lower-alpha': 'abcdefghijklmnopqrstuvwxyz',
  'lower-greek': 'αβγδεζηθικλμνξοπρστυφχψω',
  hiragana: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわゐゑをん',
  katakana: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヰヱヲン',
  'hiragana-iroha': 'いろはにほへとちりぬるをわかよたれそつねならむうゐのおくやまけふこえてあさきゆめみしゑひもせす',
  'katakana-iroha': 'イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス',
  'ethiopic-halehame': 'ሀለሐመሠረሰቀበተኀነአከወዐዘየደገጠጰጸፀፈፐ',
  'ethiopic-halehame-am': 'ሀለሐመሠረሰሸቀበተቸኀነኘአከኸወዐዘዠየደጀገጠጨጰጸፀፈፐ',
  'ethiopic-halehame-ti-er': 'ሀለሐመረሰሸቀቐበተቸነኘአከኸወዐዘዠየደጀገጠጨጰጸፈፐ',
  'ethiopic-halehame-ti-et': 'ሀለሐመሠረሰሸቀቐበተቸኀነኘአከኸወዐዘዠየደጀገጠጨጰጸፀፈፐ',
  'cjk-earthly-branch': '子丑寅卯辰巳午未申酉戌亥',
  'cjk-heavenly-stem': '甲乙丙丁戊己庚辛壬癸',
};

/** A CJK style: its digits 0 to 9, its tens, hundreds and thousands, its ten thousands and hundred millions, its minus. */
type CjkStyle = [string, string, string, string];
const CJK: Record<string, CjkStyle> = {
  'simp-chinese-informal': ['零一二三四五六七八九', '十百千', '万亿', '负'],
  'simp-chinese-formal': ['零壹贰叁肆伍陆柒捌玖', '拾佰仟', '万亿', '负'],
  'trad-chinese-informal': ['零一二三四五六七八九', '十百千', '萬億', '負'],
  'cjk-ideographic': ['零一二三四五六七八九', '十百千', '萬億', '負'],
  'trad-chinese-formal': ['零壹貳參肆伍陸柒捌玖', '拾佰仟', '萬億', '負'],
  'japanese-informal': ['〇一二三四五六七八九', '十百千', '', 'マイナス'],
  'japanese-formal': ['零壱弐参四伍六七八九', '拾百阡', '', 'マイナス'],
  'korean-hangul-formal': ['영일이삼사오육칠팔구', '십백천', '만억', '마이너스 '],
  'korean-hanja-informal': ['零一二三四五六七八九', '十百千', '萬億', '마이너스 '],
  'korean-hanja-formal': ['零壹貳參四五六七八九', '拾百仟', '萬億', '마이너스 '],
};

/** The letters of each decimal place of the additive styles, from the units up (1 to 9, 10 to 90, …). */
const PLACES = {
  armenian: ['ԱԲԳԴԵԶԷԸԹ', 'ԺԻԼԽԾԿՀՁՂ', 'ՃՄՅՆՇՈՉՊՋ', 'ՌՍՎՏՐՑՒՓՔ'],
  georgian: ['აბგდევზჱთ', 'იკლმნჲოპჟ', 'რსტჳფქღყშ', 'ჩცძწჭხჴჯჰ', 'ჵ'],
  hebrew: ['אבגדהוזחט', 'יכלמנסעפצ', 'קרש'],
};

/** `n` in letters by decimal place, from the highest: each place's digit as its letter, `mark` after each. */
function byPlace(n: number, places: string[], mark = ''): string {
  let out = '';
  for (let p = 0; n; p++, n = Math.floor(n / 10)) if (n % 10) out = (places[p]?.[(n % 10) - 1] ?? '') + mark + out;
  return out;
}

/** Hebrew below 1000: four hundreds as ת, and 15 and 16 as 9 + 6 and 9 + 7. */
function hebrewUnder1000(n: number): string {
  const [ones = '', tens = '', hundreds = ''] = PLACES.hebrew;
  let out = 'ת'.repeat(Math.floor(n / 400));
  n %= 400;
  if (n >= 100) out += hundreds[Math.floor(n / 100) - 1];
  n %= 100;
  if (n === 15 || n === 16) return out + 'ט' + ones[n - 10];
  return out + (tens[Math.floor(n / 10) - 1] ?? '') + (ones[(n % 10) - 1] ?? '');
}

/** Ethiopic numerals: pairs of digits from the units up, ፻ after the odd ones and ፼ after the even ones. */
function ethiopic(n: number): string {
  if (n === 1) return '፩';
  const pairs: number[] = [];
  for (; n; n = Math.floor(n / 100)) pairs.unshift(n % 100);
  return pairs
    .map((pair, i) => {
      const index = pairs.length - 1 - i;
      // A pair of 1 leaves out its digit at the top, and before ፻.
      const digits =
        pair === 1 && (!i || index % 2)
          ? ''
          : String.fromCharCode(
              ...(pair >= 10 ? [0x1371 + Math.floor(pair / 10)] : []),
              ...(pair % 10 ? [0x1368 + (pair % 10)] : [])
            );
      return digits + (index % 2 ? (pair ? '፻' : '') : index ? '፼' : '');
    })
    .join('');
}

/**
 * A CJK number, by Chrome's algorithm: groups of four digits with their places, zeros inside the
 * number once in a row in Chinese, and none in Japanese or Korean, which spaces its groups.
 */
function cjk(n: number, style: string): string {
  const [digits, places, groups, minus] = CJK[style] ?? [];
  if (!digits || !places || groups === undefined || minus === undefined) return String(n);
  const chinese = /chinese|ideographic/.test(style);
  // Informal Japanese and Korean hanja leave out a one before a place or a group; informal
  // Chinese the one of the tens from ten to nineteen.
  const dropOne = /^(japanese|korean-hanja)-informal$/.test(style);
  const groupsOf: number[] = [];
  for (let rest = Math.abs(n); rest; rest = Math.floor(rest / 10000)) groupsOf.unshift(rest % 10000);
  if (!groupsOf.length) return digits[0] ?? '';
  const tokens: string[] = [];
  groupsOf.forEach((group, i) => {
    const level = groupsOf.length - 1 - i;
    // From the units up: a zero once a digit other than zero was written, in all places but
    // above the top group's first digit.
    const out: string[] = [];
    let trailing = true;
    for (let p = 0; p < 4 && (i || group >= 10 ** p); p++) {
      const d = Math.floor(group / 10 ** p) % 10;
      const one =
        d === 1 && ((dropOne && (p || level)) || (chinese && !style.endsWith('-formal') && p === 1 && group < 20));
      if (d) out.unshift((one ? '' : (digits[d] ?? '')) + (p ? (places[p - 1] ?? '') : ''));
      else if (!trailing) out.unshift('0');
      if (p < 3) trailing &&= !d;
    }
    tokens.push(...out);
    if (group && level) tokens.push((groups[level - 1] ?? '') + (style.startsWith('korean') ? ' ' : ''));
    // As in Chrome, a group above the units that ends in three zeros is followed by a zero.
    if (level && trailing) tokens.push('0');
  });
  while (tokens[tokens.length - 1] === '0') tokens.pop();
  const text = tokens
    .filter((t, i) => t !== '0' || (chinese && tokens[i - 1] !== '0'))
    .map(t => (t === '0' ? (digits[0] ?? '') : t))
    .join('');
  return (n < 0 ? minus : '') + text.trimEnd();
}

/** `n` in `style`, or null when out of the style's range. */
function represent(n: number, style: string): string | null {
  const digits = NUMERIC[style];
  if (digits !== undefined) {
    if (typeof digits === 'string') return n < 0 ? null : [...String(n)].map(d => digits[+d]).join('');
    return String(n).replace(/\d/g, d => String.fromCharCode(digits + +d));
  }
  const letters = ALPHABETIC[style];
  if (letters) {
    const all = [...letters];
    if (n < 1 || (style.startsWith('cjk-') && n > all.length)) return null;
    let out = '';
    for (; n > 0; n = Math.floor((n - 1) / all.length)) out = all[(n - 1) % all.length] + out;
    return out;
  }
  if (CJK[style]) return style.startsWith('japanese') && Math.abs(n) > 9999 ? null : cjk(n, style);
  switch (style) {
    case 'lower-roman': {
      if (n < 1 || n > 3999) return null;
      // Each decimal digit from the units up, with its place's one, five and ten.
      let out = '';
      for (let i = 0; n; i += 2, n = Math.floor(n / 10)) {
        const [one = '', five = '', ten = ''] = 'ivxlcdm'.slice(i, i + 3);
        const d = n % 10;
        out = (d % 5 > 3 ? one + (d > 5 ? ten : five) : (d > 4 ? five : '') + one.repeat(d % 5)) + out;
      }
      return out;
    }
    case 'armenian':
      // Ten thousands and up as the units, with a circumflex.
      return n < 1 || n > 99999999
        ? null
        : byPlace(Math.floor(n / 10000), PLACES.armenian, '\u0302') + byPlace(n % 10000, PLACES.armenian);
    case 'georgian':
      return n < 1 || n > 19999 ? null : byPlace(n, PLACES.georgian);
    case 'hebrew':
      if (n < 0 || n > 999999) return null;
      if (!n) return 'אפס';
      return (n >= 1000 ? hebrewUnder1000(Math.floor(n / 1000)) + '׳' : '') + hebrewUnder1000(n % 1000);
    case 'ethiopic-numeric':
      return n < 1 ? null : ethiopic(n);
  }
  return null;
}

/** The style a style falls back to out of its range: decimal, but for some CJK ones. */
const fallbackOf = (style: string) => (/^(cjk-(earthly|heavenly)|japanese)/.test(style) ? 'cjk-decimal' : 'decimal');

/**
 * A counter's number in a list style, as Chrome writes it for the predefined styles of CSS
 * Counter Styles; others (none, @counter-style rules) are decimal.
 */
export function counterText(n: number, style = 'decimal'): string {
  const symbol = SYMBOLS[style];
  if (symbol) return symbol;
  // The upper and lower forms of a style, and its other names.
  const name = style
    .replace(/^(upper|lower)-(alpha|latin)$/, 'lower-alpha')
    .replace(/^upper-roman$/, 'lower-roman')
    .replace(/^(upper|lower)-armenian$/, 'armenian');
  for (let current = name; current !== 'decimal'; current = fallbackOf(current)) {
    const out = represent(n, current);
    if (out === null) continue;
    if (current !== name) return out;
    return style.startsWith('upper-') ? out.toUpperCase() : style.startsWith('lower-') ? out.toLowerCase() : out;
  }
  return (style === 'decimal-leading-zero' && n >= 0 && n < 10 ? '0' : '') + n;
}

/** What a list marker writes after its number in a list style, as Chrome does (". " for the styles not known). */
export function markerSuffix(style: string): string {
  if (SYMBOLS[style]) return ' ';
  if (/^(cjk-|hiragana|katakana|japanese-|simp-chinese|trad-chinese)/.test(style)) return '、';
  if (style.startsWith('korean-')) return ', ';
  if (style.startsWith('ethiopic-halehame')) return '፦';
  return style === 'ethiopic-numeric' ? '/ ' : '. ';
}

const STRING = /"((?:[^"\\]|\\.)*)"/g;
export const unescape = (text = '') => text.replace(/\\(.)/g, '$1');

/** How deep in quotes the pseudo-element `pseudo` of `target` starts: the quotes generated before it, in order. */
function quoteDepth(target: Element, pseudo: Pseudo): number {
  let depth = 0;
  walkTo(
    target,
    pseudo,
    () => {},
    (el, which, style) => {
      if (el === target && which === pseudo) return;
      for (const [, , open] of style.content
        .split(/\s\/\s/)[0]
        ?.matchAll(/"(?:[^"\\]|\\.)*"|(no-)?(open|close)-quote/g) ?? [])
        if (open) depth = Math.max(0, depth + (open === 'open' ? 1 : -1));
    }
  );
  return depth;
}

/**
 * The text of a `content` value: its strings, then counters as numbers in their list styles in
 * the alternative text (`alt`), and quotes from the `quotes` property in the rendered text, where
 * a counter is a NUL character for the caller to take out once spaces at line edges are dropped.
 */
export function contentText(content: string, el: Element, pseudo: Pseudo, alt: boolean): string {
  let out = '';
  let depth: number | undefined;
  const re =
    /"((?:[^"\\]|\\.)*)"|(counters?)\(\s*([\w-]+)\s*(?:,\s*"((?:[^"\\]|\\.)*)")?\s*(?:,\s*([\w-]+))?\s*\)|(no-)?(open|close)-quote/g;
  for (const [, text, fn, name = '', sep, style, no, quote] of content.matchAll(re)) {
    if (quote) {
      depth ??= quoteDepth(el, pseudo);
      if (quote === 'close') depth = Math.max(0, depth - 1);
      const value = styleOf(el, pseudo).quotes;
      const pair = value === 'auto' ? ['“', '”', '‘', '’'] : [...value.matchAll(STRING)].map(m => unescape(m[1]));
      if (!no && !alt && pair.length) out += pair[Math.min(depth, pair.length / 2 - 1) * 2 + +(quote === 'close')];
      if (quote === 'open') depth++;
    } else if (fn) {
      // Not named in the rendered text, where it still holds its place on the line.
      if (!alt) out += '\0';
      else {
        const values = counterValues(el, pseudo, name);
        const all = values.length ? values : [0];
        out += (fn === 'counters' ? all : all.slice(-1)).map(n => counterText(n, style)).join(unescape(sep));
      }
    } else out += unescape(text);
  }
  return out;
}
