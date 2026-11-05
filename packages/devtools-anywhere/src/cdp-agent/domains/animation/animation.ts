import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { isOwn, type Inspectable, type PseudoType } from '../../core/nodes';
import { documentOf, isElement, styleOf } from '../../core/realm';
import { CdpError } from '../../core/session';

const NOT_FOUND = 'Could not find animation with given id';

/** What a tracked animation looked like when last reported, to tell when the page changed it. */
interface Tracked {
  id: string;
  animation: Animation;
  /** Whether `animationStarted` was sent: an animation is announced once it is no longer pending. */
  started: boolean;
  /** Its own playback rate, before the domain's rate (`setPlaybackRate`) is applied. */
  rate: number;
  /** The start time last reported. */
  start: number | null;
  /** Frames to wait before reporting a seek's new start time (see `seekAnimations`). */
  hold: number;
}

/**
 * Whether `value` has the getter `name` of `proto`, the brand check of a Web IDL interface. Unlike
 * `instanceof`, it holds across realms: an animation of a same-origin iframe is a `CSSAnimation` of
 * the iframe's window, not of the top page's.
 */
function hasGetter(proto: object | undefined, name: string, value: object): boolean {
  const get = proto && Object.getOwnPropertyDescriptor(proto, name)?.get;
  if (!get) return false;
  try {
    get.call(value);
    return true;
  } catch {
    return false;
  }
}

const isCssAnimation = (a: Animation): a is CSSAnimation =>
  typeof CSSAnimation === 'function' && hasGetter(CSSAnimation.prototype, 'animationName', a);
const isCssTransition = (a: Animation): a is CSSTransition =>
  typeof CSSTransition === 'function' && hasGetter(CSSTransition.prototype, 'transitionProperty', a);
const isKeyframeEffect = (e: AnimationEffect | null): e is KeyframeEffect =>
  !!e && typeof KeyframeEffect === 'function' && hasGetter(KeyframeEffect.prototype, 'pseudoElement', e);

/** The animation's type and name, as Chrome names them. */
function kindOf(animation: Animation): [Protocol.Animation.Animation['type'], string] {
  if (isCssAnimation(animation)) return ['CSSAnimation', animation.animationName];
  if (isCssTransition(animation)) return ['CSSTransition', animation.transitionProperty];
  return ['WebAnimation', animation.id];
}

const ANIMATION_LONGHANDS = [
  'animation-name',
  'animation-duration',
  'animation-timing-function',
  'animation-delay',
  'animation-iteration-count',
  'animation-direction',
  'animation-fill-mode',
  'animation-composition',
  'animation-timeline',
  'animation-range-start',
  'animation-range-end',
];
const TRANSITION_LONGHANDS = [
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
  'transition-behavior',
];

/** FNV-1a, as base64 of its 4 bytes: short, and shaped like Chrome's ids. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return btoa(String.fromCharCode(h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255));
}

/**
 * The `cssId` of a CSS animation or transition. The panel takes two groups of CSS animations with
 * the same ids for one, and replaces the first with the second, so without one every group of a
 * single CSS animation replaced the last. Chrome hashes the rule the animation came from: measured,
 * one rule gives one id on any element whatever its other classes or inline style, when played
 * again after the element changed, and for a transition to any value; all the animations of one
 * `animation` list share it; another rule with the very same declarations, or the same declaration
 * written inline, gives another. The page cannot tell which rule won, so this hashes only the
 * pseudo-element and the computed animation (or transition) longhands, leaving out
 * `animation-play-state`, which another rule may toggle. What remains different from Chrome: the
 * same declarations in different rules (or inline) share an id here, where Chrome's differ.
 * So does a hover round trip (`.tr` → `.tr.hov` → `.tr`, where `.tr.hov` sets only the width):
 * Chrome gives the transition into the hover state another id than the ones out of it, ours all
 * share one. Telling these apart needs the rules that match the element, which only the CSS
 * domain's cascade (domains/css/cascade.ts) works out, from its sheet registry and forced
 * pseudo-classes: too much to build for the Animation domain, which must work without the CSS one.
 */
const cssIds = new WeakMap<Animation, string>();
/** Taken when first described and kept, as in Chrome, where it does not change with the element. */
function cssIdOf(
  animation: Animation,
  effect: KeyframeEffect,
  type: 'CSSAnimation' | 'CSSTransition'
): string | undefined {
  const known = cssIds.get(animation);
  if (known) return known;
  const { target, pseudoElement } = effect;
  if (!target) return undefined;
  let style: CSSStyleDeclaration;
  try {
    style = styleOf(target, pseudoElement ?? undefined);
  } catch {
    return undefined;
  }
  const longhands = type === 'CSSAnimation' ? ANIMATION_LONGHANDS : TRANSITION_LONGHANDS;
  const id = hash([type, pseudoElement ?? '', ...longhands.map(name => style.getPropertyValue(name))].join('\n'));
  cssIds.set(animation, id);
  return id;
}

/** `0.3` → `"30%"`: Blink's number formatting, which drops the float noise of `0.3 * 100`. */
const percent = (offset: number) => `${Number((offset * 100).toPrecision(6))}%`;

