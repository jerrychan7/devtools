import { isElement } from '../realm';
import { nativeCall } from '../natives';

/**
 * An attribute the agent wrote into one of the page's elements (the emulation's rewrites, see
 * domains/emulation/rewrite.ts): the value the page gave it, and the value written, as it reads.
 */
export interface Written {
  original: string;
  applied: string;
  /** What the rewrite gave the original, as last written (domains/emulation/rewrite.ts). */
  target: string;
  /** For a style attribute rewritten from the writes of its block (rewrite.ts, planWritten), not from its text. */
  played?: true;
}

/**
 * Held weakly: an element let go takes its records with it. An element removed from the page keeps
 * its written values until it comes back, when the rewrite takes them over again.
 */
const writes = new WeakMap<Element, Map<string, Written>>();
/** Whether anything was ever written: until then, nothing is shown differently. */
let anyWritten = false;

/**
 * What the agent last wrote into `el`'s attribute `name`, if it did. The page may have changed the
 * attribute since: the record is only what the page's value is compared with (`applied`).
 */
export function writtenAttribute(el: Element, name: string): Written | undefined {
  return writes.get(el)?.get(name);
}

/** Keeps `record` as what the agent wrote into `el`'s attribute `name`; undefined forgets it. */
export function setWrittenAttribute(el: Element, name: string, record: Written | undefined): void {
  const byName = writes.get(el);
  if (!record) {
    byName?.delete(name);
    return;
  }
  anyWritten = true;
  if (byName) byName.set(name, record);
  else writes.set(el, new Map([[name, record]]));
}

/**
 * An attribute's value as the page gave it, for the client: `value` (as it reads now) unless the
 * agent wrote the attribute and the page has not changed it since, then the value it had before.
 */
export function shownAttribute(el: Element, name: string, value: string | null): string | null {
  const record = writes.get(el)?.get(name);
  return record && value === record.applied ? record.original : value;
}

/** The elements of `node` and below (light DOM), `node` first. */
function* elementsOf(node: Node): Generator<Element> {
  const stack: Node[] = [node];
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (isElement(next)) yield next;
    for (let child = next.lastChild; child; child = child.previousSibling) stack.push(child);
  }
}

/** Whether the agent wrote an attribute of `node` or of an element below it (light DOM). */
export function hasWritten(node: Node): boolean {
  if (!anyWritten) return false;
  for (const el of elementsOf(node)) if (writes.has(el)) return true;
  return false;
}

/**
 * A copy of `node` (`cloneNode(true)`), its attributes the agent wrote shown as the page gave them,
 * for a copy or a serialization the client takes for the page's.
 */
export function shownCopy(node: Node): Node {
  const copy = node.cloneNode(true);
  if (!hasWritten(node)) return copy;
  // A clone has the same shape: its elements, in the same order, are those of `node`.
  const sources = Array.from(elementsOf(node));
  const copies = Array.from(elementsOf(copy));
  sources.forEach((source, i) => {
    const target = copies[i];
    if (!target) return;
    for (const [name, record] of writes.get(source) ?? [])
      if (nativeCall<string | null>(target, 'getAttribute', name) === record.applied)
        nativeCall(target, 'setAttribute', name, record.original);
  });
  return copy;
}
