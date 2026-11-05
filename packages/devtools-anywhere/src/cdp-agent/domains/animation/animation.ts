import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { type Inspectable, type PseudoType } from '../../core/nodes';
import { isNode, realmOf, styleOf } from '../../core/realm';
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
  /** Whether it is idle and was reported so (or never ran): cancelled once, reported once. */
  canceled: boolean;
  /** Released by the client: not reported again, nor found by id; still slowed by the domain's rate. */
  released: boolean;
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

type Realm = Window & typeof globalThis;

/**
 * The window an animation belongs to, from its effect's target: an animation of a same-origin
 * iframe is a `CSSAnimation` of the iframe's window, not of the top page's. Null without a target
 * (a Web Animation the page made without one), when `hasGetter` decides instead: it is slower, as
 * it throws for every animation that is not of the interface.
 */
function realmOfAnimation(animation: Animation): Realm | null {
  const target: unknown = animation.effect ? Reflect.get(animation.effect, 'target') : null;
  return isNode(target) ? realmOf(target) : null;
}

const isCssAnimation = (a: Animation, realm: Realm | null): a is CSSAnimation =>
  realm
    ? typeof realm.CSSAnimation === 'function' && a instanceof realm.CSSAnimation
    : typeof CSSAnimation === 'function' && hasGetter(CSSAnimation.prototype, 'animationName', a);
const isCssTransition = (a: Animation, realm: Realm | null): a is CSSTransition =>
  realm
    ? typeof realm.CSSTransition === 'function' && a instanceof realm.CSSTransition
    : typeof CSSTransition === 'function' && hasGetter(CSSTransition.prototype, 'transitionProperty', a);
const isKeyframeEffect = (e: AnimationEffect | null, realm: Realm | null): e is KeyframeEffect =>
  !!e &&
  (realm
    ? typeof realm.KeyframeEffect === 'function' && e instanceof realm.KeyframeEffect
    : typeof KeyframeEffect === 'function' && hasGetter(KeyframeEffect.prototype, 'pseudoElement', e));

