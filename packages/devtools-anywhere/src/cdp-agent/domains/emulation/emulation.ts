import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { CdpError } from '../../core/session';
import { injectOwnStyle } from './inject';
import { MediaEmulation } from './media';
import { rewriteColorScheme, rewriteMedia, rewriteValues } from './rewrite';
import { safeAreaCss, safeAreaRewrite } from './safe-area';
import { useShadowRoots } from './trees';
import { VISION, setVision, useVisionContext } from './vision';

/**
 * What each emulation is set to by which session: like Chrome's, it is the page's, the last
 * session to set it wins, and it ends with the session that set it. The media features are not
 * here: each session keeps its own, and the others' stay (`media`).
 */
const owners = new Map<string, object>();

function own(owner: object, what: string, active: boolean) {
  if (active) owners.set(what, owner);
  else owners.delete(what);
}

/** Whether the safe area rewrite is in place: installed when an inset is first emulated, removed when none is. */
let safeAreaRewriting = false;

/**
 * Emulates the insets set (null: none, which ends the emulation), and returns whether one is set. The
 * rewrite of the page's style sheets is installed once, and a later change of the values only sets the
 * custom properties of the emulation's own style sheet (safe-area.ts).
 */
function emulateSafeArea(insets: Protocol.Emulation.SafeAreaInsets | null): boolean {
  const css = insets && safeAreaCss(insets);
  if (!css) {
    if (safeAreaRewriting) rewriteValues('safeArea', null);
    safeAreaRewriting = false;
    injectOwnStyle('safeArea', null);
    return false;
  }
  if (!safeAreaRewriting) rewriteValues('safeArea', safeAreaRewrite);
  safeAreaRewriting = true;
  injectOwnStyle('safeArea', css);
  return true;
}

const RESETS: Record<string, () => void> = {
  safeArea: () => void emulateSafeArea(null),
  vision: () => setVision('none'),
};

/** The media emulation of the page, as the sessions have set it (media.ts). */
const media = new MediaEmulation();

export function registerEmulation(ctx: Context) {
  const { session } = ctx;
  useVisionContext(ctx.probe.top, ctx.shadowRoots);
  useShadowRoots(ctx.shadowRoots);
  session.register('Emulation', {
    // Done by rewriting the media queries of the page's style sheets, the `media` of its <source> elements
    // and the `sizes` of its images (domains/emulation/rewrite.ts).
    setEmulatedMedia(params: Protocol.Emulation.SetEmulatedMediaRequest) {
      rewriteMedia('media', media.set(session, params));
      rewriteColorScheme(media.colorScheme());
    },
    // Done by rewriting env(safe-area-inset-*) in the page's style sheets and style attributes to read custom
    // properties (safe-area.ts).
    setSafeAreaInsetsOverride({ insets }: Protocol.Emulation.SetSafeAreaInsetsOverrideRequest) {
      own(session, 'safeArea', emulateSafeArea(insets));
    },
    // Chrome's SVG filters, as the backdrop filter of a mask in the top layer (vision.ts).
    setEmulatedVisionDeficiency({ type }: Protocol.Emulation.SetEmulatedVisionDeficiencyRequest) {
      if (type !== 'none' && !VISION[type]) throw new CdpError('Unknown vision deficiency type', -32602);
      setVision(type);
      own(session, 'vision', type !== 'none');
    },
  });
  session.onReset(() => {
    // The session ends as a call with nothing, as Chrome's does: whoever set the media type, it goes.
    rewriteMedia('media', media.end(session));
    rewriteColorScheme(media.colorScheme());
    for (const [what, owner] of owners) {
      if (owner !== session) continue;
      owners.delete(what);
      RESETS[what]?.();
    }
  });
}
