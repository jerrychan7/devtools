/**
 * A small JavaScript tokenizer: enough lexing to tell code from strings, comments, regular
 * expressions and templates, and to track bracket nesting, without a parser.
 *
 * Ported from es-module-lexer (https://github.com/guybedford/es-module-lexer, src/lexer.c at
 * commit 1c17334d2c3bc0eed6a92022e16254a28bb9ebea): the main loop `parse` / `consumeToken`,
 * `handleSlash`, `lastTokenEndsExpression`, `pushOpenToken` and the open token stack,
 * `templateString`, `blockComment`, `lineComment`, `stringLiteral`, `regularExpression`,
 * `regexCharacterClass`, `keywordStart`, `readPrecedingKeyword1` / `readPrecedingKeywordn`,
 * `isExpressionKeyword`, `isParenKeyword`, `isPunctuator`, `isExpressionPunctuator`,
 * `isBreakOrContinue`, `isExpressionTerminator`, `isForOfBinding` and the whitespace predicates.
 * Import / export analysis and TypeScript support are not ported. Added here: a `#!` first line,
 * HTML-like comments (`<!--`, and `-->` at the start of a line) outside modules, Unicode line
 * terminators, recovery instead of failing on syntax errors, and the two queries below.
 *
 * es-module-lexer is distributed under the MIT License:
 *
 * MIT License
 * -----------
 *
 * Copyright (C) 2018-2022 Guy Bedford
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/** What an open bracket on the stack is (lexer.h `enum OpenTokenState`). */
export const Open = {
  None: 0,
  AnyParen: 1,
  AnyBracket: 2,
  AnyBrace: 3,
  ClassBrace: 4,
  Template: 5,
  TemplateBrace: 6,
} as const;
export type Open = (typeof Open)[keyof typeof Open];

export type TokenKind = 'word' | 'punct' | 'string' | 'template' | 'regex';

export interface Token {
  kind: TokenKind;
  start: number;
  /** Exclusive. */
  end: number;
  /** Open brackets around the token; an opener and its closer share their depth. */
  depth: number;
  /** The innermost open bracket around the token. */
  parent: Open;
  /** A line terminator comes between the previous token and this one. */
  newline: boolean;
}

export interface LexOptions {
  /** Module code: no HTML-like comments. */
  module?: boolean;
}

interface OpenToken {
  token: Open;
  /** The last character of the token before the bracket (-1 for none). */
  pos: number;
}

/** Tokenizes `source`. Never throws: on a syntax error it recovers and goes on. */
export function tokenize(source: string, options: LexOptions = {}): Token[] {
  return new Lexer(source, options.module === true).run();
}

class Lexer {
  private readonly src: string;
  private readonly module: boolean;
  private readonly end: number;
  private pos = 0;
  private lastTokenPos = -1;
  private lastSlashWasDivision = false;
  private nextBraceIsClass = false;
  private readonly stack: OpenToken[] = [];
  private depth = 0;
  private newline = false;
  private readonly tokens: Token[] = [];

  constructor(source: string, module: boolean) {
    this.src = source;
    this.module = module;
    this.end = source.length;
  }

  /** The code unit at `i`, 0 outside the source (lexer.c pads its buffer the same way). */
  private c(i: number): number {
    return i >= 0 && i < this.end ? this.src.charCodeAt(i) : 0;
  }

  private top(index: number): OpenToken {
    return this.stack[index] ?? { token: Open.None, pos: -1 };
  }

  /** lexer.c `pushOpenToken`. */
  private push(token: Open, pos: number) {
    this.stack[this.depth++] = { token, pos };
  }

  private emit(kind: TokenKind, start: number, end: number, depth: number) {
    this.tokens.push({
      kind,
      start,
      end,
      depth,
      parent: depth > 0 ? this.top(depth - 1).token : Open.None,
      newline: this.newline,
    });
    this.newline = false;
  }

  /** lexer.c `parse` (main loop only). */
  run(): Token[] {
    if (this.c(0) === 35 /* # */ && this.c(1) === 33 /* ! */) {
      this.pos = 2;
      this.lineComment();
    }
    for (; this.pos < this.end; this.pos++) {
      const ch = this.c(this.pos);
      if (isBrOrWs(ch)) {
        if (isBr(ch)) this.newline = true;
        continue;
      }
      this.consumeToken(ch);
    }
    return this.tokens;
  }

