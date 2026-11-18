/**
 * Names of declarations for css-outline.ts `dashed`, and whether they start with two `-` once
 * escapes are decoded, as a custom property's does. Shared by css-outline.test.ts and
 * css-outline-wasm.test.ts.
 */
export const DASHED: [string, boolean][] = [
  ['--x', true],
  ['\\2d-x', true],
  ['\\2D\\2d x', true],
  ['\\00002d-x', true],
  ['\\00002D -x', true],
  ['\\-\\-x', true],
  ['-\\-x', true],
  ['\\2d\r\n-x', true],
  ['\\2d\t-x', true],
  ['\\2d\f-x', true],
  // A CR not followed by LF is the escape's white space on its own.
  ['\\2d\r-x', true],
  ['\\2da', false],
  ['\\2da-x', false],
  // Seven digits: the escape takes six (`\00002` is U+0002), then `d`.
  ['\\000002d-x', false],
  // Six digits then a character at once: `-`, then the `-` after.
  ['\\00002d-', true],
  ['\\00002dx', false],
  ['\\x-y', false],
  ['-\\', false],
  ['\\', false],
  ['-x', false],
  ['x', false],
];
