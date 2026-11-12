import type { Protocol } from 'devtools-protocol';
import { CdpError } from '../../core/session';
import { Tok, tokenize } from '../css/sheets/parse/css-lexer';
import { decodeEscapes, mapFunctions } from './css-tokens';
import type { Rewrite } from './rewrite';

/**
 * The insets of Protocol.Emulation.SafeAreaInsets, each with the name `env()` takes for it and the
 * custom property that holds its value while it is emulated (safeAreaCss).
 */
const INSETS: readonly { key: keyof Protocol.Emulation.SafeAreaInsets; env: string; variable: string }[] = [
  { key: 'top', env: 'safe-area-inset-top', variable: '--da-sai-top' },
  { key: 'topMax', env: 'safe-area-max-inset-top', variable: '--da-sai-max-top' },
  { key: 'left', env: 'safe-area-inset-left', variable: '--da-sai-left' },
  { key: 'leftMax', env: 'safe-area-max-inset-left', variable: '--da-sai-max-left' },
  { key: 'bottom', env: 'safe-area-inset-bottom', variable: '--da-sai-bottom' },
  { key: 'bottomMax', env: 'safe-area-max-inset-bottom', variable: '--da-sai-max-bottom' },
  { key: 'right', env: 'safe-area-inset-right', variable: '--da-sai-right' },
  { key: 'rightMax', env: 'safe-area-max-inset-right', variable: '--da-sai-max-right' },
];

/** The prefix of the custom properties the emulation sets: no page's own property has it, in practice. */
const PREFIX = '--da-sai-';
const variableOf = new Map(INSETS.map(({ env, variable }) => [env, variable]));

/** Whether `name` is a custom property the emulation sets, which the page never wrote (the Computed pane omits it). */
export const isEmulationProperty = (name: string): boolean => name.startsWith(PREFIX);

/**
 * The name that the arguments of an `env()` start with, as written, when that name is the whole first
 * argument or is followed by a fallback (`,`): the tokens are read, so spaces and comments around it are
 * skipped. The name is given decoded, in the case it is written in, as Chrome compares it: an environment
 * variable's name is case-sensitive, where the function's name (`env`) is not.
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
  return decodeEscapes(args.slice(starts[first] ?? 0, starts[first + 1] ?? args.length));
}

/**
 * The rewrite of declaration blocks that puts the emulated insets in place: each `env(safe-area-inset-*)`
 * and `env(safe-area-max-inset-*)` call, fallback included, becomes `var(--da-sai-*, env(…))` with the
 * call's arguments as written. The custom property is set on :root while its inset is emulated, and the
 * `env()` is what an inset not set keeps: its real value. Every such call is rewritten, whichever insets
 * are set, so that changing the values never rewrites the page's sheets again. A `var()` of the rewrite is
 * left as it is, so rewriting a rewritten text changes nothing. The calls are found by their tokens: an
 * `env(` in a comment or a string, or in an unquoted `url()`, is not one.
 */
export const safeAreaRewrite: Rewrite = text =>
  mapFunctions(text, ['env', 'var'], (name, args, whole) => {
    if (name === 'var') return args.trimStart().startsWith(PREFIX) ? whole : null;
    const env = nameOf(args);
    const variable = env === undefined ? undefined : variableOf.get(env);
    return variable === undefined ? null : `var(${variable}, env(${args}))`;
  });

/** A `var()` of the rewrite: its custom property of the emulation, then the `env()` it falls back to. */
const WRAPPED = /^\s*--da-sai-[\w-]+\s*,\s*(env\([\s\S]*\))\s*$/;

/**
 * `text` as the page wrote it: each `var()` of the rewrite is the `env()` it falls back to. The browser
 * gives a declaration the rewrite changed back with those `var()`s, so the Styles pane and the style sheets
 * the CSS domain serves are shown this way.
 */
export function unwrapSafeArea(text: string): string {
  if (!text.includes(PREFIX)) return text;
  return mapFunctions(text, ['var'], (_name, args) => WRAPPED.exec(args)?.[1] ?? null);
}

/**
 * The style sheet's text that sets the insets emulated: `:root{--da-sai-top:20px;…}`, with a custom property
 * for each inset set and no other, or null when none is set. Chrome takes each inset as an int32 and fails
 * the others as invalid parameters, so do we. The value is in CSS pixels.
 */
export function safeAreaCss(insets: Protocol.Emulation.SafeAreaInsets): string | null {
  const declarations = INSETS.flatMap(({ key, variable }) => {
    const value = insets[key];
    if (value === undefined) return [];
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
      throw new CdpError(`Invalid parameters: insets.${key} must be an int32`, -32602);
    return [`${variable}:${value}px`];
  });
  return declarations.length ? `:root{${declarations.join(';')}}` : null;
}
