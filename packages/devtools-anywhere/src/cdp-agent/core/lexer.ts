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

/** What a token is. */
export const Kind = {
  Word: 0,
  Punct: 1,
  String: 2,
  Template: 3,
  Regex: 4,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/**
 * The tokens of a source, one array per field (token `i` is element `i` of each). A bundle has
 * millions of tokens: typed arrays keep them in about 15 bytes each, where objects took 80.
 */
export interface Tokens {
  length: number;
  kinds: Uint8Array;
  starts: Int32Array;
  /** Exclusive. */
  ends: Int32Array;
  /** Open brackets around the token; an opener and its closer share their depth. */
  depths: Int32Array;
  /** The innermost open bracket around the token (an `Open`). */
  parents: Uint8Array;
  /** 1 when a line terminator comes between the previous token and this one. */
  newlines: Uint8Array;
}

export interface LexOptions {
  /** Module code: no HTML-like comments. */
  module?: boolean;
  /** The tokens of the source, already lexed with the same options: reused instead of lexing again. */
  tokens?: Tokens;
}

interface OpenToken {
  token: Open;
  /** The last character of the token before the bracket (-1 for none). */
  pos: number;
}

/** Takes each token as it is lexed, instead of the token list. */
type Sink = (kind: Kind, start: number, end: number, parent: Open, newline: boolean) => void;

/** Tokenizes `source`. Never throws: on a syntax error it recovers and goes on. */
export function tokenize(source: string, options: LexOptions = {}): Tokens {
  return options.tokens ?? new Lexer(source, options.module === true).run();
}

class Lexer {
  private readonly src: string;
  private readonly module: boolean;
  private readonly end: number;
  private pos = 0;
  private lastTokenPos = -1;
  private lastSlashWasDivision = false;
  /** The depth of a `class` keyword whose body brace is still to come (-1 for none). */
  private classDepth = -1;
  private readonly stack: OpenToken[] = [];
  private depth = 0;
  private newline = false;
  /** Tokens kept so far; stays 0 with a sink. */
  private count = 0;
  private kinds: Uint8Array;
  private starts: Int32Array;
  private ends: Int32Array;
  private depths: Int32Array;
  private parents: Uint8Array;
  private newlines: Uint8Array;
  private readonly sink: Sink | undefined;

  constructor(source: string, module: boolean, sink?: Sink) {
    this.src = source;
    this.module = module;
    this.end = source.length;
    this.sink = sink;
    // A token every 4 to 5 code units in minified code: most sources never grow the arrays.
    const capacity = sink ? 0 : Math.ceil(source.length / 3) + 16;
    this.kinds = new Uint8Array(capacity);
    this.starts = new Int32Array(capacity);
    this.ends = new Int32Array(capacity);
    this.depths = new Int32Array(capacity);
    this.parents = new Uint8Array(capacity);
    this.newlines = new Uint8Array(capacity);
  }

  private grow() {
    const n = this.kinds.length * 2;
    this.kinds = resized(this.kinds, n);
    this.starts = resized(this.starts, n);
    this.ends = resized(this.ends, n);
    this.depths = resized(this.depths, n);
    this.parents = resized(this.parents, n);
    this.newlines = resized(this.newlines, n);
  }

  /** The tokens kept, in arrays of their length: copied when the spare room is worth freeing. */
  private result(): Tokens {
    const n = this.count;
    const copy = this.kinds.length - n > n >> 3;
    const cut = <T extends Uint8Array | Int32Array>(a: T): T => (copy ? a.slice(0, n) : a.subarray(0, n)) as T;
    return {
      length: n,
      kinds: cut(this.kinds),
      starts: cut(this.starts),
      ends: cut(this.ends),
      depths: cut(this.depths),
      parents: cut(this.parents),
      newlines: cut(this.newlines),
    };
  }

  /**
   * The code unit at `i`, 0 outside the source (lexer.c pads its buffer the same way): there
   * `charCodeAt` gives NaN, and `NaN | 0` is 0, without a bounds check of our own.
   */
  private c(i: number): number {
    return this.src.charCodeAt(i) | 0;
  }

  private top(index: number): OpenToken {
    return this.stack[index] ?? { token: Open.None, pos: -1 };
  }

  /** lexer.c `pushOpenToken`. */
  private push(token: Open, pos: number) {
    this.stack[this.depth++] = { token, pos };
  }

  private emit(kind: Kind, start: number, end: number, depth: number) {
    const parent = depth > 0 ? this.top(depth - 1).token : Open.None;
    if (this.sink) this.sink(kind, start, end, parent, this.newline);
    else {
      const i = this.count++;
      if (i === this.kinds.length) this.grow();
      this.kinds[i] = kind;
      this.starts[i] = start;
      this.ends[i] = end;
      this.depths[i] = depth;
      this.parents[i] = parent;
      this.newlines[i] = this.newline ? 1 : 0;
    }
    this.newline = false;
  }

  /** lexer.c `parse` (main loop only). */
  run(): Tokens {
    if (this.c(0) === 35 /* # */ && this.c(1) === 33 /* ! */) {
      this.pos = 2;
      this.lineComment();
    }
    for (; this.pos < this.end; this.pos++) {
      const ch = this.src.charCodeAt(this.pos);
      if (isBrOrWs(ch)) {
        if (isBr(ch)) this.newline = true;
        continue;
      }
      this.consumeToken(ch);
    }
    return this.result();
  }

  /** lexer.c `consumeToken`, without the import / export and TypeScript cases. */
  private consumeToken(ch: number) {
    const start = this.pos;
    let kind: Kind = Kind.Punct;
    let depth = this.depth;
    switch (ch) {
      case 99 /* c */:
        // `class{` too (minified code). Only the brace at the keyword's depth is the body, not one
        // in the heritage (`class A extends f({}) {`).
        if (
          this.src.startsWith('class', this.pos) &&
          this.keywordStart(this.pos) &&
          (isBrOrWs(this.c(this.pos + 5)) || this.c(this.pos + 5) === 123) /* { */
        )
          this.classDepth = this.depth;
        kind = Kind.Word;
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
        if (this.classDepth === this.depth) {
          this.classDepth = -1;
          this.push(Open.ClassBrace, this.lastTokenPos);
        } else this.push(Open.AnyBrace, this.lastTokenPos);
        break;
      case 125 /* } */:
        if (this.depth === 0) break;
        depth = --this.depth;
        if (this.top(this.depth).token === Open.TemplateBrace) {
          this.emit(Kind.Template, start, start + 1, depth);
          this.templateString(start);
          this.lastTokenPos = this.pos;
          return;
        }
        break;
      case 39 /* ' */:
      case 34 /* " */:
        kind = Kind.String;
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
          kind = Kind.Regex;
          this.regularExpression();
          while (isTokenRunChar(this.c(this.pos + 1))) this.pos++;
          this.lastSlashWasDivision = false;
        } else {
          this.lastSlashWasDivision = true;
        }
        break;
      }
      case 96 /* ` */:
        this.emit(Kind.Template, start, start + 1, depth);
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
          (this.newline || this.count === 0)
        ) {
          this.lineComment();
          return;
        }
        break;
      default:
        if (!isTokenRunChar(ch)) break;
        kind = Kind.Word;
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
      const ch = this.src.charCodeAt(this.pos);
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
    const last = this.count - 1;
    if (last >= 0 && this.starts[last] === start) this.ends[last] = Math.min(this.pos + 1, this.end);
  }

  /** lexer.c `blockComment`. */
  private blockComment() {
    this.pos++;
    while (++this.pos < this.end) {
      const ch = this.src.charCodeAt(this.pos);
      if (isBr(ch)) this.newline = true;
      else if (ch === 42 && this.c(this.pos + 1) === 47) {
        this.pos++;
        return;
      }
    }
  }

  /** lexer.c `lineComment`. Leaves `pos` before the line terminator. */
  private lineComment() {
    while (this.pos + 1 < this.end && !isBr(this.src.charCodeAt(this.pos + 1))) this.pos++;
  }

  /** lexer.c `stringLiteral`. An unterminated string ends before the line break. */
  private stringLiteral(quote: number) {
    while (++this.pos < this.end) {
      const ch = this.src.charCodeAt(this.pos);
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
      const ch = this.src.charCodeAt(this.pos);
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
      const ch = this.src.charCodeAt(this.pos);
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

/** `array` copied into a new array of `length` elements. */
function resized<T extends Uint8Array | Int32Array>(array: T, length: number): T {
  const copy = new (array.constructor as new (length: number) => T)(length);
  copy.set(array);
  return copy;
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

/** Classes of ASCII code units, a bit each. */
const WS = 1;
const RUN = 2;
const PUNCT = 4;
const EXPRESSION_PUNCT = 8;

/** What each ASCII code unit is: one load instead of a chain of comparisons in the hot loops. */
const ASCII = new Uint8Array(128);
function mark(chars: string, bit: number) {
  for (let i = 0; i < chars.length; i++) {
    const c = chars.charCodeAt(i);
    ASCII[c] = (ASCII[c] ?? 0) | bit;
  }
}
mark('\t\n\v\f\r ', WS);
mark('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$_\\', RUN);
mark('!%&()*+,-./:;<=>?[]^{}|~', PUNCT);
mark('!%&(*+,-.:;<=>?[^{|~', EXPRESSION_PUNCT);

/** lexer.c `isBrOrWs`. */
function isBrOrWs(c: number): boolean {
  return c < 128 ? ((ASCII[c] ?? 0) & WS) !== 0 : isBr(c) || isWsNotBr(c);
}

/** lexer.c `isBrOrWsOrPunctuatorNotDot`. */
function isBrOrWsOrPunctuatorNotDot(c: number): boolean {
  return isBrOrWs(c) || (isPunctuator(c) && c !== 46);
}

/** lexer.c `isTokenRunChar`: identifier, keyword and number characters ([A-Za-z0-9$_\\] in ASCII). */
function isTokenRunChar(c: number): boolean {
  return c < 128 ? ((ASCII[c] ?? 0) & RUN) !== 0 : !isBr(c) && !isWsNotBr(c);
}

/** lexer.c `isPunctuator`: !%&()*+,-./:;<=>?[]^{}|~ */
function isPunctuator(ch: number): boolean {
  return ch < 128 && ((ASCII[ch] ?? 0) & PUNCT) !== 0;
}

/** lexer.c `isExpressionPunctuator`: !%&(*+,-.:;<=>?[^{|~ */
function isExpressionPunctuator(ch: number): boolean {
  return ch < 128 && ((ASCII[ch] ?? 0) & EXPRESSION_PUNCT) !== 0;
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
    const kind = text(source, tokens, i);
    if (kind !== 'let' && kind !== 'const' && kind !== 'class') continue;
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
    declarations.push({ kind, names, bare, start, end: tokens.ends[last] ?? source.length });
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
  /** Per depth, what the bracket open at that depth is. */
  const open: ('function' | 'arrow' | 'other')[] = [];
  /** Per depth, the index of the `(` open there. */
  const paren: number[] = [];
  const word = (i: number) => (kinds[i] === Kind.Word ? text(source, tokens, i) : '');
  const inside = (depth: number, arrows: boolean) =>
    open.slice(0, depth).some(kind => kind === 'function' || (arrows && kind === 'arrow'));
  for (let i = 0; i < tokens.length; i++) {
    const kind = kinds[i];
    const depth = depths[i] ?? 0;
    if (kind === Kind.Template) {
      open[depth] = 'other';
      open[depth + 1] = 'other';
      continue;
    }
    if (kind === Kind.Punct) {
      const ch = charAt(source, tokens, i);
      if (ch === '(') {
        open[depth] = 'other';
        paren[depth] = i;
      } else if (ch === '[') open[depth] = 'other';
      else if (ch === '{') {
        let opened: 'function' | 'arrow' | 'other' = 'other';
        if (isPunct(source, tokens, i - 1, '>') && source[(tokens.starts[i - 1] ?? 0) - 1] === '=') opened = 'arrow';
        else if (isPunct(source, tokens, i - 1, ')')) {
          const before = (paren[depths[i - 1] ?? 0] ?? 0) - 1;
          if (!CONTROL_WORDS.has(word(before))) opened = 'function';
        }
        open[depth] = opened;
      }
      continue;
    }
    const value = word(i);
    // A property name: `x.return`, `x?.return`, `{ return: 1 }`, a method `return() {}` (its body
    // is a function body like any `(…) {`).
    // Directly in a class body, any word is part of a member's name or modifiers.
    if (tokens.parents[i] === Open.ClassBrace) continue;
    if (isPunct(source, tokens, i - 1, '.') || isPunct(source, tokens, i + 1, ':')) continue;
    if (value === 'return' && !inside(depth, true)) {
      // `return(…) {` is a method named return; only scanned for that word, not every call.
      if (isPunct(source, tokens, i + 1, '(')) {
        let close = i + 2;
        while (close < tokens.length && !(depths[close] === depth && isPunct(source, tokens, close, ')'))) close++;
        if (isPunct(source, tokens, close + 1, '{')) continue;
      }
      return true;
    }
    if (value === 'new' && isPunct(source, tokens, i + 1, '.') && word(i + 2) === 'target' && !inside(depth, false))
      return true;
  }
  return false;
}

/** Names declared by top-level `var` statements (not the ones in blocks). Best effort on invalid code. */
export function topLevelVarNames(source: string, options: LexOptions = {}): string[] {
  const tokens = tokenize(source, options);
  const names: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens.depths[i] !== 0 || tokens.kinds[i] !== Kind.Word || text(source, tokens, i) !== 'var') continue;
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
  const sites: { start: number; semicolon: boolean }[] = [];
  // Streamed: a whole bundle's tokens are not kept, only the previous one and a candidate.
  const punct = (kind: number, start: number, value: number) =>
    kind === Kind.Punct && source.charCodeAt(start) === value;
  let prevKind = -1;
  let prevStart = 0;
  /** The start of a `debugger` keyword whose next token is still to come (-1 for none). */
  let candidate = -1;
  const decide = (keyword: number, kind: number, start: number, newline: boolean) => {
    if (punct(kind, start, 58 /* : */)) return;
    if (punct(kind, start, 40 /* ( */) && !newline) return;
    sites.push({ start: keyword, semicolon: punct(kind, start, 59 /* ; */) });
  };
  const take: Sink = (kind, start, end, parent, newline) => {
    if (candidate !== -1) decide(candidate, kind, start, newline);
    candidate = -1;
    if (
      kind === Kind.Word &&
      parent !== Open.ClassBrace &&
      // Cheap check first: most words are shorter (an escaped `debugger` is longer).
      end - start >= 8 &&
      word(source, start, end) === 'debugger' &&
      !punct(prevKind, prevStart, 46 /* . */) &&
      source[start - 1] !== '#'
    )
      candidate = start;
    prevKind = kind;
    prevStart = start;
  };
  new Lexer(source, options.module === true, take).run();
  if (candidate !== -1) decide(candidate, -1, 0, false);
  return sites;
}

/** A word's text from `start` to `end`, escapes decoded. */
function word(source: string, start: number, end: number): string {
  const raw = source.slice(start, end);
  return raw.includes('\\') ? unescapeWord(raw) : raw;
}

/** `raw` with its `\\uXXXX` / `\\u{…}` escapes decoded. */
function unescapeWord(raw: string): string {
  return raw.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (escape, braced, plain) => {
    const code = Number.parseInt(typeof braced === 'string' ? braced : String(plain), 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
  });
}
