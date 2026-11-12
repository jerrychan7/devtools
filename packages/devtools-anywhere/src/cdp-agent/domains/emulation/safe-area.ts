import type { Protocol } from 'devtools-protocol';
import { Tok, tokenize } from '../css/sheets/parse/css-lexer';
import { asciiLower, mapFunctions } from './css-tokens';
import type { Rewrite } from './rewrite';

/** The names `env()` takes for the insets, with each inset's key in Protocol.Emulation.SafeAreaInsets. */
const NAMES: [string, keyof Protocol.Emulation.SafeAreaInsets][] = [
  ['safe-area-inset-top', 'top'],
  ['safe-area-max-inset-top', 'topMax'],
  ['safe-area-inset-left', 'left'],
  ['safe-area-max-inset-left', 'leftMax'],
  ['safe-area-inset-bottom', 'bottom'],
  ['safe-area-max-inset-bottom', 'bottomMax'],
  ['safe-area-inset-right', 'right'],
  ['safe-area-max-inset-right', 'rightMax'],
];

/**
 * The name that the arguments of an `env()` start with, ASCII-lowercased, when that name is the whole
 * first argument or is followed by a fallback (`,`): the tokens are read, so spaces and comments around
 * it are skipped.
 */
function nameOf(args: string): string | undefined {
  const { kinds, starts } = tokenize(args);
  const n = kinds.length;
  const kind = (i: number) => kinds[i] ?? Tok.Eof;
  const skip = (i: number) => {
    let j = i;
    while (kind(j) === Tok.Ws || kind(j) === Tok.Comment) j++;
    return j;
  };
  const first = skip(0);
  if (kind(first) !== Tok.Ident) return undefined;
  const next = skip(first + 1);
  if (next < n && kind(next) !== Tok.Comma) return undefined;
  return asciiLower(args.slice(starts[first] ?? 0, starts[first + 1] ?? args.length));
}

/**
 * The rewrite of declaration blocks for Emulation.setSafeAreaInsetsOverride's insets, or null when
 * none is set: each `env(safe-area-inset-*)` and `env(safe-area-max-inset-*)` (fallback included)
 * whose inset is set becomes its length. Like Chrome, an inset not set keeps its real value. The calls
 * are found by their tokens: an `env(` in a comment or a string, or in an unquoted `url()`, is not one.
 */
export function safeAreaRewrite(insets: Protocol.Emulation.SafeAreaInsets): Rewrite | null {
  const values = new Map<string, number>();
  for (const [name, key] of NAMES) {
    const value = insets[key];
    if (value !== undefined) values.set(name, value);
  }
  if (!values.size) return null;
  return text =>
    mapFunctions(text, ['env'], (_name, args) => {
      const name = nameOf(args);
      const value = name === undefined ? undefined : values.get(name);
      return value === undefined ? null : `${value}px`;
    });
}
