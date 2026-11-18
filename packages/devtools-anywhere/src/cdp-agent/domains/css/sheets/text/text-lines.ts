/**
 * Offsets in a style sheet's text to lines and columns and back, both counted from 0, columns in
 * UTF-16 code units. Like Chrome's, lines end at LF only: a CR (of CR LF or alone) and FF are
 * characters at the end of the line, or in it.
 */

/** The offset each line starts at: the first is 0. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let p = text.indexOf('\n'); p >= 0; p = text.indexOf('\n', p + 1)) starts.push(p + 1);
  return starts;
}

export interface TextPosition {
  line: number;
  column: number;
}

/**
 * The line and column at the end of `text`, from its `lineStarts` if known: without them, counted
 * without splitting the text.
 */
export function textEnd(text: string, starts?: readonly number[]): TextPosition {
  if (starts) {
    const line = starts.length - 1;
    return { line, column: text.length - (starts[line] ?? 0) };
  }
  let line = 0;
  for (let p = text.indexOf('\n'); p >= 0; p = text.indexOf('\n', p + 1)) line++;
  return { line, column: text.length - (text.lastIndexOf('\n') + 1) };
}

/** The line and column of `offset`, from `lineStarts`. */
export function positionAt(starts: readonly number[], offset: number): TextPosition {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, column: offset - (starts[lo] ?? 0) };
}

/** The offset of a line and column, from `lineStarts`; -1 for a line past the last one. */
export function offsetAt(starts: readonly number[], line: number, column: number): number {
  const start = starts[line];
  return start === undefined || line < 0 ? -1 : start + column;
}

/** A replacement in a text: `[start, end)` of it replaced by `insert`. */
export interface TextReplace {
  start: number;
  end: number;
  insert: string;
}

/**
 * The `lineStarts` of a text after `edits` (in order, not overlapping, offsets in the old text),
 * from the old text's `starts`: those before each edit kept, the edit's own scanned, those after
 * moved by the change in length. A line starts after an LF, so one that starts at an edit's start
 * stays (its LF is before the edit) and one at its end goes (its LF was replaced); a CR LF cut
 * by an edit needs nothing more, a CR not ending a line.
 */
export function replacedLines(starts: readonly number[], edits: readonly TextReplace[]): number[] {
  // The starts each edit removes (by binary search) and adds, so that the result is made at its
  // length in one pass rather than grown entry by entry, or spliced.
  const cuts: number[] = [];
  const added: number[][] = [];
  let length = starts.length;
  for (const { start, end, insert } of edits) {
    const i = after(starts, start);
    const j = after(starts, end);
    const lines: number[] = [];
    for (let p = insert.indexOf('\n'); p >= 0; p = insert.indexOf('\n', p + 1)) lines.push(p + 1);
    cuts.push(i, j);
    added.push(lines);
    length += lines.length - (j - i);
  }
  // oxlint-disable-next-line unicorn/no-new-array -- a length; Array.from({ length }) fills it twice.
  const result = new Array<number>(length);
  let at = 0;
  let from = 0;
  let delta = 0;
  for (let e = 0; e < edits.length; e++) {
    const { start, end, insert } = edits[e] as TextReplace;
    const i = cuts[2 * e] as number;
    for (let k = from; k < i; k++) result[at++] = (starts[k] as number) + delta;
    for (const p of added[e] as number[]) result[at++] = start + delta + p;
    from = cuts[2 * e + 1] as number;
    delta += insert.length - (end - start);
  }
  for (let k = from; k < starts.length; k++) result[at++] = (starts[k] as number) + delta;
  return result;
}

/** The index of the first of `starts` past `offset`. */
function after(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
