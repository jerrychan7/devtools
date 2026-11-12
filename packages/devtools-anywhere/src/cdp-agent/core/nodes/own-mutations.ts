/**
 * The observers that report the page's DOM changes to a client (the DOM domain's). The agent's own
 * writes into the page (the emulation's rewrites of attributes) are not changes of the page's:
 * {@link quietMutations} keeps them out of what these observers see, after giving them the
 * changes the page made so far.
 */
type Deliver = (records: MutationRecord[]) => void;

const sinks = new Map<MutationObserver, Deliver>();

/** Registers `observer`, whose records `deliver` takes; returns a function that unregisters it. */
export function sinkMutations(observer: MutationObserver, deliver: Deliver): () => void {
  sinks.set(observer, deliver);
  return () => void sinks.delete(observer);
}

/**
 * Runs `fn`, a write of the agent's own, so that no registered observer reports it. Records of the
 * page's changes not yet delivered are delivered first, as they are the page's.
 */
export function quietMutations<T>(fn: () => T): T {
  if (!sinks.size) return fn();
  for (const [observer, deliver] of sinks) {
    const records = observer.takeRecords();
    if (records.length) deliver(records);
  }
  try {
    return fn();
  } finally {
    for (const observer of sinks.keys()) observer.takeRecords();
  }
}
