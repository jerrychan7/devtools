/**
 * Queries over the token list of lexer.ts (not in es-module-lexer): the names a script declares at
 * top level, its last expression statement, and whether it has a `return` or `new.target` outside
 * every function. Best effort on invalid code.
 */
import { Kind, type LexOptions, Open, type Tokens, tokenize, unescapeWord } from './lexer';

const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;

/** Reserved words, which never bind a name (`await` and `yield` do in sloppy scripts). */
const RESERVED = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
]);

/** Words after which a line break does not end the statement. */
const CONTINUING_WORDS = new Set([
  'else',
  'do',
  'in',
  'of',
  'instanceof',
  'typeof',
  'void',
  'delete',
  'new',
  'case',
  'extends',
  'var',
  'let',
  'const',
  'class',
]);

/** The kind of token `i`, -1 when there is none. */
function kindAt(tokens: Tokens, i: number): number {
  return tokens.kinds[i] ?? -1;
}

/** Token `i`'s text, with the `\\uXXXX` / `\\u{…}` escapes of a word decoded; '' when there is none. */
function text(source: string, tokens: Tokens, i: number): string {
  const kind = tokens.kinds[i];
  if (kind === undefined) return '';
  const raw = source.slice(tokens.starts[i], tokens.ends[i]);
  return kind !== Kind.Word || !raw.includes('\\') ? raw : unescapeWord(raw);
}

/**
 * Token `i` is the word `value` (its escapes decoded), without slicing it out of the source unless
 * it holds an escape: the hot queries ask this of every word.
 */
function isWord(source: string, tokens: Tokens, i: number, value: string): boolean {
  if (tokens.kinds[i] !== Kind.Word) return false;
  const start = tokens.starts[i] ?? 0;
  const end = tokens.ends[i] ?? 0;
  const length = end - start;
  if (length === value.length) return source.startsWith(value, start);
  // Only an escape (`\u0072`, 6 code units for 1) makes a word longer than what it spells.
  // The raw word spells `value` up to its first escape: read only that far.
  if (length < value.length) return false;
  let at = start;
  for (let k = 0; at < end && k < value.length && source.charCodeAt(at) === value.charCodeAt(k); k++) at++;
  return source.charCodeAt(at) === 92 && at < end && text(source, tokens, i) === value;
}

/** Token `i` is the punctuator that starts with `value`'s first character. */
function isPunct(source: string, tokens: Tokens, i: number, value: string): boolean {
  return tokens.kinds[i] === Kind.Punct && source.charCodeAt(tokens.starts[i] ?? 0) === value.charCodeAt(0);
}

/** The first character of token `i`. */
function charAt(source: string, tokens: Tokens, i: number): string | undefined {
  return source[tokens.starts[i] ?? -1];
}

/** The token before `i` can end a statement (so a line break there may insert a semicolon). */
function canEndStatement(source: string, tokens: Tokens, i: number): boolean {
  const prev = kindAt(tokens, i - 1);
  if (prev === -1) return true;
  if (prev === Kind.Word) return !CONTINUING_WORDS.has(text(source, tokens, i - 1));
  if (prev !== Kind.Punct) return true;
  const ch = charAt(source, tokens, i - 1);
  if (ch === ')' || ch === ']' || ch === '}') return true;
  // Postfix `++` / `--`.
  return (ch === '+' || ch === '-') && isPunct(source, tokens, i - 2, ch);
}

/** Token `i` can continue the expression before it across a line break. */
function continuesExpression(source: string, tokens: Tokens, i: number): boolean {
  const kind = kindAt(tokens, i);
  if (kind === -1) return false;
  if (kind === Kind.Word) {
    const word = text(source, tokens, i);
    return word === 'in' || word === 'instanceof';
  }
  const start = tokens.starts[i] ?? 0;
  if (kind === Kind.Template) return source[start] === '`';
  if (kind !== Kind.Punct) return false;
  const ch = source[start];
  if (ch === '+' || ch === '-') return source[start + 1] !== ch;
  // A closer ends a bracket opened earlier on: the expression goes on.
  return ch !== '!' && ch !== '~' && ch !== ';' && ch !== '{';
}

/** Token `i` begins a statement at its depth. */
function statementStart(source: string, tokens: Tokens, i: number): boolean {
  if (kindAt(tokens, i - 1) === -1 || kindAt(tokens, i) === -1) return true;
  if (isPunct(source, tokens, i - 1, ';') || isPunct(source, tokens, i - 1, '}')) return true;
  // `export\nconst a`, `export default\nclass A {}`: part of an export declaration.
  if (kindAt(tokens, i - 1) === Kind.Word && !isPunct(source, tokens, i - 2, '.')) {
    const word = text(source, tokens, i - 1);
    if (word === 'export' || (word === 'default' && text(source, tokens, i - 2) === 'export')) return false;
  }
  return tokens.newlines[i] === 1 && canEndStatement(source, tokens, i);
}

