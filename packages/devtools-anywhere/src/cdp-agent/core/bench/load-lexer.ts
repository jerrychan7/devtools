/**
 * Loads the JavaScript lexer from the working tree or from any git revision, optionally
 * instrumented to count how many code units it reads, and gives every public entry point the same
 * shape whatever the revision returns (token objects, or arrays of token fields).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cacheDir } from './materials.ts';

/**
 * What every revision of lexer.ts (and lexer-queries.ts, once the queries moved there) exports,
 * loosely typed: the token list's shape changes.
 */
interface LexerModule {
  tokenize(source: string, options?: object): unknown;
  debuggerStatementSites(source: string, options?: object): unknown;
  debuggerStatements(source: string, options?: object): unknown;
  topLevelLexicalNames(source: string, options?: object): unknown;
  topLevelLexicalDeclarations(source: string, options?: object): unknown;
  topLevelVarNames(source: string, options?: object): unknown;
  lastExpressionStatement(source: string, options?: object): unknown;
  returnOutsideFunction(source: string, options?: object): unknown;
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

const coreDir = fileURLToPath(new URL('../', import.meta.url));

/** The lexer's files: lexer.ts, and the files beside it named lexer*.ts, tests excepted. */
const isLexerFile = (name: string) => /^lexer[\w-]*\.ts$/.test(name) && !name.endsWith('.test.ts');

/** The lexer's files at `rev`, or in the working tree, by name. */
function lexerFiles(rev?: string): Map<string, string> {
  const files = new Map<string, string>();
  if (rev === undefined) {
    for (const name of readdirSync(coreDir))
      if (isLexerFile(name)) files.set(name, readFileSync(coreDir + name, 'utf8'));
    return files;
  }
  const dir = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: coreDir, encoding: 'utf8' }).trim();
  const list = execFileSync('git', ['ls-tree', '--name-only', '--full-name', '--full-tree', rev, dir], {
    cwd: coreDir,
    encoding: 'utf8',
  });
  for (const path of list.split('\n')) {
    const name = path.slice(dir.length);
    if (!isLexerFile(name)) continue;
    files.set(
      name,
      execFileSync('git', ['show', `${rev}:${path}`], { cwd: coreDir, encoding: 'utf8', maxBuffer: 1 << 24 })
    );
  }
  if (!files.has('lexer.ts')) throw new Error(`no lexer.ts at ${rev}`);
  return files;
}

/** Code units read by every counted lexer, on globalThis so that a lexer's files share it. */
const counter = globalThis as unknown as { __lexerReads?: number };

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
 * counted call, in each of the lexer's files, all adding to one counter. Reads made by
 * `startsWith`, `indexOf`, `slice` and `source[i]` are not counted. The counter slows the lexer:
 * time a lexer loaded without it.
 */
function instrument(source: string): string {
  const counted = source.replace(/\b(this\.src|source|src|text)\.charCodeAt\(/g, '__read($1, ');
  if (counted === source) return source;
  return (
    'function __read(s: string, i: number): number {\n' +
    '  const g = globalThis as unknown as { __lexerReads?: number };\n' +
    '  g.__lexerReads = (g.__lexerReads ?? 0) + 1;\n' +
    '  return s.charCodeAt(i);\n}\n' +
    counted
  );
}

/**
 * Writes the lexer's files at `rev` (or the working tree's) to their own directory under
 * cache.ignore/, under their own names, and imports them. Their imports of each other have no
 * extension, which Node does not resolve: `.ts` is added to them there.
 */
export async function loadLexer(rev?: string, countReads = false): Promise<Lexer> {
  const files = lexerFiles(rev);
  const label = rev ?? 'worktree';
  const dir = `${cacheDir}${label.replace(/[^\w.-]/g, '_')}${countReads ? '-reads' : ''}/`;
  mkdirSync(dir, { recursive: true });
  let instrumented = false;
  for (const [name, text] of files) {
    let source = text.replace(/(from '\.\/lexer[\w-]*)'/g, "$1.ts'");
    if (countReads) {
      const counted = instrument(source);
      instrumented ||= counted !== source;
      source = counted;
    }
    writeFileSync(dir + name, source);
  }
  if (countReads && !instrumented) throw new Error('the lexer no longer reads with charCodeAt');
  const load = async (name: string) =>
    (await import(`${pathToFileURL(dir + name).href}?${Date.now()}`)) as Partial<LexerModule>;
  const m = {
    ...(await load('lexer.ts')),
    ...(files.has('lexer-queries.ts') ? await load('lexer-queries.ts') : {}),
  } as LexerModule;
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
  return {
    label,
    entries,
    normalized,
    reads: () => (countReads ? (counter.__lexerReads ?? 0) : 0),
  };
}

/** Reads every code unit once and does nothing else: the floor no lexer can go under. */
export function readOnly(text: string): number {
  let x = 0;
  for (let i = 0; i < text.length; i++) x += text.charCodeAt(i);
  return x;
}
