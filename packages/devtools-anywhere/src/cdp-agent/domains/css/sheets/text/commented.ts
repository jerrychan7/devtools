// Which commented-out declarations Chrome reports as disabled properties, and the native
// CSS.supports() that decides it.
import { cssSupports } from '../watch/cssom-watch';
import { atName } from './loose';

// One snapshot of the probe's `CSS` natives serves both: cssom-watch.ts holds it.
export { cssSupports, useCssNatives } from '../watch/cssom-watch';

/**
 * Whether Chrome reports a comment reading as declaration `name: value` (`value` without its
 * `!important`) as a disabled property: when the declaration parses, as `CSS.supports()` tells,
 * or when the name has a vendor prefix, which Blink keeps whatever the value (`-webkit-foo: )`),
 * in lower case only. A custom property with no value parses, though `CSS.supports('--x', '')`
 * says no. The name is unescaped first (`col\6f r` is `color`), as Blink reads it; the
 * one-argument CSS.supports() would do that too, but a value with `)` could then close the
 * condition and add another (`12px) or (top: 0`).
 */
export function reportedComment(raw: string, value: string): boolean {
  if (/^-(?:webkit|moz|ms|o)-/.test(raw)) return true;
  const name = atName(raw);
  if (name.startsWith('--') && !/[^ \t\n\r\f]/.test(value)) return true;
  return cssSupports(name, value);
}
