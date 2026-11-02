// Links this page's CDP agent with those of cross-origin iframes, and of its parent when it is in
// one, as the probe's data-frame-origins and data-parent-origins allow (protocol.ts).
import type { FrameLinkOptions } from '../api';
import type { CdpSession } from '../cdp-agent';
import { linkParent } from './child';
import { parseOrigins } from './origins';
import { linkChildren } from './parent';

/**
 * Starts linking as `options` allow; linked to its parent, the page is debugged through a session
 * `createSession` makes. Returns a function that stops and closes the links.
 */
export function linkFrames(options: FrameLinkOptions, createSession: () => CdpSession): () => void {
  const frameOrigins = parseOrigins(options.frameOrigins);
  const parentOrigins = parseOrigins(options.parentOrigins);
  const stopChildren = frameOrigins.length ? linkChildren(frameOrigins) : () => {};
  const stopParent = parentOrigins.length ? linkParent(parentOrigins, createSession) : () => {};
  return () => {
    stopChildren();
    stopParent();
  };
}
