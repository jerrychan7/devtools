import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { frames } from '../../core/frames';
import { markOwn } from '../../core/nodes';
import { CdpError } from '../../core/session';
import { mediaRewrite } from './media';
import { rewriteMedia, rewriteValues } from './rewrite';
import { safeAreaRewrite } from './safe-area';

/** The SVG filters Chrome puts on the page's root element for each vision deficiency. */
const VISION: Record<string, string> = {
  blurredVision: '<feGaussianBlur stdDeviation="2"/>',
  reducedContrast:
    '<feComponentTransfer><feFuncR type="gamma" offset="0.5"/><feFuncG type="gamma" offset="0.5"/><feFuncB type="gamma" offset="0.5"/></feComponentTransfer>',
  achromatopsia: matrix('0.213 0.715 0.072 0.213 0.715 0.072 0.213 0.715 0.072'),
  deuteranopia: matrix('0.367 0.861 -0.228 0.280 0.673 0.047 -0.012 0.043 0.969'),
  protanopia: matrix('0.152 1.053 -0.205 0.115 0.786 0.099 -0.004 -0.048 1.052'),
  tritanopia: matrix('1.256 -0.077 -0.179 -0.078 0.931 0.148 0.005 0.691 0.304'),
};

/** A color matrix filter from its 3×3 RGB part, alpha kept. */
function matrix(rgb: string): string {
  const v = rgb.split(' ');
  const row = (i: number) => `${v.slice(i * 3, i * 3 + 3).join(' ')} 0 0`;
  return `<feColorMatrix values="${row(0)} ${row(1)} ${row(2)} 0 0 0 1 0"/>`;
}

/** The <style> of the vision deficiency filter, hidden from the client. */
let visionStyle: HTMLStyleElement | null = null;

function setVision(type: string) {
  const filter = VISION[type];
  if (!filter) {
    visionStyle?.remove();
    visionStyle = null;
    return;
  }
  const doc = frames.top.document;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><filter id="f">${filter}</filter></svg>`;
  if (!visionStyle) {
    visionStyle = doc.createElement('style');
    markOwn(visionStyle);
  }
  visionStyle.textContent = `:root { filter: url("data:image/svg+xml,${encodeURIComponent(svg)}#f") !important }`;
  if (!visionStyle.isConnected) doc.documentElement.append(visionStyle);
}

/**
 * What each emulation is set to by which session: like Chrome's, it is the page's, the last
 * session to set it wins, and it ends with the session that set it.
 */
const owners = new Map<string, object>();

function own(owner: object, what: string, active: boolean) {
  if (active) owners.set(what, owner);
  else owners.delete(what);
}

const RESETS: Record<string, () => void> = {
  media: () => rewriteMedia('media', null),
  safeArea: () => rewriteValues('safeArea', null),
  vision: () => setVision('none'),
};

export function registerEmulation(ctx: Context) {
  const { session } = ctx;
  session.register('Emulation', {
    // Done by rewriting the @media conditions of the page's style sheets (domains/emulation/rewrite.ts).
    setEmulatedMedia(params: Protocol.Emulation.SetEmulatedMediaRequest) {
      const rewrite = mediaRewrite(params);
      rewriteMedia('media', rewrite);
      own(session, 'media', !!rewrite);
    },
    // Done by rewriting env(safe-area-inset-*) in the page's style sheets.
    setSafeAreaInsetsOverride({ insets }: Protocol.Emulation.SetSafeAreaInsetsOverrideRequest) {
      const rewrite = safeAreaRewrite(insets);
      rewriteValues('safeArea', rewrite);
      own(session, 'safeArea', !!rewrite);
    },
    // Chrome filters the root element with an SVG filter too; ours is seen by getComputedStyle().
    setEmulatedVisionDeficiency({ type }: Protocol.Emulation.SetEmulatedVisionDeficiencyRequest) {
      if (type !== 'none' && !VISION[type]) throw new CdpError('Unknown vision deficiency type', -32602);
      setVision(type);
      own(session, 'vision', type !== 'none');
    },
  });
  session.onReset(() => {
    for (const [what, owner] of owners) {
      if (owner !== session) continue;
      owners.delete(what);
      RESETS[what]?.();
    }
  });
}