/** Acorn's `isLet`: `let` at statement start followed by `[`, `{` or an identifier declares. */
function isLetDeclaration(source: string, tokens: Tokens, i: number): boolean {
  const next = i + 1;
  if (kindAt(tokens, next) === -1) return false;
  if (isPunct(source, tokens, next, '[') || isPunct(source, tokens, next, '{')) return true;
  if (kindAt(tokens, next) !== Kind.Word) return false;
  const word = text(source, tokens, next);
  if (/^[0-9]/.test(word)) return false;
  return word !== 'in' && word !== 'instanceof';
}

/**
 * Names declared by top-level `let`, `const` and `class` statements, in source order. Destructuring
 * patterns contribute every bound identifier. Best effort on invalid code.
 */
export function topLevelLexicalNames(source: string, options: LexOptions = {}): string[] {
  return topLevelLexicalDeclarations(source, options).flatMap(declaration => declaration.names);
}

export interface LexicalDeclaration {
  kind: 'let' | 'const' | 'class';
  names: string[];
  /** The names declared without an initializer (`let a`), not in a pattern. */
  bare: string[];
  /** Offset of the keyword. */
  start: number;
  /** Offset after the declaration's last token (its `;` when it has one). */
  end: number;
}

/** The top-level `let`, `const` and `class` declarations, in source order. Best effort on invalid code. */
export function topLevelLexicalDeclarations(source: string, options: LexOptions = {}): LexicalDeclaration[] {
  const tokens = tokenize(source, options);
  const { depths, kinds } = tokens;
  const declarations: LexicalDeclaration[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (depths[i] !== 0 || kinds[i] !== Kind.Word) continue;
    const kind = isWord(source, tokens, i, 'let')
      ? 'let'
      : isWord(source, tokens, i, 'const')
        ? 'const'
        : isWord(source, tokens, i, 'class')
          ? 'class'
          : undefined;
    if (kind === undefined) continue;
    if (!statementStart(source, tokens, i)) continue;
    const start = tokens.starts[i] ?? 0;
    const names: string[] = [];
    const bare: string[] = [];
    let last = i;
    if (kind === 'class') {
      if (kindAt(tokens, i + 1) !== Kind.Word || text(source, tokens, i + 1) === 'extends') continue;
      names.push(text(source, tokens, i + 1));
      // The class body: the first brace at depth 0, to its closer.
      let j = i + 2;
      while (j < tokens.length && !(depths[j] === 0 && isPunct(source, tokens, j, '{'))) j++;
      j++;
      while (j < tokens.length && !(depths[j] === 0 && isPunct(source, tokens, j, '}'))) j++;
      last = Math.min(j, tokens.length - 1);
    } else {
      if (kind === 'let' && !isLetDeclaration(source, tokens, i)) continue;
      const after = readDeclarations(source, tokens, i + 1, names, bare);
      last = isPunct(source, tokens, after, ';') ? after : after - 1;
      i = last;
    }
    declarations.push({
      kind,
      names,
      bare,
      start,
      end: tokens.ends[last] ?? source.length,
    });
  }
  return declarations;
}

/** Words that start a statement other than an expression statement. */
const STATEMENT_WORDS = new Set([
  'var',
  'let',
  'const',
  'class',
  'function',
  'async',
  'if',
  'for',
  'while',
  'do',
  'switch',
  'try',
  'return',
  'throw',
  'break',
  'continue',
  'import',
  'export',
  'debugger',
  'with',
]);

/**
 * Offset of the last top-level statement when it is an expression statement (its value is the
 * input's completion value), else undefined. Best effort.
 */
export function lastExpressionStatement(source: string, options: LexOptions = {}): number | undefined {
  const tokens = tokenize(source, options);
  let start = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens.depths[i] !== 0) continue;
    if (
      i === 0 ||
      isPunct(source, tokens, i - 1, ';') ||
      (tokens.newlines[i] === 1 && canEndStatement(source, tokens, i) && !continuesExpression(source, tokens, i))
    )
      start = i;
  }
  const first = kindAt(tokens, start);
  if (first === -1 || isPunct(source, tokens, start, ';') || isPunct(source, tokens, start, '{')) return undefined;
  if (first === Kind.Word) {
    const word = text(source, tokens, start);
    // `let` as an identifier, `async` as one, labels: left to a statement, like a declaration.
    if (STATEMENT_WORDS.has(word) || isPunct(source, tokens, start + 1, ':')) return undefined;
  }
  return tokens.starts[start];
}

