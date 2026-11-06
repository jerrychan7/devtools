/**
 * Loads the JavaScript lexer from the working tree or from any git revision, optionally
 * instrumented to count how many code units it reads, and gives every public entry point the same
 * shape whatever the revision returns (token objects, or arrays of token fields).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cacheDir } from './materials.ts';

/** What every revision of lexer.ts exports, loosely typed: the token list's shape changes. */
interface LexerModule {
  tokenize(source: string, options?: object): unknown;
  debuggerStatementSites(source: string, options?: object): unknown;
  debuggerStatements(source: string, options?: object): unknown;
  topLevelLexicalNames(source: string, options?: object): unknown;
  topLevelLexicalDeclarations(source: string, options?: object): unknown;
  topLevelVarNames(source: string, options?: object): unknown;
  lastExpressionStatement(source: string, options?: object): unknown;
  returnOutsideFunction(source: string, options?: object): unknown;
  __readCount?: () => number;
}

export type Entry = (source: string, module: boolean) => unknown;

export interface Lexer {
  /** `worktree` or the revision given. */
  label: string;
  /** The public entry points, results as returned (for timing). */
  entries: Record<string, Entry>;
  /** The same, with the token list turned into numbers so that revisions compare. */
  normalized: Record<string, Entry>;
  /** Code units read with `charCodeAt` so far; 0 unless loaded with `countReads`. */
  reads(): number;
}

const lexerPath = fileURLToPath(new URL('../lexer.ts', import.meta.url));

const KINDS = ['word', 'punct', 'string', 'template', 'regex'];

/**
 * The tokens as one flat array of kind, start, end, depth, parent, newline per token, from either
 * an array of token objects or an object of per-field arrays (`length`, `kinds`, `starts`, …).
 */
export function flatTokens(tokens: unknown): number[] {
  const out: number[] = [];
  if (Array.isArray(tokens)) {
    for (const t of tokens as {
      kind: string;
      start: number;
      end: number;
      depth: number;
      parent: number;
      newline: boolean;
    }[])
      out.push(KINDS.indexOf(t.kind), t.start, t.end, t.depth, t.parent, t.newline ? 1 : 0);
    return out;
  }
  const t = tokens as Record<string, ArrayLike<number>> & { length: number };
  const fields = ['kinds', 'starts', 'ends', 'depths', 'parents', 'newlines'].map(name => need(t[name]));
  for (let i = 0; i < t.length; i++) for (const field of fields) out.push(need(field[i]));
  return out;
}

/** `value`, which the caller knows is there. */
export function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

/**
 * Counting turns every `charCodeAt` on the source (`this.src`, `source`, `src`, `text`) into a
 * counted call. Reads made by `startsWith`, `indexOf`, `slice` and `source[i]` are not counted. The
 * counter slows the lexer: time a lexer loaded without it.
 */
function instrument(source: string): string {
  const counted = source.replace(/\b(this\.src|source|src|text)\.charCodeAt\(/g, '__read($1, ');
  if (counted === source) throw new Error('the lexer no longer reads with charCodeAt');
  return (
    'let __reads = 0;\nexport const __readCount = () => __reads;\n' +
    'function __read(s: string, i: number): number {\n  __reads++;\n  return s.charCodeAt(i);\n}\n' +
    counted
  );
}

export async function loadLexer(rev?: string, countReads = false): Promise<Lexer> {
  let source: string;
  if (rev === undefined) source = readFileSync(lexerPath, 'utf8');
  else {
    const path = execFileSync('git', ['ls-files', '--full-name', lexerPath], {
      encoding: 'utf8',
    }).trim();
    source = execFileSync('git', ['show', `${rev}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 1 << 24,
    });
  }
  if (countReads) source = instrument(source);
  const label = rev ?? 'worktree';
  const file = `${cacheDir}lexer-${label.replace(/[^\w.-]/g, '_')}${countReads ? '-reads' : ''}.ts`;
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, source);
  const m = (await import(`${pathToFileURL(file).href}?${Date.now()}`)) as LexerModule;
  const o = (module: boolean) => ({ module });
  const entries: Record<string, Entry> = {
    tokenize: (s, module) => m.tokenize(s, o(module)),
    debuggerStatementSites: (s, module) => m.debuggerStatementSites(s, o(module)),
    debuggerStatements: (s, module) => m.debuggerStatements(s, o(module)),
    topLevelLexicalNames: (s, module) => m.topLevelLexicalNames(s, o(module)),
    topLevelLexicalDeclarations: (s, module) => m.topLevelLexicalDeclarations(s, o(module)),
    topLevelVarNames: (s, module) => m.topLevelVarNames(s, o(module)),
    lastExpressionStatement: (s, module) => m.lastExpressionStatement(s, o(module)),
    returnOutsideFunction: (s, module) => m.returnOutsideFunction(s, o(module)),
    // What repl.ts does with an input: one tokenize, its tokens reused by each query.
    repl: (s, module) => {
      const lexed = { module, tokens: m.tokenize(s, o(module)) };
      return [
        m.topLevelLexicalDeclarations(s, lexed),
        m.topLevelVarNames(s, lexed),
        m.lastExpressionStatement(s, lexed),
      ];
    },
  };
  const normalized: Record<string, Entry> = {
    ...entries,
    tokenize: (s, module) => flatTokens(m.tokenize(s, o(module))),
  };
  const readCount = m.__readCount;
  return {
    label,
    entries,
    normalized,
    reads: () => (readCount ? readCount() : 0),
  };
}

/** Reads every code unit once and does nothing else: the floor no lexer can go under. */
export function readOnly(text: string): number {
  let x = 0;
  for (let i = 0; i < text.length; i++) x += text.charCodeAt(i);
  return x;
}
