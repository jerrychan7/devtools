// replacedLines against lineStarts of the whole new text, entry for entry: random texts of LF,
// CR, CR LF, FF and other characters, random edits (one or several), with edits starting or
// ending inside CR LF, at line starts, at the ends, empty or inserting line breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type TextReplace, lineStarts, replacedLines } from './text-lines.ts';

const alphabet = ['\n', '\r', '\r\n', '\f', 'a', 'b', '{', '}', ' ', '😀'];

function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
}

function apply(text: string, edits: TextReplace[]): string {
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.start) + e.insert;
    at = e.end;
  }
  return out + text.slice(at);
}

test('replacedLines: as lineStarts of the new text, for random texts and edits', () => {
  const r = rng(7);
  const int = (n: number) => Math.floor(r() * n);
  const piece = (n: number) => Array.from({ length: n }, () => alphabet[int(alphabet.length)]).join('');
  for (let round = 0; round < 20000; round++) {
    const text = piece(int(30));
    const cuts = Array.from({ length: 2 * (1 + int(3)) }, () => int(text.length + 1)).sort((x, y) => x - y);
    const edits: TextReplace[] = [];
    for (let k = 0; k < cuts.length; k += 2)
      edits.push({ start: cuts[k] as number, end: cuts[k + 1] as number, insert: piece(int(6)) });
    const used = r() < 0.4 ? edits.slice(0, 1) : edits;
    const expected = lineStarts(apply(text, used));
    assert.deepEqual(replacedLines(lineStarts(text), used), expected, JSON.stringify({ text, used }));
  }
});

test('replacedLines: edits cutting CR LF, at the ends, and none', () => {
  const cases: [string, TextReplace[]][] = [
    ['a\r\nb', [{ start: 2, end: 2, insert: 'x' }]],
    ['a\r\nb', [{ start: 1, end: 2, insert: '' }]],
    ['a\r\nb', [{ start: 2, end: 3, insert: '\r' }]],
    ['a\r\nb', [{ start: 1, end: 2, insert: '\n' }]],
    ['\n\n', [{ start: 0, end: 2, insert: '' }]],
    ['', [{ start: 0, end: 0, insert: '\r\n\n' }]],
    ['ab\n', [{ start: 3, end: 3, insert: '\n' }]],
    ['ab\n', []],
  ];
  for (const [text, edits] of cases)
    assert.deepEqual(replacedLines(lineStarts(text), edits), lineStarts(apply(text, edits)), JSON.stringify(text));
});
