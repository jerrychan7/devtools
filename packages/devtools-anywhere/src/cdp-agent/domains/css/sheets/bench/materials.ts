/**
 * The style sheets the lexer benchmarks run on. Three are generated here, so every run tokenizes
 * the same text; one is a real project's release build, downloaded once at a pinned commit and
 * checked against its SHA-256.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Where downloads and extracted lexer revisions are kept; ignored by git (`*.ignore`). */
export const cacheDir = fileURLToPath(new URL('./cache.ignore/', import.meta.url));

export interface Material {
  name: string;
  /** What is in it, for the report. */
  about: string;
  text: string;
}

/** About 2.6 MB: 20,000 times a rule with a selector list, a comment and `url()`, and an `@media`. */
function generated(): string {
  let s = '';
  for (let i = 0; i < 20000; i++)
    s += `.c${i} > a:hover, #x${i}{color:red;margin:0 auto;/* c */background:url("a${i}.png")}\n@media (min-width:${i}px){.m${i}{padding:1px}}\n`;
  return s;
}

/** About 49 KB of hand-written-looking rules: fonts, strings, `calc()`, `:not()`, `@media`. */
function common(): string {
  let s = '';
  for (let i = 1; s.length < 50000; i++)
    s += `.btn-${i}, .card .title-${i}:not(.x) {\n  display: flex;\n  font: 14px/1.5 "Helvetica Neue", sans-serif;\n  color: #333;\n  transition: opacity .2s ease-in-out;\n  width: calc(100% - 2rem);\n}\n@media screen and (max-width: 768px) { .btn-${i} { margin: -4px 0 0; } }\n`;
  return s;
}

/**
 * About 93 KB of the lexer's harder cases, 300 times: escapes, strings with escaped newlines,
 * unterminated and bad strings, good and bad `url()`, CDO and CDC, numbers with signs, exponents and
 * units, `-` before names and escapes, non-ASCII, NUL, CR LF and FF.
 */
function mixed(): string {
  const unit = `@charset "utf-8";\n<!-- .a\\31 b { content: "q\\"uo\\\nte"; font-family: '中文字体'; } -->\n.é\\E9 x{background:url( a\\(b.png ) ;b:url(bad"x);c:url('s.png');d:URL(  x  y)}\n/* 注释 ★ */#\\31 23{width:1.5e3px;height:-.5em;z:+12%;k:1E-2Q;m:--x;n:-\\41}\n--var:{a};@-moz-x u+1?? ;"bad\nstr" 'unterminated\n\u0000 😀 \r\n\f\t!important\\\n`;
  let s = '';
  for (let i = 0; i < 300; i++) s += unit + `.n${i}{x:${i}}\n`;
  return s;
}

/** webPixelUIengine's minified release CSS: thousands of custom properties, `var()` and `calc()`. */
const REAL_WORLD = {
  url: 'https://raw.githubusercontent.com/jerrychan7/webPixelUIengine/04ca2e7061845f9cabe7cae8f76ec48a59734f87/release/all.css',
  sha256: '8cb35821f5ec7390a61f4e94c05eca61ae2a4a929f2eb28fd1934633b78509b4',
  file: 'webPixelUIengine-all.css',
};

async function realWorld(): Promise<string> {
  const path = cacheDir + REAL_WORLD.file;
  if (!existsSync(path)) {
    const response = await fetch(REAL_WORLD.url);
    if (!response.ok) throw new Error(`${REAL_WORLD.url}: HTTP ${response.status}`);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = readFileSync(path);
  const sum = createHash('sha256').update(bytes).digest('hex');
  if (sum !== REAL_WORLD.sha256) throw new Error(`${path}: SHA-256 ${sum}, expected ${REAL_WORLD.sha256}`);
  return bytes.toString('utf8');
}

export async function materials(): Promise<Material[]> {
  return [
    { name: 'generated', about: '2.6 MB, one rule and one @media 20,000 times', text: generated() },
    { name: 'common', about: '49 KB, hand-written-looking rules', text: common() },
    { name: 'mixed', about: '93 KB, escapes, strings, url(), numbers, non-ASCII', text: mixed() },
    { name: 'all.css', about: '125 KB, webPixelUIengine release (var(), calc())', text: await realWorld() },
  ];
}