const PSEUDO_TYPES: readonly string[] = ['marker', 'before', 'after'] satisfies PseudoType[];
const isPseudoType = (type: string): type is PseudoType => PSEUDO_TYPES.includes(type);

/** Who an effect animates: its element, or the pseudo-element of it the effect names. */
function targetOf(ctx: Context, effect: KeyframeEffect): Inspectable | null {
  const { target, pseudoElement } = effect;
  if (!target || !pseudoElement) return target;
  const type = pseudoElement.replace(/^::?/, '');
  return isPseudoType(type) ? ctx.nodes.pseudoOf(target, type) : target;
}

/**
 * What `animationUpdated` follows: Chrome sends it when an animation gets a new start time (the page
 * finishing it, or playing it again once finished, or the domain seeking it while it runs), not
 * when the page pauses it, nor for the domain's other commands. Null while paused or pending,
 * which is no update.
 */
function startOf(animation: Animation): number | null {
  const { startTime } = animation;
  return typeof startTime === 'number' ? startTime : null;
}

/**
 * Animation: the Animations panel, from `getAnimations()` of each document in the page, which has
 * the CSS animations and transitions and those of the Web Animations API. The page has no event for
 * an animation starting, so the documents are looked at on every frame while the domain is enabled.
 *
 * The playback rate Chrome sets on the documents' timelines is set on each animation instead, so
 * the page reads the product of its own rate and the panel's in `playbackRate`; what the panel is
 * told is the animation's own.
 */