  /** lexer.c `consumeToken`, without the import / export and TypeScript cases. */
  private consumeToken(ch: number) {
    const start = this.pos;
    let kind: TokenKind = 'punct';
    let depth = this.depth;
    switch (ch) {
      case 99 /* c */:
        if (this.src.startsWith('class', this.pos) && this.keywordStart(this.pos) && isBrOrWs(this.c(this.pos + 5)))
          this.nextBraceIsClass = true;
        kind = 'word';
        this.skipTokenRun();
        break;
      case 40 /* ( */:
        this.push(Open.AnyParen, this.lastTokenPos);
        break;
      case 91 /* [ */:
        this.push(Open.AnyBracket, this.lastTokenPos);
        break;
      case 41 /* ) */:
      case 93 /* ] */:
        if (this.depth > 0) this.depth--;
        depth = this.depth;
        break;
      case 123 /* { */:
        this.push(this.nextBraceIsClass ? Open.ClassBrace : Open.AnyBrace, this.lastTokenPos);
        this.nextBraceIsClass = false;
        break;
      case 125 /* } */:
        if (this.depth === 0) break;
        depth = --this.depth;
        if (this.top(this.depth).token === Open.TemplateBrace) {
          this.emit('template', start, start + 1, depth);
          this.templateString(start);
          this.lastTokenPos = this.pos;
          return;
        }
        break;
      case 39 /* ' */:
      case 34 /* " */:
        kind = 'string';
        this.stringLiteral(ch);
        break;
      case 47 /* / */: {
        // lexer.c `handleSlash`.
        const next = this.c(this.pos + 1);
        if (next === 47) {
          this.lineComment();
          return;
        }
        if (next === 42) {
          this.blockComment();
          return;
        }
        if (this.lastTokenEndsExpression()) {
          kind = 'regex';
          this.regularExpression();
          while (isTokenRunChar(this.c(this.pos + 1))) this.pos++;
          this.lastSlashWasDivision = false;
        } else {
          this.lastSlashWasDivision = true;
        }
        break;
      }
      case 96 /* ` */:
        this.emit('template', start, start + 1, depth);
        this.push(Open.Template, this.lastTokenPos);
        this.templateString(start);
        this.lastTokenPos = this.pos;
        return;
      case 60 /* < */:
        if (!this.module && this.c(this.pos + 1) === 33 && this.c(this.pos + 2) === 45 && this.c(this.pos + 3) === 45) {
          this.lineComment();
          return;
        }
        break;
      case 45 /* - */:
        if (
          !this.module &&
          this.c(this.pos + 1) === 45 &&
          this.c(this.pos + 2) === 62 &&
          (this.newline || this.tokens.length === 0)
        ) {
          this.lineComment();
          return;
        }
        break;
      default:
        if (!isTokenRunChar(ch)) break;
        kind = 'word';
        this.skipTokenRun();
    }
    this.emit(kind, start, this.pos + 1, depth);
    this.lastTokenPos = this.pos;
  }

  /** Skips the rest of a word; a `\\u{…}` escape is part of it (lexer.c `skipBracedEscape`). */
  private skipTokenRun() {
    for (;;) {
      this.skipBracedEscape();
      if (!isTokenRunChar(this.c(this.pos + 1))) return;
      this.pos++;
    }
  }

  private skipBracedEscape() {
    if (this.c(this.pos) !== 92 || this.c(this.pos + 1) !== 117 || this.c(this.pos + 2) !== 123) return;
    const close = this.src.indexOf('}', this.pos + 3);
    if (close > 0 && /^[0-9a-fA-F]+$/.test(this.src.slice(this.pos + 3, close))) this.pos = close;
  }

