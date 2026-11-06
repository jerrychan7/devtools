/**
 * Random texts made of the pieces that drive css-outline.ts, and a field-by-field comparison of two
 * outlines: shared by css-outline-wasm.test.ts and outline-wasm.bench.ts.
 */
import type { CssOutline } from '../css-outline.ts';

/** Pieces of the texts: brackets, at-rules, comments that hold declarations or not, `!important`… */
export const PIECES = [
  '{', '}', ';', ':', '(', ')', '[', ']', 'a', 'b ', '--x', '--', '-', '@media', '@x', '@import', ' ', '\n',
  '/*', '*/', '/* a: b */', '/*c:d;*/', '/* x */', '!important', '! IMPORTANT', '!', 'important', '"', "'",
  'url(', 'f(', ',', '<!--', '-->', '&', '.c', '#i', '1px', '\\', ' ', '　', '\u000b', 'é', '中',
  '﻿',
]; // prettier-ignore

/** A xorshift32 generator from `seed`: `next(n)` is in [0, n). */
export function random(seed: number): (n: number) => number {
  let s = seed >>> 0 || 1;
  return n => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % n;
  };
}

/**
 * A text of up to 60 pieces, some random ASCII or BMP code units; repeated a few times one time in
 * four, so that the TypeScript outline uses the WebAssembly lexer too, and the WebAssembly outline
 * gets texts past its threshold.
 */
export function fragment(r: (n: number) => number): string {
  let t = '';
  for (let j = r(60); j > 0; j--) {
    const k = r(10);
    if (k < 1) t += String.fromCharCode(r(128));
    else if (k < 2) t += String.fromCharCode(r(0x10000));
    else t += PIECES[r(PIECES.length)];
  }
  return r(4) === 0 ? t.repeat(1 + r(8)) : t;
}

/** What differs between two outlines of `text`, or '' for nothing: counts, then every field. */
export function outlineDiff(a: CssOutline, b: CssOutline): string {
  if (a.ruleCount !== b.ruleCount) return `rule counts ${a.ruleCount}/${b.ruleCount}`;
  if (a.declCount !== b.declCount) return `declaration counts ${a.declCount}/${b.declCount}`;
  if (a.dead !== b.dead) return `dead ${a.dead}/${b.dead}`;
  for (let i = 0; i < a.ruleCount * 12; i++)
    if (a.rules[i] !== b.rules[i]) return `rule ${(i / 12) | 0} field ${i % 12}: ${a.rules[i]}/${b.rules[i]}`;
  for (let i = 0; i < a.declCount * 6; i++)
    if (a.decls[i] !== b.decls[i]) return `declaration ${(i / 6) | 0} field ${i % 6}: ${a.decls[i]}/${b.decls[i]}`;
  return '';
}
