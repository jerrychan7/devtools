// How a node takes part in the accessibility tree (Inclusion) and why it is ignored, with the
// element sets the inclusion rules share. Part of accessibility.js (ax-node.ts).
import { type Hiding } from './ax-hidden';

/** Why a node in the tree is ignored (CDP `AXPropertyName`). */
export type IgnoredReason =
  | 'uninteresting'
  | 'ariaHiddenElement'
  | 'ariaHiddenSubtree'
  | 'notRendered'
  | 'notVisible'
  | 'presentationalRole'
  | 'emptyAlt'
  | 'inertElement'
  | 'labelFor';

/**
 * How a DOM node takes part in the tree: `included`, ignored but kept (`reason`), left out with its
 * children taking its place (`lifted`), or left out with its subtree (`excluded`). An ignored node
 * with `noReason` is one Chrome ignores without giving a reason (a ruby annotation).
 */
export type Inclusion =
  | { kind: 'included' }
  | {
      kind: 'ignored';
      reason: IgnoredReason;
      hiddenRoot?: Element;
      noReason?: true;
    }
  | { kind: 'lifted'; reason: IgnoredReason; hiddenRoot?: Element }
  | { kind: 'excluded'; reason: IgnoredReason; hiddenRoot?: Element };

/** Elements whose text and children the page does not show as content: replaced by their value or a popup. */
export const OPAQUE = new Set(
  'script style template noscript title head textarea select option input img br wbr iframe object embed video audio canvas'.split(
    ' '
  )
);

/** Elements Chrome has no layout object for, ignored as not rendered. */
export const NOT_RENDERED = new Set('col colgroup map noscript source track wbr'.split(' '));

/** The inclusions, built once (included) or by kind. */
export const INCLUDED: Inclusion = { kind: 'included' };
export const ignored = (reason: IgnoredReason): Inclusion => ({
  kind: 'ignored',
  reason,
});
export const lifted = (reason: IgnoredReason): Inclusion => ({
  kind: 'lifted',
  reason,
});
export const excluded = (reason: IgnoredReason): Inclusion => ({
  kind: 'excluded',
  reason,
});
/** A hidden node's inclusion, with the aria-hidden root that hides it, if any. */
export const hidden = (kind: 'ignored' | 'lifted' | 'excluded', hiding: Hiding): Inclusion => ({
  kind,
  reason: hiding.reason,
  ...(hiding.hiddenRoot && { hiddenRoot: hiding.hiddenRoot }),
});
