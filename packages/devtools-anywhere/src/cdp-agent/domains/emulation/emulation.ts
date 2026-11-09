import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { CdpError } from '../../core/session';
import { mediaRewrite } from './media';
import { rewriteMedia, rewriteValues } from './rewrite';
import { safeAreaRewrite } from './safe-area';
import { VISION, setVision } from './vision';

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
    // Chrome's SVG filters, as the backdrop filter of a mask in the top layer (vision.ts).
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