  /**
   * lexer.c `lastTokenEndsExpression`: true when the last token cannot end an operand, so a `/`
   * here starts a regular expression.
   */
  private lastTokenEndsExpression(): boolean {
    const p = this.lastTokenPos;
    const lastToken = this.c(p);
    const before = this.c(p - 1);
    if (
      (isExpressionPunctuator(lastToken) &&
        !(lastToken === 46 && before >= 48 && before <= 57) &&
        !(lastToken === 43 && before === 43) &&
        !(lastToken === 45 && before === 45)) ||
      (lastToken === 41 && this.isParenKeyword(this.top(this.depth).pos)) ||
      (this.depth > 0 &&
        this.top(this.depth - 1).token === Open.AnyParen &&
        lastToken === 102 &&
        before === 111 &&
        this.isForOfBinding(p - 2) &&
        this.readPrecedingKeywordn(this.top(this.depth - 1).pos, 'for')) ||
      (lastToken === 125 &&
        (this.isExpressionTerminator(this.top(this.depth).pos) || this.top(this.depth).token === Open.ClassBrace)) ||
      this.isExpressionKeyword(p) ||
      (lastToken === 47 && this.lastSlashWasDivision) ||
      lastToken === 0
    )
      return true;
    // `break label` / `continue label`: the label ends the statement.
    let tokenPos = p;
    while (tokenPos > 0 && !isBrOrWsOrPunctuatorNotDot(this.c(--tokenPos)));
    if (!isWsNotBr(this.c(tokenPos))) return false;
    while (tokenPos > 0 && isWsNotBr(this.c(--tokenPos)));
    return this.isBreakOrContinue(tokenPos);
  }

  /** lexer.c `templateString`: scans to the closing backtick or to a `${`. */
  private templateString(start: number) {
    while (++this.pos < this.end) {
      const ch = this.c(this.pos);
      if (ch === 36 && this.c(this.pos + 1) === 123) {
        this.pos++;
        this.push(Open.TemplateBrace, this.pos);
        this.extendTemplate(start);
        return;
      }
      if (ch === 96) {
        if (this.depth > 0) this.depth--;
        this.extendTemplate(start);
        return;
      }
      if (ch === 92) this.pos++;
    }
    this.pos = this.end - 1;
    this.extendTemplate(start);
  }

  private extendTemplate(start: number) {
    const token = this.tokens[this.tokens.length - 1];
    if (token?.start === start) token.end = Math.min(this.pos + 1, this.end);
  }

  /** lexer.c `blockComment`. */
  private blockComment() {
    this.pos++;
    while (++this.pos < this.end) {
      const ch = this.c(this.pos);
      if (isBr(ch)) this.newline = true;
      else if (ch === 42 && this.c(this.pos + 1) === 47) {
        this.pos++;
        return;
      }
    }
  }

  /** lexer.c `lineComment`. Leaves `pos` before the line terminator. */
  private lineComment() {
    while (this.pos + 1 < this.end && !isBr(this.c(this.pos + 1))) this.pos++;
  }

  /** lexer.c `stringLiteral`. An unterminated string ends before the line break. */
  private stringLiteral(quote: number) {
    while (++this.pos < this.end) {
      const ch = this.c(this.pos);
      if (ch === quote) return;
      if (ch === 92) {
        const next = this.c(++this.pos);
        if (next === 13 && this.c(this.pos + 1) === 10) this.pos++;
      } else if (ch === 10 || ch === 13) {
        this.pos--;
        return;
      }
    }
    this.pos = this.end - 1;
  }

  /** lexer.c `regularExpression`. An unterminated literal ends before the line break. */
  private regularExpression() {
    while (++this.pos < this.end) {
      const ch = this.c(this.pos);
      if (ch === 47) return;
      if (ch === 91) {
        if (!this.regexCharacterClass()) return;
      } else if (ch === 92) this.pos++;
      else if (isBr(ch)) {
        this.pos--;
        return;
      }
    }
    this.pos = this.end - 1;
  }

  /** lexer.c `regexCharacterClass`. */
  private regexCharacterClass(): boolean {
    while (++this.pos < this.end) {
      const ch = this.c(this.pos);
      if (ch === 93) return true;
      if (ch === 92) this.pos++;
      else if (isBr(ch)) {
        this.pos--;
        return false;
      }
    }
    this.pos = this.end - 1;
    return false;
  }

  /** lexer.c `keywordStart`. */
  private keywordStart(pos: number): boolean {
    return pos === 0 || this.isBrOrWsOrPunctuatorOrSpreadNotDot(pos - 1);
  }