/** Words before `(…) {` where the braces are a statement's block, not a function body. */
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'await']);

/**
 * A `return` or `new.target` outside every function body: what a function body takes and a
 * script does not. Function bodies are the braces after `=>` and after `(…)` unless a statement
 * keyword comes before the parentheses (`if`, `for`, …); arrow functions count for `return` only,
 * as they have no `new.target` of their own. Best effort.
 */
export function returnOutsideFunction(source: string, options: LexOptions = {}): boolean {
  const tokens = tokenize(source, options);
  const { depths, kinds } = tokens;
  /** Per depth, the index of the `(` open there. */
  const paren: number[] = [];
  /**
   * Per depth d, how many of the brackets open at the depths below d are function bodies, and how
   * many are function or arrow bodies: set with the bracket at d - 1, so that `inside` is O(1) instead of
   * a walk down the stack. The brackets below a token are opened before the one around it, so the
   * counts at its depth are those of the brackets that hold it.
   */
  const functions: number[] = [0];
  const bodies: number[] = [0];
  const set = (depth: number, kind: 'function' | 'arrow' | 'other') => {
    functions[depth + 1] = (functions[depth] ?? 0) + (kind === 'function' ? 1 : 0);
    bodies[depth + 1] = (bodies[depth] ?? 0) + (kind === 'other' ? 0 : 1);
  };
  const word = (i: number) => (kinds[i] === Kind.Word ? text(source, tokens, i) : '');
  const inside = (depth: number, arrows: boolean) => ((arrows ? bodies[depth] : functions[depth]) ?? 0) > 0;
  for (let i = 0; i < tokens.length; i++) {
    const kind = kinds[i];
    const depth = depths[i] ?? 0;
    if (kind === Kind.Template) {
      set(depth, 'other');
      set(depth + 1, 'other');
      continue;
    }
    if (kind === Kind.Punct) {
      const ch = charAt(source, tokens, i);
      if (ch === '(') {
        set(depth, 'other');
        paren[depth] = i;
      } else if (ch === '[') set(depth, 'other');
      else if (ch === '{') {
        let opened: 'function' | 'arrow' | 'other' = 'other';
        if (isPunct(source, tokens, i - 1, '>') && source[(tokens.starts[i - 1] ?? 0) - 1] === '=') opened = 'arrow';
        else if (isPunct(source, tokens, i - 1, ')')) {
          const before = (paren[depths[i - 1] ?? 0] ?? 0) - 1;
          if (!CONTROL_WORDS.has(word(before))) opened = 'function';
        }
        set(depth, opened);
      }
      continue;
    }
    // A property name: `x.return`, `x?.return`, `{ return: 1 }`, a method `return() {}` (its body
    // is a function body like any `(…) {`).
    // Directly in a class body, any word is part of a member's name or modifiers.
    if (tokens.parents[i] === Open.ClassBrace) continue;
    if (isPunct(source, tokens, i - 1, '.') || isPunct(source, tokens, i + 1, ':')) continue;
    if (isWord(source, tokens, i, 'return') && !inside(depth, true)) {
      // `return(…) {` is a method named return; only scanned for that word, not every call.
      if (isPunct(source, tokens, i + 1, '(')) {
        let close = i + 2;
        while (close < tokens.length && !(depths[close] === depth && isPunct(source, tokens, close, ')'))) close++;
        if (isPunct(source, tokens, close + 1, '{')) continue;
      }
      return true;
    }
    if (
      isWord(source, tokens, i, 'new') &&
      isPunct(source, tokens, i + 1, '.') &&
      isWord(source, tokens, i + 2, 'target') &&
      !inside(depth, false)
    )
      return true;
  }
  return false;
}

/** Names declared by top-level `var` statements (not the ones in blocks). Best effort on invalid code. */
export function topLevelVarNames(source: string, options: LexOptions = {}): string[] {
  const tokens = tokenize(source, options);
  const names: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens.depths[i] !== 0 || !isWord(source, tokens, i, 'var')) continue;
    if (statementStart(source, tokens, i)) i = readDeclarations(source, tokens, i + 1, names) - 1;
  }
  return names;
}

/**
 * Reads `a = 1, [b, c] = d, …` from `i`; returns the index after the declaration. `bare` gets the
 * plain names without an initializer.
 */
function readDeclarations(source: string, tokens: Tokens, i: number, names: string[], bare: string[] = []): number {
  for (;;) {
    const target = i;
    i = readBindingTarget(source, tokens, i, names);
    if (isPunct(source, tokens, i, '=')) i = skipExpression(source, tokens, i + 1, 0);
    else if (kindAt(tokens, target) === Kind.Word) bare.push(text(source, tokens, target));
    if (isPunct(source, tokens, i, ',') && tokens.depths[i] === 0) {
      i++;
      continue;
    }
    return i;
  }
}

