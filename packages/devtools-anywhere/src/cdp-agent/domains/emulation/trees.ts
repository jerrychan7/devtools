import { frames } from '../../core/frames/frames';
import type { ShadowRootTracker } from '../../core/nodes/shadow-roots';
import { realmOf } from '../../core/realm';

/** A tree of the page: the document of a frame, or a shadow root in one. */
export type Tree = Document | ShadowRoot;

/** The shadow roots of the frames' documents, kept by the session whose emulation runs. */
let shadowRoots: ShadowRootTracker | undefined;

/** Takes the shadow root tracker of the session that registered the emulation (the last one). */
export function useShadowRoots(tracker: ShadowRootTracker): void {
  shadowRoots = tracker;
}

/**
 * The documents of the frames and the shadow roots in them, as the page has them now: each
 * document first, the shadow roots of devtools-anywhere's own elements left out.
 */
export function pageTrees(): Tree[] {
  const trees: Tree[] = [];
  for (const frame of frames) trees.push(frame.document);
  if (shadowRoots) trees.push(...shadowRoots.roots());
  return trees;
}

/** The windows of the documents of `trees`, for the CSSOM hooks of their realms. */
export const realmsOf = (trees: Tree[]) => trees.map(tree => realmOf(tree));

/**
 * Calls `listener` when the trees may have changed: a frame came or went or loaded another
 * document, or a shadow root was attached or came into the page (soon after, once per microtask).
 * Holds the shadow root tracker while it listens; returns the function that stops.
 */
export function followTrees(listener: () => void): () => void {
  const release = shadowRoots?.acquire();
  const unsubscribe = shadowRoots?.onStale(listener);
  const stopFrames = frames.onChange(() => listener());
  return () => {
    stopFrames();
    unsubscribe?.();
    release?.();
  };
}
