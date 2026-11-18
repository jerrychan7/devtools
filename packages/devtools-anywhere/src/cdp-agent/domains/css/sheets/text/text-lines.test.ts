// The end of a text from textEnd, with and without its line starts, against splitting it at LF
// as the style sheet headers did: CR and CR LF do not end a line, like in Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineStarts, textEnd } from './text-lines.ts';

const texts = [
  '',
  '\n',
  '\n\n',
  'a',
  'a\n',
  'a\nb',
  'a\r\nb',
  'a\r\n',
  'a\rb\r',
  '\r',
  '\r\n\r\n',
  'a{}\n\nb{}\n  c',
  '\fx\n😀',
];

test('textEnd: the last line and its length, like splitting at LF', () => {
  for (const text of texts) {
    const lines = text.split('\n');
    const expected = { line: lines.length - 1, column: lines.at(-1)?.length ?? 0 };
    assert.deepEqual(textEnd(text), expected, JSON.stringify(text));
    assert.deepEqual(textEnd(text, lineStarts(text)), expected, JSON.stringify(text));
  }
});