/** The animation's type and name, as Chrome names them. */
function kindOf(animation: Animation, realm: Realm | null): [Protocol.Animation.Animation['type'], string] {
  if (isCssAnimation(animation, realm)) return ['CSSAnimation', animation.animationName];
  if (isCssTransition(animation, realm)) return ['CSSTransition', animation.transitionProperty];
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

/**
 * Who an effect animates: its element, or the pseudo-element of it the effect names. Of the other
 * pseudo-elements, Blink animates none of ::first-letter, ::first-line and ::selection (Chrome
 * announces no animation of theirs either); ::backdrop and the like, which Chrome names as nodes of
 * their own, our DOM has no node for, so their element stands in.
 */
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
  /** The animations that change on their own (running, paused, pending): looked at every frame. */
  const awake = new Map<string, Tracked>();
  /**
   * The cancelled and released ones, kept only while the page keeps them: a page that runs for long
   * makes and drops animations without end. Still found by id, as in Chrome, and woken when the page
   * plays them again (back in `getAnimations()`). Finished ones stay awake: one the page cancels is
   * in no `getAnimations()`.
   * Chrome keeps every one until disable: here one the page dropped, and the garbage collector took,
   * is no longer found by id (Could not find animation, as for a released one): a trade, so that
   * the domain does not keep alive every animation and target a long-running page ever made.
   */
  const asleep = new Map<string, WeakRef<Tracked>>();
  const collected = new FinalizationRegistry<string>(id => {
    if (!asleep.get(id)?.deref()) asleep.delete(id);
  });
  let tracked = new WeakMap<Animation, Tracked>();
  let seq = 0;
  let rate = 1;
  let frame = 0;

  const current = (t: Tracked) => {
    const value = t.animation.currentTime;
    return typeof value === 'number' ? value : 0;
  };

  const describe = (t: Tracked): Protocol.Animation.Animation => {
    const { animation } = t;
    const realm = realmOfAnimation(animation);
    const [type, name] = kindOf(animation, realm);
    const startTime = animation.startTime;
    const result: Protocol.Animation.Animation = {
      id: t.id,
      name,
      pausedState: animation.playState === 'paused',
      playState: animation.playState,
      playbackRate: t.rate,
      startTime: typeof startTime === 'number' ? startTime : 0,
      // Chrome's `animationStarted` has the current time when the start time is set: about 0 (0 for
      // a CSS animation of the top document, -0.09 for a delayed Web Animation, a frame, 16.7, in
      // an iframe), not always 0. The page is looked at a frame later, so ours is a frame on. Left
      // so: it is the animation's real time, and faking 0 would be wrong for one running before enable.
      currentTime: current(t),
      type,
    };
    const effect = animation.effect;
    if (isKeyframeEffect(effect, realm)) {
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
   * A document's `getAnimations()` leaves out the animations in its shadow trees, which Chrome's
   * panel shows; the shared tracker lists those while the domain is enabled.
   */
  let stopShadowRoots: (() => void) | null = null;

  const sleep = (t: Tracked) => {
    awake.delete(t.id);
    asleep.set(t.id, new WeakRef(t));
  };
  const wake = (t: Tracked) => {
    if (t.released || awake.has(t.id)) return;
    asleep.delete(t.id);
    awake.set(t.id, t);
  };
  /** Every tracked animation still in the page; a copy, so that they can move while it is gone through. */
  const all = (): Tracked[] => {
    const list = [...awake.values()];
    for (const ref of asleep.values()) {
      const t = ref.deref();
      if (t) list.push(t);
    }
    return list;
  };

  /** Starts tracking an animation, or wakes one the page plays again. */
  const track = (animation: Animation) => {
    const known = tracked.get(animation);
    if (known) {
      // Finished ones with `fill: forwards` stay in getAnimations(): only one that runs again wakes.
      if (animation.playState !== 'finished' && animation.playState !== 'idle') wake(known);
      return;
    }
    const t: Tracked = {
      id: String(++seq),
      animation,
      started: false,
      rate: animation.playbackRate,
      start: null,
      hold: 0,
      // Chrome reports a cancel on the change to idle: one made idle (`new Animation()`) never had it.
      canceled: animation.playState === 'idle',
      released: false,
    };
    tracked.set(animation, t);
    collected.register(t, t.id);
    awake.set(t.id, t);
    if (rate !== 1) animation.playbackRate = t.rate * rate;
    session.emit('Animation.animationCreated', { id: t.id });
  };

  /** Reports what the page changed: the start (Chrome's `animationStarted`), the start time. */
  const check = (t: Tracked) => {
    const { animation } = t;
    if (t.released) return;
    if (!t.started) {
      if (animation.pending || animation.playState === 'idle') return;
      t.started = true;
      t.start = startOf(animation);
      session.emit('Animation.animationStarted', { animation: describe(t) });
      return;
    }
    if (t.hold > 0) {
      t.hold--;
      return;
    }
    const start = startOf(animation);
    if (start !== null && start !== t.start) {
      t.start = start;
      session.emit('Animation.animationUpdated', { animation: describe(t) });
    }
  };

  /** Reports a cancel (Chrome reports one even before the start), and lets cancelled ones sleep. */
  const settle = (t: Tracked) => {
    const state = t.animation.playState;
    if (state !== 'idle') {
      t.canceled = false;
      return;
    }
    if (!t.canceled) {
      t.canceled = true;
      t.start = null;
      if (!t.released) session.emit('Animation.animationCanceled', { id: t.id });
    }
    sleep(t);
  };

  /** Announces new animations, and changes the page made to the ones announced. */
  const scan = () => {
    for (const tree of [...documents(), ...ctx.shadowRoots.roots()]) {
      let animations: Animation[];
      try {
        animations = tree.getAnimations();
      } catch {
        continue;
      }
      for (const animation of animations) track(animation);
    }
    for (const t of awake.values()) {
      check(t);
      settle(t);
    }
  };

  const loop = () => {
    scan();
    frame = requestAnimationFrame(loop);
  };

  const find = (id: string) => {
    const t = awake.get(id) ?? asleep.get(id)?.deref();
    if (!t || t.released) throw new CdpError(NOT_FOUND);
    return t;
  };
  /**
   * Runs `change` and takes what it did as known, so it is not reported as the page's. */
  const quietly = (t: Tracked, change: () => void) => {
    change();
    t.start = startOf(t.animation) ?? t.start;
  };

  const setRate = (value: number) => {
    rate = value;
    for (const t of all()) quietly(t, () => (t.animation.playbackRate = t.rate * rate));
  };

  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    stopShadowRoots?.();
    stopShadowRoots = null;
    // Every animation slowed down gets its own rate back: cancelled and released ones too.
    if (rate !== 1) setRate(1);
    awake.clear();
    asleep.clear();
    tracked = new WeakMap();
  };
  session.onReset(stop);

  session.register('Animation', {
    enable: () => {
      stopShadowRoots ??= ctx.shadowRoots.acquire();
      if (!frame) loop();
    },
    disable: stop,
    getPlaybackRate: () => ({ playbackRate: rate }),
    setPlaybackRate: ({ playbackRate }: Protocol.Animation.SetPlaybackRateRequest) => setRate(playbackRate),
    getCurrentTime: ({ id }: Protocol.Animation.GetCurrentTimeRequest) => ({ currentTime: current(find(id)) }),
    setPaused: ({ animations, paused }: Protocol.Animation.SetPausedRequest) => {
      const list = animations.map(find);
      for (const t of list) {
        quietly(t, () => {
          if (paused) t.animation.pause();
          else if (t.animation.playState === 'paused') t.animation.play();
        });
        wake(t);
      }
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
        wake(t);
      }
    },
    setTiming: ({ animationId, duration, delay }: Protocol.Animation.SetTimingRequest) => {
      const t = find(animationId);
      quietly(t, () => t.animation.effect?.updateTiming({ duration, delay }));
      wake(t);
    },
    releaseAnimations: ({ animations }: Protocol.Animation.ReleaseAnimationsRequest) => {
      for (const id of animations) {
        const t = awake.get(id) ?? asleep.get(id)?.deref();
        if (!t) continue;
        t.released = true;
        sleep(t);
      }
    },
    resolveAnimation: ({ animationId }: Protocol.Animation.ResolveAnimationRequest) => ({
      remoteObject: ctx.objects.wrap(find(animationId).animation),
    }),
  });
}
