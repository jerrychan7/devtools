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