export function registerAnimation(ctx: Context) {
  const { session } = ctx;
  const byId = new Map<string, Tracked>();
  let tracked = new WeakMap<Animation, Tracked>();
  /**
   * Animations the client released: not announced again, and still slowed down by the domain's
   * rate, which is the documents' in Chrome. Forgotten when they end.
   */
  const released = new Map<Animation, Tracked>();
  let seq = 0;
  let rate = 1;
  let frame = 0;

  const current = (t: Tracked) => {
    const value = t.animation.currentTime;
    return typeof value === 'number' ? value : 0;
  };

  const describe = (t: Tracked): Protocol.Animation.Animation => {
    const { animation } = t;
    const [type, name] = kindOf(animation);
    const startTime = animation.startTime;
    const result: Protocol.Animation.Animation = {
      id: t.id,
      name,
      pausedState: animation.playState === 'paused',
      playState: animation.playState,
      playbackRate: t.rate,
      startTime: typeof startTime === 'number' ? startTime : 0,
      currentTime: current(t),
      type,
    };
    const effect = animation.effect;
    if (isKeyframeEffect(effect)) {
      if (type !== 'WebAnimation') {
        const cssId = cssIdOf(animation, effect, type);
        if (cssId) result.cssId = cssId;
      }
      const timing = effect.getComputedTiming();
      const source: Protocol.Animation.AnimationEffect = {
        delay: timing.delay ?? 0,
        endDelay: timing.endDelay ?? 0,
        iterationStart: timing.iterationStart ?? 0,
        duration: typeof timing.duration === 'number' ? timing.duration : 0,
        direction: timing.direction ?? 'normal',
        fill: timing.fill ?? 'none',
        easing: timing.easing ?? 'linear',
      };
      // Infinite iterations are left out, as in Chrome.
      if (timing.iterations !== undefined && Number.isFinite(timing.iterations)) source.iterations = timing.iterations;
      const target = targetOf(ctx, effect);
      if (target) source.backendNodeId = ctx.nodes.backendIdOf(target);
      // A transition's keyframes are not a rule, and Chrome sends none.
      if (type !== 'CSSTransition') {
        source.keyframesRule = {
          // A CSS animation's rule lists only the keyframes written in it; the 0% and 100% the
          // browser fills in are left out, as in Chrome. They are the ones whose composite is
          // `replace`: written ones have `auto`, whatever `animation-composition` says.
          keyframes: effect
            .getKeyframes()
            .filter(k => type !== 'CSSAnimation' || k.composite !== 'replace')
            .map(k => ({ offset: percent(k.computedOffset), easing: k.easing ?? 'linear' })),
        };
      }
      result.source = source;
    }
    return result;
  };

  const documents = () => Array.from(ctx.frames, f => f.document);

  /**
   * The shadow roots in the documents: a document's `getAnimations()` leaves out the animations in
   * its shadow trees, which Chrome's panel shows. Walked again only after a shadow root is attached.
   */
  let shadowRootCache: ShadowRoot[] | null = null;
  let stopShadowRoots: (() => void) | null = null;
  const shadowRoots = (): ShadowRoot[] => {
    if (shadowRootCache) return shadowRootCache;
    const roots: ShadowRoot[] = [];
    const visit = (root: Document | ShadowRoot) => {
      const walker = documentOf(root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!isElement(node) || isOwn(node)) continue;
        const shadowRoot = ctx.nodes.shadowRootOf(node);
        if (!shadowRoot) continue;
        roots.push(shadowRoot);
        visit(shadowRoot);
      }
    };
    documents().forEach(visit);
    return (shadowRootCache = roots);
  };

  /** Announces new animations, and changes the page made to the ones announced. */
  const scan = () => {
    for (const tree of [...documents(), ...shadowRoots()]) {
      let animations: Animation[];
      try {
        animations = tree.getAnimations();
      } catch {
        continue;
      }
      for (const animation of animations) {
        if (released.has(animation)) continue;
        let t = tracked.get(animation);
        if (!t) {
          t = { id: String(++seq), animation, started: false, rate: animation.playbackRate, start: null, hold: 0 };
          tracked.set(animation, t);
          byId.set(t.id, t);
          if (rate !== 1) animation.playbackRate = t.rate * rate;
          session.emit('Animation.animationCreated', { id: t.id });
        }
      }
    }
    // Finished ones leave getAnimations() too, and are updated when the page plays them again.
    for (const t of byId.values()) {
      const { animation } = t;
      if (!t.started) {
        if (animation.pending || animation.playState === 'idle') continue;
        t.started = true;
        t.start = startOf(animation);
        session.emit('Animation.animationStarted', { animation: describe(t) });
        continue;
      }
      const start = startOf(animation);
      if (t.hold > 0) {
        t.hold--;
        continue;
      }
      if (start !== null && start !== t.start) {
        t.start = start;
        session.emit('Animation.animationUpdated', { animation: describe(t) });
      }
    }
    // Canceled ones are idle; finished ones are not.
    for (const animation of released.keys()) if (animation.playState === 'idle') released.delete(animation);
    for (const t of byId.values()) {
      if (!t.started || t.animation.playState !== 'idle') continue;
      byId.delete(t.id);
      session.emit('Animation.animationCanceled', { id: t.id });
    }
  };

  const loop = () => {
    scan();
    frame = requestAnimationFrame(loop);
  };

  const find = (id: string) => {
    const t = byId.get(id);
    if (!t) throw new CdpError(NOT_FOUND);
    return t;
  };
  /** Runs `change` and takes what it did as known, so it is not reported as the page's. */
  const quietly = (t: Tracked, change: () => void) => {
    change();
    t.start = startOf(t.animation) ?? t.start;
  };

  const setRate = (value: number) => {
    rate = value;
    for (const t of [...byId.values(), ...released.values()])
      quietly(t, () => (t.animation.playbackRate = t.rate * rate));
  };

  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    stopShadowRoots?.();
    stopShadowRoots = null;
    shadowRootCache = null;
    if (rate !== 1) setRate(1);
    byId.clear();
    tracked = new WeakMap();
    released.clear();
  };
  session.onReset(stop);

  session.register('Animation', {
    enable: () => {
      stopShadowRoots ??= ctx.probe.onShadowRoot(() => (shadowRootCache = null));
      if (!frame) loop();
    },
    disable: stop,
    getPlaybackRate: () => ({ playbackRate: rate }),
    setPlaybackRate: ({ playbackRate }: Protocol.Animation.SetPlaybackRateRequest) => setRate(playbackRate),
    getCurrentTime: ({ id }: Protocol.Animation.GetCurrentTimeRequest) => ({ currentTime: current(find(id)) }),
    setPaused: ({ animations, paused }: Protocol.Animation.SetPausedRequest) => {
      const list = animations.map(find);
      for (const t of list)
        quietly(t, () => {
          if (paused) t.animation.pause();
          else if (t.animation.playState === 'paused') t.animation.play();
        });
    },
    seekAnimations: ({ animations, currentTime, currentTimes }: Protocol.Animation.SeekAnimationsRequest) => {
      // The panel sends one time per animation, `currentTimes`; Chrome's messages.
      if ((currentTime === undefined) === (currentTimes === undefined))
        throw new CdpError('Only one of current_time or current_times may be set.');
      if (currentTimes && currentTimes.length !== animations.length)
        throw new CdpError('current_times should be the same size as animation_ids.');
      const list = animations.map(find);
      // Not quietly: a running animation seeked gets a new start time, which Chrome reports with
      // `animationUpdated`, and the panel's play button waits for it to show it playing. The panel
      // reads its own scrubber then, which it starts as it seeks: told in the very next frame, it
      // finds the scrubber not started yet and shows "Replay". Chrome's report comes later, across
      // processes, so this one waits two frames.
      for (const [i, t] of list.entries()) {
        t.animation.currentTime = currentTimes?.[i] ?? currentTime ?? 0;
        t.hold = 2;
      }
    },
    setTiming: ({ animationId, duration, delay }: Protocol.Animation.SetTimingRequest) => {
      const t = find(animationId);
      quietly(t, () => t.animation.effect?.updateTiming({ duration, delay }));
    },
    releaseAnimations: ({ animations }: Protocol.Animation.ReleaseAnimationsRequest) => {
      for (const id of animations) {
        const t = byId.get(id);
        if (!t) continue;
        byId.delete(id);
        released.set(t.animation, t);
      }
    },
    resolveAnimation: ({ animationId }: Protocol.Animation.ResolveAnimationRequest) => ({
      remoteObject: ctx.objects.wrap(find(animationId).animation),
    }),
  });
}
