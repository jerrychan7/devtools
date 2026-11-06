/**
 * Loads the lexer from the working tree or from any git revision, optionally instrumented to count
 * how many code units it reads. A revision's file is written to the cache directory and imported
 * from there, so older lexers can be measured and compared without checking them out.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cacheDir } from './materials.ts';

export interface Tokens {
  kinds: ArrayLike<number>;
  starts: ArrayLike<number>;
}

export interface Lexer {
  /** `worktree` or the revision given. */
  label: string;
  tokenize(text: string): Tokens;
  /** Code units read with `text.charCodeAt` so far; 0 unless loaded with `countReads`. */
  reads(): number;
}

const lexerPath = fileURLToPath(new URL('../css-lexer.ts', import.meta.url));
const SIGNATURE = 'export function tokenize(text: string): Tokens {';

/**
 * Counting wraps every `text.charCodeAt(` in a counter inside `tokenize`, so it works on every
 * revision that names `text.charCodeAt` (all of them: the oldest wrap it in `at`). Reads made by
 * `indexOf` and `startsWith` (comments, CDO) are not counted. The counter slows the lexer: time a
 * lexer loaded without it.
 */
function instrument(source: string): string {
  if (!source.includes(SIGNATURE)) throw new Error('the lexer no longer declares ' + SIGNATURE);
  return source
    .replaceAll('text.charCodeAt(', '__read(')
    .replace(
      SIGNATURE,
      `let __reads = 0;\nexport const __readCount = () => __reads;\n${SIGNATURE}\n  const __read = (q: number) => (__reads++, text.charCodeAt(q));`
    );
}

export async function loadLexer(rev?: string, countReads = false): Promise<Lexer> {
  let source: string;
  if (rev === undefined) source = readFileSync(lexerPath, 'utf8');
  else {
    const path = execFileSync('git', ['ls-files', '--full-name', lexerPath], { encoding: 'utf8' }).trim();
    source = execFileSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 1 << 24 });
  }
  if (countReads) source = instrument(source);
  const label = rev ?? 'worktree';
  const file = `${cacheDir}lexer-${label.replace(/[^\w.-]/g, '_')}${countReads ? '-reads' : ''}.ts`;
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, source);
  const mod = (await import(pathToFileURL(file).href)) as {
    tokenize: (text: string) => Tokens;
    __readCount?: () => number;
  };
  const readCount = mod.__readCount;
  return { label, tokenize: mod.tokenize, reads: () => (readCount ? readCount() : 0) };
}

type WasmModule = typeof import('../css-lexer-wasm.ts');
type WasmExports = NonNullable<ReturnType<WasmModule['wasmExports']>>;

/**
 * Loads css-lexer-wasm.ts, bundled with esbuild into the cache directory as its imports have no
 * extensions. Throws where WebAssembly does not compile.
 */
export async function loadWasmModule(): Promise<WasmModule & { exports: WasmExports }> {
  const { build } = await import('esbuild');
  const file = `${cacheDir}css-lexer-wasm.mjs`;
  mkdirSync(cacheDir, { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL('../css-lexer-wasm.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: file,
    logLevel: 'error',
  });
  const mod = (await import(pathToFileURL(file).href)) as WasmModule;
  const exports = mod.wasmExports();
  if (!exports) throw new Error('the WebAssembly lexer did not compile');
  return { ...mod, exports };
}

/**
 * The WebAssembly lexer whatever the text's length, and each of its stages alone so that the
 * copies can be told from the lexing:
 * - `wasm`: all of it, as `tokenize` does for a long text;
 * - `wasm utf16`: the same, with the text copied as UTF-16 even when it is ASCII;
 * - `wasm copy in`: copying the text into the module's memory, alone;
 * - `wasm lex`, `wasm lex utf16`: the module's lexing alone, on a text copied in beforehand;
 * - `wasm copy out`: copying the tokens out into the result's arrays, alone.
 */
export async function loadWasmLexers(): Promise<Lexer[]> {
  const mod = await loadWasmModule();
  const w = mod.exports;
  // What was copied in last, so that a stage that needs the text in memory copies it again after
  // another stage has written over it.
  let owner: string | undefined;
  let layout: ReturnType<WasmModule['copyIn']> | undefined;
  let count = 0;
  const prepared = (text: string, wide: boolean) => {
    const key = `${wide}:${text.length}`;
    if (owner !== key || !layout) {
      layout = mod.copyIn(w, text, wide);
      count = mod.lex(w, layout);
      owner = key;
    }
    return layout;
  };
  const lexer = (label: string, tokenize: (text: string) => Tokens): Lexer => ({ label, tokenize, reads: () => 0 });
  // A stage that makes no tokens reports how many the text has, for the table's column.
  const counted = (n: number): Tokens => ({ kinds: { length: n }, starts: [] });
  return [
    lexer('wasm', text => mod.tokenizeWasm(w, text)),
    lexer('wasm utf16', text => {
      const at = mod.copyIn(w, text, true);
      return mod.copyOut(w, at, mod.lex(w, at));
    }),
    lexer('wasm copy in', text => {
      owner = undefined;
      mod.copyIn(w, text);
      return counted(0);
    }),
    lexer('wasm lex', text => counted(mod.lex(w, prepared(text, false)))),
    lexer('wasm lex utf16', text => counted(mod.lex(w, prepared(text, true)))),
    lexer('wasm copy out', text => mod.copyOut(w, prepared(text, false), count)),
  ];
}

/** Reads every code unit once and does nothing else: the floor no lexer can go under. */
export const readOnly: Lexer = {
  label: 'read-only floor',
  tokenize(text) {
    let x = 0;
    for (let i = 0; i < text.length; i++) x += text.charCodeAt(i);
    return { kinds: [], starts: [x] };
  },
  reads: () => 0,
};