  /** lexer.c `isBrOrWsOrPunctuatorOrSpreadNotDot`. */
  private isBrOrWsOrPunctuatorOrSpreadNotDot(i: number): boolean {
    const ch = this.c(i);
    return isBrOrWs(ch) || (isPunctuator(ch) && (ch !== 46 || (this.c(i - 1) === 46 && this.c(i - 2) === 46)));
  }

  /** lexer.c `readPrecedingKeyword1`. */
  private readPrecedingKeyword1(pos: number, c1: string): boolean {
    if (pos < 0) return false;
    return this.c(pos) === c1.charCodeAt(0) && (pos === 0 || isBrOrWsOrPunctuatorNotDot(this.c(pos - 1)));
  }

  /** lexer.c `readPrecedingKeywordn`: `keyword` ends at `pos` and starts a token. */
  private readPrecedingKeywordn(pos: number, keyword: string): boolean {
    const start = pos - keyword.length + 1;
    if (start < 0) return false;
    return this.src.startsWith(keyword, start) && (start === 0 || this.isBrOrWsOrPunctuatorOrSpreadNotDot(start - 1));
  }

  /**
   * lexer.c `isExpressionKeyword`: case, debugger, delete, do, else, in, instanceof, new, return,
   * throw, typeof, void, yield, await (and break / continue) end at `pos`.
   */
  private isExpressionKeyword(pos: number): boolean {
    switch (this.c(pos)) {
      case 100 /* d */:
        switch (this.c(pos - 1)) {
          case 105:
            return this.readPrecedingKeywordn(pos - 2, 'vo');
          case 108:
            return this.readPrecedingKeywordn(pos - 2, 'yie');
          default:
            return false;
        }
      case 101 /* e */:
        switch (this.c(pos - 1)) {
          case 115:
            switch (this.c(pos - 2)) {
              case 108:
                return this.readPrecedingKeyword1(pos - 3, 'e');
              case 97:
                return this.readPrecedingKeyword1(pos - 3, 'c');
              default:
                return false;
            }
          case 116:
            return this.readPrecedingKeywordn(pos - 2, 'dele');
          case 117:
            return this.readPrecedingKeywordn(pos - 2, 'contin');
          default:
            return false;
        }
      case 102 /* f */:
        if (this.c(pos - 1) !== 111 || this.c(pos - 2) !== 101) return false;
        switch (this.c(pos - 3)) {
          case 99:
            return this.readPrecedingKeywordn(pos - 4, 'instan');
          case 112:
            return this.readPrecedingKeywordn(pos - 4, 'ty');
          default:
            return false;
        }
      case 107 /* k */:
        return this.readPrecedingKeywordn(pos - 1, 'brea');
      case 110 /* n */:
        return this.readPrecedingKeyword1(pos - 1, 'i') || this.readPrecedingKeywordn(pos - 1, 'retur');
      case 111 /* o */:
        return this.readPrecedingKeyword1(pos - 1, 'd');
      case 114 /* r */:
        return this.readPrecedingKeywordn(pos - 1, 'debugge');
      case 116 /* t */:
        return this.readPrecedingKeywordn(pos - 1, 'awai');
      case 119 /* w */:
        switch (this.c(pos - 1)) {
          case 101:
            return this.readPrecedingKeyword1(pos - 2, 'n');
          case 111:
            return this.readPrecedingKeywordn(pos - 2, 'thr');
          default:
            return false;
        }
    }
    return false;
  }

  /** lexer.c `isParenKeyword`. */
  private isParenKeyword(pos: number): boolean {
    return (
      this.readPrecedingKeywordn(pos, 'while') ||
      this.readPrecedingKeywordn(pos, 'for') ||
      this.readPrecedingKeywordn(pos, 'if')
    );
  }

  /** lexer.c `isBreakOrContinue`. */
  private isBreakOrContinue(pos: number): boolean {
    switch (this.c(pos)) {
      case 107:
        return this.readPrecedingKeywordn(pos - 1, 'brea');
      case 101:
        return this.c(pos - 1) === 117 && this.readPrecedingKeywordn(pos - 2, 'contin');
    }
    return false;
  }

