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
