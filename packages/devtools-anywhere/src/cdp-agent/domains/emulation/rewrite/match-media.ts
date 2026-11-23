import { currentMediaRewrite } from './rewrite';

/**
 * The rewrite of the media queries matchMedia() gives: the media emulation now in effect, composed over the
 * sessions as the page's style sheets get it (rewrite.ts), or null for none.
 */
export function matchMediaRewrite(): ((text: string) => string) | null {
  return currentMediaRewrite();
}