  /** lexer.c `isExpressionTerminator`: `=> ; ) finally catch else` before a statement brace. */
  private isExpressionTerminator(pos: number): boolean {
    switch (this.c(pos)) {
      case 62:
        return this.c(pos - 1) === 61;
      case 59:
      case 41:
        return true;
      case 104:
        return this.readPrecedingKeywordn(pos - 1, 'catc');
      case 121:
        return this.readPrecedingKeywordn(pos - 1, 'finall');
      case 101:
        return this.readPrecedingKeywordn(pos - 1, 'els');
    }
    return false;
  }

  /** lexer.c `isForOfBinding`: the text ending at `pos` ends a for-of binding. */
  private isForOfBinding(pos: number): boolean {
    let ch = this.c(pos);
    if (!isBrOrWs(ch) && ch !== 93 && ch !== 125 && ch !== 41) return false;
    while (pos > 0 && isBrOrWs(this.c(pos))) pos--;
    ch = this.c(pos);
    return ch === 93 || ch === 125 || ch === 41 || !isPunctuator(ch);
  }
}

/** lexer.c `isBr`, plus U+2028 / U+2029. */
function isBr(c: number): boolean {
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

/** lexer.c `isWsNotBr`, plus the other Unicode spaces. */
function isWsNotBr(c: number): boolean {
  return (
    c === 9 ||
    c === 11 ||
    c === 12 ||
    c === 32 ||
    c === 160 ||
    c === 0xfeff ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

/** lexer.c `isBrOrWs`. */
function isBrOrWs(c: number): boolean {
  return isBr(c) || isWsNotBr(c);
}

/** lexer.c `isBrOrWsOrPunctuatorNotDot`. */
function isBrOrWsOrPunctuatorNotDot(c: number): boolean {
  return isBrOrWs(c) || (isPunctuator(c) && c !== 46);
}

/** lexer.c `isTokenRunChar`: identifier, keyword and number characters. */
function isTokenRunChar(c: number): boolean {
  return (
    (c >= 97 && c <= 122) ||
    (c >= 65 && c <= 90) ||
    (c >= 48 && c <= 57) ||
    c === 36 ||
    c === 95 ||
    c === 92 ||
    (c > 127 && !isBrOrWs(c))
  );
}

/** lexer.c `isPunctuator`: !%&()*+,-./:;<=>?[]^{}|~ */
function isPunctuator(ch: number): boolean {
  return (
    ch === 33 ||
    ch === 37 ||
    ch === 38 ||
    (ch > 39 && ch < 48) ||
    (ch > 57 && ch < 64) ||
    ch === 91 ||
    ch === 93 ||
    ch === 94 ||
    (ch > 122 && ch < 127)
  );
}

/** lexer.c `isExpressionPunctuator`: !%&(*+,-.:;<=>?[^{|~ */
function isExpressionPunctuator(ch: number): boolean {
  return (
    ch === 33 ||
    ch === 37 ||
    ch === 38 ||
    (ch > 39 && ch < 47 && ch !== 41) ||
    (ch > 57 && ch < 64) ||
    ch === 91 ||
    ch === 94 ||
    (ch > 122 && ch < 127 && ch !== 125)
  );
}

// Queries over the token stream (not in es-module-lexer).

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

/** The token's text, with the `\\uXXXX` / `\\u{…}` escapes of a word decoded. */
function text(source: string, token: Token | undefined): string {
  if (token === undefined) return '';
  const raw = source.slice(token.start, token.end);
  if (token.kind !== 'word' || !raw.includes('\\')) return raw;
  return raw.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (escape, braced, plain) => {
    const code = Number.parseInt(typeof braced === 'string' ? braced : String(plain), 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
  });
}

function isPunct(source: string, token: Token | undefined, value: string): boolean {
  return token?.kind === 'punct' && source.charCodeAt(token.start) === value.charCodeAt(0);
}

/** The token before `i` can end a statement (so a line break there may insert a semicolon). */
function canEndStatement(source: string, tokens: Token[], i: number): boolean {
  const prev = tokens[i - 1];
  if (prev === undefined) return true;
  if (prev.kind === 'word') return !CONTINUING_WORDS.has(text(source, prev));
  if (prev.kind !== 'punct') return true;
  const ch = source[prev.start];
  if (ch === ')' || ch === ']' || ch === '}') return true;
  // Postfix `++` / `--`.
  return (ch === '+' || ch === '-') && isPunct(source, tokens[i - 2], ch);
}

/** Token `i` can continue the expression before it across a line break. */
function continuesExpression(source: string, tokens: Token[], i: number): boolean {
  const token = tokens[i];
  if (token === undefined) return false;
  if (token.kind === 'word') {
    const word = text(source, token);
    return word === 'in' || word === 'instanceof';
  }
  if (token.kind === 'template') return source[token.start] === '`';
  if (token.kind !== 'punct') return false;
  const ch = source[token.start];
  if (ch === '+' || ch === '-') return source[token.start + 1] !== ch;
  // A closer ends a bracket opened earlier on: the expression goes on.
  return ch !== '!' && ch !== '~' && ch !== ';' && ch !== '{';
}

/** Token `i` begins a statement at its depth. */
function statementStart(source: string, tokens: Token[], i: number): boolean {
  const prev = tokens[i - 1];
  const token = tokens[i];
  if (prev === undefined || token === undefined) return true;
  if (isPunct(source, prev, ';') || isPunct(source, prev, '}')) return true;
  // `export\nconst a`, `export default\nclass A {}`: part of an export declaration.
  if (prev.kind === 'word' && !isPunct(source, tokens[i - 2], '.')) {
    const word = text(source, prev);
    if (word === 'export' || (word === 'default' && text(source, tokens[i - 2]) === 'export')) return false;
  }
  return token.newline && canEndStatement(source, tokens, i);
}

/** Acorn's `isLet`: `let` at statement start followed by `[`, `{` or an identifier declares. */
function isLetDeclaration(source: string, tokens: Token[], i: number): boolean {
  const next = tokens[i + 1];
  if (next === undefined) return false;
  if (isPunct(source, next, '[') || isPunct(source, next, '{')) return true;
  if (next.kind !== 'word') return false;
  const word = text(source, next);
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
  const declarations: LexicalDeclaration[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.depth !== 0 || token.kind !== 'word') continue;
    const kind = text(source, token);
    if (kind !== 'let' && kind !== 'const' && kind !== 'class') continue;
    if (!statementStart(source, tokens, i)) continue;
    const names: string[] = [];
    const bare: string[] = [];
    let last = i;
    if (kind === 'class') {
      const name = tokens[i + 1];
      if (name?.kind !== 'word' || text(source, name) === 'extends') continue;
      names.push(text(source, name));
      // The class body: the first brace at depth 0, to its closer.
      let j = i + 2;
      while (j < tokens.length && !(tokens[j]?.depth === 0 && isPunct(source, tokens[j], '{'))) j++;
      j++;
      while (j < tokens.length && !(tokens[j]?.depth === 0 && isPunct(source, tokens[j], '}'))) j++;
      last = Math.min(j, tokens.length - 1);
    } else {
      if (kind === 'let' && !isLetDeclaration(source, tokens, i)) continue;
      const after = readDeclarations(source, tokens, i + 1, names, bare);
      last = isPunct(source, tokens[after], ';') ? after : after - 1;
      i = last;
    }
    declarations.push({ kind, names, bare, start: token.start, end: tokens[last]?.end ?? source.length });
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
    const token = tokens[i];
    if (token?.depth !== 0) continue;
    const prev = tokens[i - 1];
    if (
      i === 0 ||
      isPunct(source, prev, ';') ||
      (token.newline && canEndStatement(source, tokens, i) && !continuesExpression(source, tokens, i))
    )
      start = i;
  }
  const first = tokens[start];
  if (first === undefined || isPunct(source, first, ';') || isPunct(source, first, '{')) return undefined;
  if (first.kind === 'word') {
    const word = text(source, first);
    // `let` as an identifier, `async` as one, labels: left to a statement, like a declaration.
    if (STATEMENT_WORDS.has(word) || isPunct(source, tokens[start + 1], ':')) return undefined;
  }
  return first.start;
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
  /** Per depth, what the bracket open at that depth is. */
  const open: ('function' | 'arrow' | 'other')[] = [];
  /** Per depth, the index of the `(` open there. */
  const paren: number[] = [];
  const word = (i: number) => {
    const token = tokens[i];
    return token?.kind === 'word' ? text(source, token) : '';
  };
  const inside = (depth: number, arrows: boolean) =>
    open.slice(0, depth).some(kind => kind === 'function' || (arrows && kind === 'arrow'));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.kind === 'template') {
      open[token.depth] = 'other';
      open[token.depth + 1] = 'other';
      continue;
    }
    if (token.kind === 'punct') {
      const ch = source[token.start];
      if (ch === '(') {
        open[token.depth] = 'other';
        paren[token.depth] = i;
      } else if (ch === '[') open[token.depth] = 'other';
      else if (ch === '{') {
        const prev = tokens[i - 1];
        let kind: 'function' | 'arrow' | 'other' = 'other';
        if (isPunct(source, prev, '>') && source[(prev?.start ?? 0) - 1] === '=') kind = 'arrow';
        else if (isPunct(source, prev, ')') && prev !== undefined) {
          const before = (paren[prev.depth] ?? 0) - 1;
          if (!CONTROL_WORDS.has(word(before))) kind = 'function';
        }
        open[token.depth] = kind;
      }
      continue;
    }
    const value = word(i);
    // A property name: `x.return`, `x?.return`, `{ return: 1 }`, a method `return() {}` (its body
    // is a function body like any `(…) {`).
    // Directly in a class body, any word is part of a member's name or modifiers.
    if (token.parent === Open.ClassBrace) continue;
    if (isPunct(source, tokens[i - 1], '.') || isPunct(source, tokens[i + 1], ':')) continue;
    if (isPunct(source, tokens[i + 1], '(')) {
      let close = i + 2;
      while (close < tokens.length && !(tokens[close]?.depth === token.depth && isPunct(source, tokens[close], ')')))
        close++;
      if (isPunct(source, tokens[close + 1], '{')) continue;
    }
    if (value === 'return' && !inside(token.depth, true)) return true;
    if (
      value === 'new' &&
      isPunct(source, tokens[i + 1], '.') &&
      word(i + 2) === 'target' &&
      !inside(token.depth, false)
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
    const token = tokens[i];
    if (token?.depth !== 0 || token.kind !== 'word' || text(source, token) !== 'var') continue;
    if (statementStart(source, tokens, i)) i = readDeclarations(source, tokens, i + 1, names) - 1;
  }
  return names;
}

/**
 * Reads `a = 1, [b, c] = d, …` from `i`; returns the index after the declaration. `bare` gets the
 * plain names without an initializer.
 */
function readDeclarations(source: string, tokens: Token[], i: number, names: string[], bare: string[] = []): number {
  for (;;) {
    const target = tokens[i];
    i = readBindingTarget(source, tokens, i, names);
    if (isPunct(source, tokens[i], '=')) i = skipExpression(source, tokens, i + 1, 0);
    else if (target?.kind === 'word') bare.push(text(source, target));
    if (isPunct(source, tokens[i], ',') && tokens[i]?.depth === 0) {
      i++;
      continue;
    }
    return i;
  }
}

/** An identifier or a destructuring pattern; returns the index after it. */
function readBindingTarget(source: string, tokens: Token[], i: number, names: string[]): number {
  const token = tokens[i];
  if (token === undefined) return i;
  if (token.kind === 'word') {
    // Only an identifier binds (not `0` in `let[0] = 1`, sloppy code where `let` is a name).
    const name = text(source, token);
    if (IDENTIFIER.test(name) && !RESERVED.has(name)) names.push(name);
    return i + 1;
  }
  if (isPunct(source, token, '[')) return readArrayPattern(source, tokens, i, names);
  if (isPunct(source, token, '{')) return readObjectPattern(source, tokens, i, names);
  return i;
}

function isCloser(source: string, token: Token | undefined, depth: number): boolean {
  if (token === undefined || token.kind !== 'punct' || token.depth !== depth) return false;
  const ch = source[token.start];
  return ch === ']' || ch === '}' || ch === ')';
}

/** Skips `...` written as three `.` tokens. */
function skipSpread(source: string, tokens: Token[], i: number): number {
  if (isPunct(source, tokens[i], '.') && isPunct(source, tokens[i + 1], '.') && isPunct(source, tokens[i + 2], '.'))
    return i + 3;
  return i;
}

function readArrayPattern(source: string, tokens: Token[], open: number, names: string[]): number {
  const depth = tokens[open]?.depth ?? 0;
  let i = open + 1;
  while (i < tokens.length && !isCloser(source, tokens[i], depth)) {
    if (isPunct(source, tokens[i], ',')) {
      i++;
      continue;
    }
    i = readBindingTarget(source, tokens, skipSpread(source, tokens, i), names);
    if (isPunct(source, tokens[i], '=')) i = skipExpression(source, tokens, i + 1, depth + 1);
    if (!isPunct(source, tokens[i], ',') && !isCloser(source, tokens[i], depth))
      i = skipExpression(source, tokens, i, depth + 1);
  }
  return i + 1;
}

function readObjectPattern(source: string, tokens: Token[], open: number, names: string[]): number {
  const depth = tokens[open]?.depth ?? 0;
  let i = open + 1;
  while (i < tokens.length && !isCloser(source, tokens[i], depth)) {
    if (isPunct(source, tokens[i], ',')) {
      i++;
      continue;
    }
    const spread = skipSpread(source, tokens, i);
    if (spread !== i) {
      i = readBindingTarget(source, tokens, spread, names);
    } else if (isPunct(source, tokens[i], '[')) {
      // Computed key: `[k]: target`.
      i = skipExpression(source, tokens, i + 1, depth + 2) + 1;
      if (isPunct(source, tokens[i], ':')) i = readBindingTarget(source, tokens, i + 1, names);
    } else if (isPunct(source, tokens[i + 1], ':')) {
      i = readBindingTarget(source, tokens, i + 2, names);
    } else {
      const key = tokens[i];
      if (key?.kind === 'word') names.push(text(source, key));
      i++;
    }
    if (isPunct(source, tokens[i], '=')) i = skipExpression(source, tokens, i + 1, depth + 1);
    if (!isPunct(source, tokens[i], ',') && !isCloser(source, tokens[i], depth))
      i = skipExpression(source, tokens, i, depth + 1);
  }
  return i + 1;
}

/**
 * Skips an expression at `depth`: stops at a `,` at that depth, the enclosing closer, a `;`, or (at depth 0) a
 * line break where a semicolon would be inserted.
 */
function skipExpression(source: string, tokens: Token[], i: number, depth: number): number {
  const first = i;
  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.depth < depth) return i;
    if (token.depth > depth) continue;
    if (isPunct(source, token, ',') || isPunct(source, token, ';')) return i;
    if (
      depth === 0 &&
      i > first &&
      token.newline &&
      canEndStatement(source, tokens, i) &&
      !continuesExpression(source, tokens, i)
    )
      return i;
  }
  return i;
}

/**
 * Offsets of every `debugger` statement keyword. Property names (`obj.debugger`, `{ debugger: 1 }`,
 * methods, class members) are not statements. Best effort on invalid code.
 */
export function debuggerStatements(source: string, options: LexOptions = {}): number[] {
  return debuggerStatementSites(source, options).map(site => site.start);
}

/** Like `debuggerStatements`, also telling whether the next token is a `;` (ending the statement). */
export function debuggerStatementSites(
  source: string,
  options: LexOptions = {}
): { start: number; semicolon: boolean }[] {
  const tokens = tokenize(source, options);
  const sites: { start: number; semicolon: boolean }[] = [];
  tokens.forEach((token, i) => {
    if (token.kind !== 'word' || text(source, token) !== 'debugger') return;
    if (token.parent === Open.ClassBrace) return;
    if (isPunct(source, tokens[i - 1], '.') || source[token.start - 1] === '#') return;
    const next = tokens[i + 1];
    if (isPunct(source, next, ':')) return;
    if (isPunct(source, next, '(') && next?.newline === false) return;
    sites.push({ start: token.start, semicolon: isPunct(source, next, ';') });
  });
  return sites;
}
