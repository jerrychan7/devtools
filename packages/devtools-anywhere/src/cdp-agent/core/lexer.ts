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
 * terminators, recovery instead of failing on syntax errors, and `debuggerStatementSites`. The
 * queries over the token list are in lexer-queries.ts.
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

/** A `debugger` statement: the keyword's offset, and whether a `;` comes next. */
export interface DebuggerSite {
  start: number;
  semicolon: boolean;
}

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
  /** Tokens kept so far; stays 0 in debugger mode. */
  private count = 0;
  /** A token came before: `-->` then starts a comment only after a line break. Set in both modes. */
  private lexed = false;
  private kinds: Uint8Array;
  private starts: Int32Array;
  private ends: Int32Array;
  private depths: Int32Array;
  private parents: Uint8Array;
  private newlines: Uint8Array;
  /**
   * Debugger mode (`debuggerStatementSites`): the `debugger` statements found so far, kept instead
   * of the tokens. Only the previous token and a candidate keyword are remembered.
   */
  private readonly sites: DebuggerSite[] | undefined;
  private prevKind = -1;
  private prevStart = 0;
  /** The start of a `debugger` keyword whose next token is still to come (-1 for none). */
  private candidate = -1;
  /**
   * The code unit at `peekPos`, read ahead by a scan that stopped before it (the end of a word,
   * the line break after a comment, what follows a `/`): the main loop takes it from here instead
   * of reading it again. The source does not change, so an old one is still right.
   */
  private peekPos = -1;
  private peek = 0;

  constructor(source: string, module: boolean, sites?: DebuggerSite[]) {
    this.src = source;
    this.module = module;
    this.end = source.length;
    this.sites = sites;
    // Sources range from a token every 2 code units to one every 50 or more (a token every 4 to 5
    // in minified code): the arrays start small and grow to what the source read so far suggests.
    const capacity = sites ? 0 : Math.ceil(source.length / FIRST_GUESS) + 16;
    this.kinds = new Uint8Array(capacity);
    this.starts = new Int32Array(capacity);
    this.ends = new Int32Array(capacity);
    this.depths = new Int32Array(capacity);
    this.parents = new Uint8Array(capacity);
    this.newlines = new Uint8Array(capacity);
  }

  /**
   * Room for the tokens of the whole source at the density seen up to `at` (plus 1/16), and at
   * least 1/8 more than now so that few grows are ever needed. Growing once from a small first
   * guess to about the final count costs less memory than a large first guess that `result` then
   * copies to free its spare room.
   */
  private grow(at: number) {
    const have = this.kinds.length;
    const expected = Math.ceil(((have / Math.max(at, 1)) * this.end * 17) / 16);
    const n = Math.max(expected, have + (have >> 3)) + 16;
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
    if (this.sites) this.debuggerToken(kind, start, end, parent);
    else {
      const i = this.count++;
      if (i === this.kinds.length) this.grow(end);
      this.kinds[i] = kind;
      this.starts[i] = start;
      this.ends[i] = end;
      this.depths[i] = depth;
      this.parents[i] = parent;
      this.newlines[i] = this.newline ? 1 : 0;
    }
    this.newline = false;
    this.lexed = true;
  }

  /** Debugger mode, for each token: settles the candidate before it, and tells whether it is one. */
  private debuggerToken(kind: Kind, start: number, end: number, parent: Open) {
    if (this.candidate !== -1) this.decide(kind, start, this.newline);
    this.candidate = -1;
    if (
      kind === Kind.Word &&
      parent !== Open.ClassBrace &&
      isDebuggerWord(this.src, start, end) &&
      !(this.prevKind === Kind.Punct && this.src.charCodeAt(this.prevStart) === 46) /* . */ &&
      this.src.charCodeAt(start - 1) !== 35 /* # */
    )
      this.candidate = start;
    this.prevKind = kind;
    this.prevStart = start;
  }

  /** The candidate is a statement unless the token after it (kind -1 for none) makes it a name. */
  private decide(kind: number, start: number, newline: boolean) {
    const next = kind === Kind.Punct ? this.src.charCodeAt(start) : -1;
    if (next === 58 /* : */ || (next === 40 /* ( */ && !newline)) return;
    this.sites?.push({ start: this.candidate, semicolon: next === 59 /* ; */ });
  }

  /** Debugger mode: lexes the whole source, and settles a candidate at its end. */
  debuggerSites(): void {
    this.run();
    if (this.candidate !== -1) this.decide(-1, 0, false);
  }

  /** lexer.c `parse` (main loop only). */
  run(): Tokens {
    if (this.c(0) === 35 /* # */ && this.c(1) === 33 /* ! */) {
      this.pos = 2;
      this.lineComment();
    }
    const src = this.src;
    for (; this.pos < this.end; this.pos++) {
      const ch = this.pos === this.peekPos ? this.peek : src.charCodeAt(this.pos);
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
        // keywordStart reads the code units before the keyword again: only for a `class`.
        if (this.src.startsWith('class', this.pos) && this.keywordStart(this.pos)) {
          const after = this.c(this.pos + 5);
          if (isBrOrWs(after) || after === 123 /* { */) this.classDepth = this.depth;
        }
        kind = Kind.Word;
        this.skipTokenRun(ch);
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
        const next = this.ahead(this.pos + 1);
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
          while (isTokenRunChar(this.ahead(this.pos + 1))) this.pos++;
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
        if (
          !this.module &&
          this.ahead(this.pos + 1) === 33 &&
          this.c(this.pos + 2) === 45 &&
          this.c(this.pos + 3) === 45
        ) {
          this.lineComment();
          return;
        }
        break;
      case 45 /* - */:
        if (
          !this.module &&
          this.ahead(this.pos + 1) === 45 &&
          this.c(this.pos + 2) === 62 &&
          (this.newline || !this.lexed)
        ) {
          this.lineComment();
          return;
        }
        break;
      default:
        if (!isTokenRunChar(ch)) break;
        kind = Kind.Word;
        this.skipTokenRun(ch);
    }
    this.emit(kind, start, this.pos + 1, depth);
    this.lastTokenPos = this.pos;
  }

  /** The code unit at `i`, from the one read ahead when it is that one, else read and kept as it. */
  private ahead(i: number): number {
    if (i === this.peekPos) return this.peek;
    const code = this.src.charCodeAt(i) | 0;
    this.peekPos = i;
    this.peek = code;
    return code;
  }

  /**
   * Skips the rest of a word whose code unit at `pos` is `ch`, each code unit read once; a `\\u{…}`
   * escape is part of it (lexer.c `skipBracedEscape`). Leaves the code unit after it read ahead.
   */
  private skipTokenRun(ch: number) {
    const src = this.src;
    let pos = this.pos;
    for (;;) {
      if (ch === 92 && src.charCodeAt(pos + 1) === 117 && src.charCodeAt(pos + 2) === 123) {
        const close = src.indexOf('}', pos + 3);
        if (close > 0 && /^[0-9a-fA-F]+$/.test(src.slice(pos + 3, close))) pos = close;
      }
      const next = src.charCodeAt(pos + 1) | 0;
      if (!isTokenRunChar(next)) {
        this.pos = pos;
        this.peekPos = pos + 1;
        this.peek = next;
        return;
      }
      pos++;
      ch = next;
    }
  }

  /**
   * lexer.c `lastTokenEndsExpression`: true when the last token cannot end an operand, so a `/`
   * here starts a regular expression. It reads the last token and the keyword before it again:
   * only on a `/`, and the history it needs is not worth keeping for every token.
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

  /** lexer.c `templateString`: scans to the closing backtick or to a `${` (a `$` alone reads what follows twice). */
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

  /** lexer.c `blockComment`, each code unit read once: the `*` before the `/` is remembered. */
  private blockComment() {
    const src = this.src;
    const end = this.end;
    let pos = this.pos + 1;
    let prev = 0;
    while (++pos < end) {
      const ch = src.charCodeAt(pos);
      if (prev === 42 && ch === 47) {
        this.pos = pos;
        return;
      }
      if (isBr(ch)) this.newline = true;
      prev = ch;
    }
    this.pos = end;
  }

  /** lexer.c `lineComment`. Leaves `pos` before the line terminator, read ahead. */
  private lineComment() {
    const src = this.src;
    let pos = this.pos;
    while (pos + 1 < this.end) {
      const ch = src.charCodeAt(pos + 1);
      if (isBr(ch)) {
        this.peekPos = pos + 1;
        this.peek = ch;
        break;
      }
      pos++;
    }
    this.pos = pos;
  }

  /** Steps back before the line terminator `ch` at `pos`, left read ahead: an unterminated literal ends there. */
  private backBefore(ch: number) {
    this.peekPos = this.pos;
    this.peek = ch;
    this.pos--;
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
        this.backBefore(ch);
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
        this.backBefore(ch);
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
        this.backBefore(ch);
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

/** Code units per token the token arrays are first sized for. */
const FIRST_GUESS = 8;

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

/**
 * Offsets of every `debugger` statement keyword. Property names (`obj.debugger`, `{ debugger: 1 }`,
 * methods, class members) are not statements. Best effort on invalid code.
 */
export function debuggerStatements(source: string, options: LexOptions = {}): number[] {
  return debuggerStatementSites(source, options).map(site => site.start);
}

/** Like `debuggerStatements`, also telling whether the next token is a `;` (ending the statement). */
export function debuggerStatementSites(source: string, options: LexOptions = {}): DebuggerSite[] {
  const sites: DebuggerSite[] = [];
  // Streamed: a whole bundle's tokens are not kept.
  new Lexer(source, options.module === true, sites).debuggerSites();
  return sites;
}

/** The word from `start` to `end` is `debugger`, written as is or with escapes (then longer). */
function isDebuggerWord(source: string, start: number, end: number): boolean {
  const length = end - start;
  if (length === 8) return source.startsWith('debugger', start);
  return length > 8 && word(source, start, end) === 'debugger';
}

/** A word's text from `start` to `end`, escapes decoded. */
function word(source: string, start: number, end: number): string {
  const raw = source.slice(start, end);
  return raw.includes('\\') ? unescapeWord(raw) : raw;
}

/** `raw` with its `\\uXXXX` / `\\u{…}` escapes decoded. */
export function unescapeWord(raw: string): string {
  return raw.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (escape, braced, plain) => {
    const code = Number.parseInt(typeof braced === 'string' ? braced : String(plain), 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
  });
}