/** An identifier or a destructuring pattern; returns the index after it. */
function readBindingTarget(source: string, tokens: Tokens, i: number, names: string[]): number {
  const kind = kindAt(tokens, i);
  if (kind === -1) return i;
  if (kind === Kind.Word) {
    // Only an identifier binds (not `0` in `let[0] = 1`, sloppy code where `let` is a name).
    const name = text(source, tokens, i);
    if (IDENTIFIER.test(name) && !RESERVED.has(name)) names.push(name);
    return i + 1;
  }
  if (isPunct(source, tokens, i, '[')) return readArrayPattern(source, tokens, i, names);
  if (isPunct(source, tokens, i, '{')) return readObjectPattern(source, tokens, i, names);
  return i;
}

function isCloser(source: string, tokens: Tokens, i: number, depth: number): boolean {
  if (tokens.kinds[i] !== Kind.Punct || tokens.depths[i] !== depth) return false;
  const ch = charAt(source, tokens, i);
  return ch === ']' || ch === '}' || ch === ')';
}

/** Skips `...` written as three `.` tokens. */
function skipSpread(source: string, tokens: Tokens, i: number): number {
  if (isPunct(source, tokens, i, '.') && isPunct(source, tokens, i + 1, '.') && isPunct(source, tokens, i + 2, '.'))
    return i + 3;
  return i;
}

function readArrayPattern(source: string, tokens: Tokens, open: number, names: string[]): number {
  const depth = tokens.depths[open] ?? 0;
  let i = open + 1;
  while (i < tokens.length && !isCloser(source, tokens, i, depth)) {
    if (isPunct(source, tokens, i, ',')) {
      i++;
      continue;
    }
    // A token nothing reads (a `;` in `let [a;`) ends the pattern, which is invalid code.
    const from = i;
    i = readBindingTarget(source, tokens, skipSpread(source, tokens, i), names);
    if (isPunct(source, tokens, i, '=')) i = skipExpression(source, tokens, i + 1, depth + 1);
    if (!isPunct(source, tokens, i, ',') && !isCloser(source, tokens, i, depth))
      i = skipExpression(source, tokens, i, depth + 1);
    if (i === from) return i;
  }
  return i + 1;
}

function readObjectPattern(source: string, tokens: Tokens, open: number, names: string[]): number {
  const depth = tokens.depths[open] ?? 0;
  let i = open + 1;
  while (i < tokens.length && !isCloser(source, tokens, i, depth)) {
    if (isPunct(source, tokens, i, ',')) {
      i++;
      continue;
    }
    // A token nothing reads (a `;` in `let [a;`) ends the pattern, which is invalid code.
    const from = i;
    const spread = skipSpread(source, tokens, i);
    if (spread !== i) {
      i = readBindingTarget(source, tokens, spread, names);
    } else if (isPunct(source, tokens, i, '[')) {
      // Computed key: `[k]: target`.
      i = skipExpression(source, tokens, i + 1, depth + 2) + 1;
      if (isPunct(source, tokens, i, ':')) i = readBindingTarget(source, tokens, i + 1, names);
    } else if (isPunct(source, tokens, i + 1, ':')) {
      i = readBindingTarget(source, tokens, i + 2, names);
    } else {
      if (kindAt(tokens, i) === Kind.Word) names.push(text(source, tokens, i));
      i++;
    }
    if (isPunct(source, tokens, i, '=')) i = skipExpression(source, tokens, i + 1, depth + 1);
    if (!isPunct(source, tokens, i, ',') && !isCloser(source, tokens, i, depth))
      i = skipExpression(source, tokens, i, depth + 1);
    if (i === from) return i;
  }
  return i + 1;
}

/**
 * Skips an expression at `depth`: stops at a `,` at that depth, the enclosing closer, a `;`, or (at depth 0) a
 * line break where a semicolon would be inserted.
 */
function skipExpression(source: string, tokens: Tokens, i: number, depth: number): number {
  const first = i;
  for (; i < tokens.length; i++) {
    const at = tokens.depths[i] ?? 0;
    if (at < depth) return i;
    if (at > depth) continue;
    if (isPunct(source, tokens, i, ',') || isPunct(source, tokens, i, ';')) return i;
    if (
      depth === 0 &&
      i > first &&
      tokens.newlines[i] === 1 &&
      canEndStatement(source, tokens, i) &&
      !continuesExpression(source, tokens, i)
    )
      return i;
  }
  return i;
}
