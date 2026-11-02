import { type Frame, frames, walkFrameOwners } from './core/frames';
import { type FrameOwner, contentWindowOf, isShadowRoot } from './core/realm';

/** A frame owner, the frame whose document holds it, and the window it holds now, if any. */
export interface FoundOwner {
  owner: FrameOwner;
  frame: Frame;
  window: Window | null;
}

/**
 * The frame owners of the page: in the top document and its same-origin frames, shadow trees
 * included, each with the frame whose document holds it. Cross-origin iframes are among them:
 * their element is in reach, not their document.
 */
export function frameOwners(): FoundOwner[] {
  frames.sync();
  const found: FoundOwner[] = [];
  for (const frame of frames) {
    walkFrameOwners(frame.document, frames.shadowRootOf, node => {
      if (!isShadowRoot(node)) found.push({ owner: node, frame, window: contentWindowOf(node) });
    });
  }
  return found;
}

/**
 * The frame owner whose window `win` is (a MessageEvent's `source`, say), with the frame whose
 * document holds it; none for a window that is not one of the page's frames.
 */
export function ownerOfWindow(win: unknown): FoundOwner | undefined {
  if (!win) return undefined;
  return frameOwners().find(found => found.window === win);
}

/**
 * Calls `gone` once when a frame owner leaves the page: removed (or a shadow host or frame holding
 * it is), or moved, which gives it another window. Returns a function that stops watching.
 */
export function watchOwner(owner: FrameOwner, gone: () => void): () => void {
  const win = contentWindowOf(owner);
  const observer = new MutationObserver(() => check());
  const offFrames = frames.onChange(() => check());
  const stop = () => {
    observer.disconnect();
    offFrames();
  };
  const check = () => {
    if (owner.isConnected && frames.ofDocument(owner.ownerDocument) && contentWindowOf(owner) === win) return;
    stop();
    gone();
  };
  // The owner's tree, and each tree up to the document: removing a shadow host is seen in its own.
  let root = owner.getRootNode();
  for (;;) {
    observer.observe(root, { childList: true, subtree: true });
    if (!isShadowRoot(root)) break;
    root = root.host.getRootNode();
  }
  return stop;
}
