// Links this page's CDP agent with those of cross-origin iframes, and of its parent when it is in
// one, as the probe's data-frame-origins and data-parent-origins allow (protocol.ts).
import type { FrameLinkOptions } from '../api';
import { parseOrigins } from './origins';
import { linkChildren } from './parent';

/** Starts linking as `options` allow; returns a function that stops and closes the links. */
export function linkFrames(options: FrameLinkOptions): () => void {
  const frameOrigins = parseOrigins(options.frameOrigins);
  const stopChildren = frameOrigins.length ? linkChildren(frameOrigins) : () => {};
  return () => stopChildren();
}
