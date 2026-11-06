// SheetTexts.peek against source(): the text a header is given is the one served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';

type Module = typeof import('./sheet-text.ts');

// Bundled: the sources import each other without extensions, which Node does not resolve.
const bundled = await bundle({
  stdin: {
    contents: "export * from './sheet-text.ts';",
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
// What the module reads of the DOM when loaded, outside a page.
for (const name of [
  'Node',
  'Element',
  'CSSStyleSheet',
  'CSSRule',
  'CSSStyleDeclaration',
  'CSSGroupingRule',
  'CSSStyleRule',
])
  (globalThis as Record<string, unknown>)[name] ??= class {};
const { SheetTexts }: Module = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
);

test('peek gives no text once neither the text nor the serialized one pairs', () => {
  const texts = new SheetTexts();
  // A rule pairing with no text: neither the recorded nor the serialized text pairs, and the
  // registry serves its own serialization (`serialized`), which peek must leave to it.
  const sheet = { ownerNode: null, ownerRule: null, href: 'https://x/a.css' } as unknown as CSSStyleSheet;
  const rule = { cssText: '.a { color: red; }' } as unknown as CSSRule;
  texts.set(sheet, '.a{color:red}');
  assert.deepEqual(texts.peek(sheet), { text: '.a{color:red}' });
  assert.equal(
    texts.source(sheet, () => [rule]),
    null
  );
  assert.equal(texts.peek(sheet), undefined);
});
