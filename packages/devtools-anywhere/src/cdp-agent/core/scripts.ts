/**
 * Script ids, shared by Debugger.scriptParsed and every call frame the agent sends (core/stack.ts),
 * so that the frontend can resolve a frame to the script it was told about. Page scripts cannot
 * see V8's script ids: a script is known by its execution context and URL instead.
 */
import type { Protocol } from 'devtools-protocol';
import { parseStack } from './stack';

/**
 * What every script id starts with: '' or `m{ns}.` in a page whose agent is merged into its
 * parent's (core/frames/merged-frames.ts).
 */
let idPrefix = '';

/** Script id per execution context and URL, stable for the page's lifetime. */
const ids = new Map<string, string>();
/** Script URL per script id. */
const urls = new Map<string, string>();

/** Sets what the script ids start with (see {@link idPrefix}). */
export function setScriptIdPrefix(prefix: string): void {
  idPrefix = prefix;
}

/** What the script ids start with: '' unless merged into a parent's agent. */
export function scriptIdPrefix(): string {
  return idPrefix;
}

/**
 * The id of the script at `url` in that execution context, given one on first use. Debugger.scriptParsed
 * reports a script with this id, whether it is seen first there or in a call frame: a frame sent before
 * its script is reported resolves once it is.
 */
export function scriptIdFor(executionContextId: number, url: string): string {
  const key = `${executionContextId} ${url}`;
  let id = ids.get(key);
  if (id === undefined) {
    id = idPrefix + String(ids.size + 1);
    ids.set(key, id);
    urls.set(id, url);
  }
  return id;
}

/**
 * The script id for a call frame at `url` running in that execution context. A frame's code may come
 * from another frame's script (a function of the parent called by an iframe): the context's own script
 * first, else the script of that URL in any context, else a new id for the context's.
 */
export function scriptIdOfFrame(executionContextId: number, url: string): string {
  const own = ids.get(`${executionContextId} ${url}`);
  if (own !== undefined) return own;
  for (const [id, scriptUrl] of urls) if (scriptUrl === url) return id;
  return scriptIdFor(executionContextId, url);
}

/** The URL of a script id, if it was given out. */
export function scriptUrlOf(scriptId: string): string | undefined {
  return urls.get(scriptId);
}

/**
 * The call frames of an `Error().stack` taken in that execution context, each with its script's id
 * (see {@link parseStack}).
 */
export function stackOf(stack: string | undefined, executionContextId: number, skip = 0): Protocol.Runtime.CallFrame[] {
  return parseStack(stack, url => scriptIdOfFrame(executionContextId, url), skip);
}
