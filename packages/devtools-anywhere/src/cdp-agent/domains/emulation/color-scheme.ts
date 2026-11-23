import { Tok, tokenize } from '../css/sheets/parse/css-lexer';
import { asciiLower, decodeEscapes, mapDeclarations } from './rewrite/css-tokens';
import type { Rewrite } from './rewrite/rewrite';

/** The color scheme of the emulated `prefers-color-scheme`. */
export type Preference = 'light' | 'dark';

/**
 * A `color-scheme` value (a declaration's, without its priority, or a <meta name="color-scheme">'s content)
 * rewritten for the emulated preference, as Chrome 157 reads it: a value that names both light and dark
 * follows the preference, so it is written as the preference alone, with `only` and the other names kept
 * (`only light dark` is `only dark` for a dark preference, which renders as the original does). A value that
 * names one scheme, or `normal`, is not rewritten, and neither is one Chrome does not read: `valid` says whether
 * Chrome reads a value (the probe's CSS.supports, cssSupports in cssom-watch.ts), and a rewrite that would make an
 * ignored value take effect is not made. A value with a function (`var()`, say) is not rewritten either: the names
 * in its arguments are not the value's.
 */
export function schemeValue(preference: Preference, valid: (value: string) => boolean): Rewrite {
  return text => {
    const { kinds, starts } = tokenize(text);
    if (kinds.some(kind => kind === Tok.Func || kind === Tok.LParen)) return text;
    const n = kinds.length;
    const at = (i: number) => starts[i] ?? text.length;
    /** The identifier a token is, decoded and ASCII-lowercased (as CSS compares keywords). */
    const words = Array.from({ length: n }, (_, i) =>
      kinds[i] === Tok.Ident ? asciiLower(decodeEscapes(text.slice(at(i), at(i + 1)))) : undefined
    );
    if (!words.includes('light') || !words.includes('dark') || words.includes('normal')) return text;
    if (!valid(text)) return text;
    // The first light or dark becomes the preference, the others go with the blanks before them.
    const parts: { text: string; blank: boolean }[] = [];
    let placed = false;
    for (let i = 0; i < n; i++) {
      const word = words[i];
      if (word === 'light' || word === 'dark') {
        if (!placed) parts.push({ text: preference, blank: false });
        placed = true;
        while (parts.at(-1)?.blank) parts.pop();
        continue;
      }
      const blank = kinds[i] === Tok.Ws || kinds[i] === Tok.Comment;
      parts.push({ text: text.slice(at(i), at(i + 1)), blank });
    }
    const out = parts.map(part => part.text).join('');
    return valid(out) ? out : text;
  };
}

/**
 * `!important` at the end of a value, with the blanks and comments after the `!`: CSS blanks only, as a no-break
 * space is a name character. A comment is matched without a `*` run that could reach into the next one.
 */
const PRIORITY = /[ \t\n\r\f]*![ \t\n\r\f]*(?:\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/[ \t\n\r\f]*)*important[ \t\n\r\f]*$/i;

/**
 * The rewrite of a declaration block for `value` (schemeValue): the `color-scheme` declarations get it, the
 * `!important` they have kept as written. The other declarations are left as they are.
 */
export function schemeDeclarations(value: Rewrite): Rewrite {
  return block =>
    mapDeclarations(block, (property, text) => {
      if (property !== 'color-scheme') return null;
      const priority = PRIORITY.exec(text)?.[0] ?? '';
      const body = text.slice(0, text.length - priority.length);
      const rewritten = value(body);
      return rewritten === body ? null : rewritten + priority;
    });
}
