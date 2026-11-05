import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { type Inspectable, type PseudoType } from '../../core/nodes';
import { isElement, isNode, realmOf, styleOf } from '../../core/realm';
import { CdpError } from '../../core/session';

const NOT_FOUND = 'Could not find animation with given id';

/** What a tracked animation looked like when last reported, to tell when the page changed it. */
interface Tracked {
  id: string;
  animation: Animation;
  /** Whether `animationStarted` was sent: an animation is announced once it is no longer pending. */
  started: boolean;
  /** Its own playback rate, as the page set it, before the domain's rate (`setPlaybackRate`) is applied. */
  rate: number;
  /** `playbackRate` as last written or seen: another value is the page's doing. */
  seen: number;
  /** The start time last reported. */
  start: number | null;
  /** Frames to wait before reporting a seek's new start time (see `seekAnimations`). */
  hold: number;
  /**
   * The state, paused or idle, last reported with `animationCanceled` (or the one it was first seen
   * in): Chrome reports one on every change of the play state to paused or idle (measured: the page
   * or the panel pausing it, the page cancelling it, pausing a finished or an idle one, cancelling a
   * paused one), none while it stays so. Null while it runs or is finished.
   */
  canceled: 'paused' | 'idle' | null;
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
 * A time as a number: a scroll-driven animation's times and durations are `CSSUnitValue`s, in
 * percent of its timeline, whose value Chrome reports as is (or null, as `currentTime` of one whose
 * timeline is inactive).
 */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return value;
  const inner: unknown = typeof value === 'object' && value ? Reflect.get(value, 'value') : null;
  return typeof inner === 'number' ? inner : null;
}

/**
 * Blink's time unit of a scroll timeline, `kScrollTimelineMicrosecondsPerPixel`: Chrome reports a
 * scroll-driven animation's current time, and takes a seek, in milliseconds of 16µs per pixel of
 * the timeline's range (measured: 500px into a 2400px range is 8). Its start time and the effect's
 * timing stay in percent.
 */
const MS_PER_PX = 0.016;

/** Whether a scroll or view timeline drives it: cheap, for every frame. */
const scrollDriven = (animation: Animation) =>
  !!animation.timeline && typeof Reflect.get(animation.timeline, 'axis') === 'string';

/**
 * The scroll or view timeline driving an animation, as Chrome reports it; undefined for any other
 * timeline. The offsets are the scroll positions the timeline runs between: the scroll range for a
 * scroll timeline, its subject's cover range for a view timeline (`animation-range` is left to the
 * start time and duration, as in Chrome).
 */
function timelineOf(ctx: Context, animation: Animation): Protocol.Animation.ViewOrScrollTimeline | undefined {
  const timeline = animation.timeline;
  if (!timeline) return undefined;
  const source: unknown = Reflect.get(timeline, 'source');
  const axis: unknown = Reflect.get(timeline, 'axis');
  if (!isNode(source) || !isElement(source) || typeof axis !== 'string') return undefined;
  // The root scroller (`scroll(root)`) is `document.scrollingElement`, whose client size is the
  // viewport's: its range is the document's beyond the viewport (measured: 3000px in a 600px
  // viewport is 2400, as in Chrome). In quirks mode that element is the body, whose client size is
  // the viewport's too (measured in the page); what Chrome reports for it is not measured.
  // `block` and `inline` follow the scroller's writing mode.
  const lines = styleOf(source).writingMode.startsWith('horizontal');
  const horizontal = axis === 'x' || (axis !== 'y' && (axis === 'inline') === lines);
  const result: Protocol.Animation.ViewOrScrollTimeline = {
    // Chrome names the document for the root scroller (measured), as the panel scrolls it.
    sourceNodeId: ctx.nodes.backendIdOf(
      source === source.ownerDocument.scrollingElement ? source.ownerDocument : source
    ),
    startOffset: 0,
    endOffset: horizontal ? source.scrollWidth - source.clientWidth : source.scrollHeight - source.clientHeight,
    axis: horizontal ? 'horizontal' : 'vertical',
  };
  const subject: unknown = Reflect.get(timeline, 'subject');
  if (isNode(subject)) {
    result.startOffset = numberOf(Reflect.get(timeline, 'startOffset')) ?? 0;
    result.endOffset = numberOf(Reflect.get(timeline, 'endOffset')) ?? 0;
    result.subjectNodeId = ctx.nodes.backendIdOf(subject);
  }
  return result;
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
 * What a disable left of an animation pending then (see `stop`), across sessions: the page's own
 * rate, and the `playbackRate` last seen. A session enabled again before it is restored takes the
 * own rate from here, not the slowed `playbackRate`; one enabled after the page changed the rate
 * meanwhile compares with `seen` and reports the change, as Chrome does with an update.
 */
/** Whether it is paused (pending a pause too) or idle, the states Chrome reports with a cancel. */
function pausedOrIdle(animation: Animation): 'paused' | 'idle' | null {
  const state = animation.playState;
  return state === 'paused' || state === 'idle' ? state : null;
}

const owed = new WeakMap<Animation, { own: number; seen: number }>();

/**
 * Animation: the Animations panel, from `getAnimations()` of each document in the page, which has
 * the CSS animations and transitions and those of the Web Animations API. The page has no event for
 * an animation starting, so the documents are looked at on every frame while the domain is enabled.
 * The probe tells of those made with `animate()` or `new Animation()` too, which getAnimations()
 * misses when they have no target, one out of the document, or end before the next frame.
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
   * The finished, cancelled and released ones, kept only while the page keeps them: a page that runs
   * for long makes and drops animations without end. Still found by id, as in Chrome, and woken when
   * the page plays them again (back in `getAnimations()`, or through the probe's `play()` hook).
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
  let stopAnimations: (() => void) | null = null;

  /** The current time Chrome reports: in its scroll-timeline milliseconds for a scroll-driven one. */
  const current = (t: Tracked, timeline = timelineOf(ctx, t.animation)) => {
    const value = numberOf(t.animation.currentTime) ?? 0;
    return timeline ? (value / 100) * ((timeline.endOffset ?? 0) - (timeline.startOffset ?? 0)) * MS_PER_PX : value;
  };

  /**
   * What `getCurrentTime` answers, as Chrome does (measured): null for an idle one, though the
   * protocol has a number; for one that runs or is finished, the time of its timeline since its
   * start time, which goes on past the end (400 for a finished animation of 100ms started 400ms
   * ago) and leaves out its own rate (-4683 where the page reads 9366 at a rate of -2), the
   * documents' rate (the domain's, here on the animation) in. A paused one's current time, and a
   * scroll-driven one's (see `current`), as reported in its events.
   */
  const timeOf = (t: Tracked): number | null => {
    const { animation } = t;
    if (animation.playState === 'idle') return null;
    const start = startOf(animation);
    const now = animation.timeline?.currentTime;
    if (animation.playState === 'paused' || start === null || typeof now !== 'number' || scrollDriven(animation))
      return current(t);
    return (now - start) * rate;
  };

  const describe = (t: Tracked): Protocol.Animation.Animation => {
    const { animation } = t;
    const realm = realmOfAnimation(animation);
    const [type, name] = kindOf(animation, realm);
    const timeline = timelineOf(ctx, animation);
    const result: Protocol.Animation.Animation = {
      id: t.id,
      name,
      pausedState: animation.playState === 'paused',
      playState: animation.playState,
      playbackRate: t.rate,
      startTime: numberOf(animation.startTime) ?? 0,
      // Chrome's `animationStarted` has the current time when the start time is set: about 0 (0 for
      // a CSS animation of the top document, -0.09 for a delayed Web Animation, a frame, 16.7, in
      // an iframe), not always 0. The page is looked at a frame later, so ours is a frame on. Left
      // so: it is the animation's real time, and faking 0 would be wrong for one running before enable.
      currentTime: current(t, timeline),
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
        delay: numberOf(timing.delay) ?? 0,
        endDelay: numberOf(timing.endDelay) ?? 0,
        iterationStart: timing.iterationStart ?? 0,
        duration: numberOf(timing.duration) ?? 0,
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
    if (timeline) result.viewOrScrollTimeline = timeline;
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

  /**
   * Starts tracking an animation, or wakes one the page plays again or cancels: any the probe tells
   * of, which the next frame lets sleep again if it has still ended. Without the probe's hooks (an
   * older probe), a finished one cancelled, or one out of getAnimations() played again, goes unseen.
   */
  const track = (animation: Animation, told = false) => {
    const known = tracked.get(animation);
    // Cancelled or paused before it started, Chrome reports a start (running, at 0) before the
    // cancel only when a frame's animation update ran since the animation was made; one cancelled
    // in the page's rAF callbacks of that frame gets none (measured, both timed in the page with
    // performance.now()). None is sent here: our frame loop is a rAF callback of the same frame as
    // the page's, and ahead of them, so seeing the animation there does not tell a cancel in the
    // page's callbacks from one in a later task. Telling them apart would need the probe to wrap
    // the page's requestAnimationFrame, for this one event. So where a frame came before a timer
    // that cancels it, Chrome sends a start that is missing here.
    if (known) {
      // Finished ones with `fill: forwards` stay in getAnimations(): only one that runs again wakes.
      if (told || (animation.playState !== 'finished' && animation.playState !== 'idle')) wake(known);
      return;
    }
    const t: Tracked = {
      id: String(++seq),
      animation,
      started: false,
      rate: owed.get(animation)?.own ?? animation.playbackRate,
      seen: 0,
      start: null,
      hold: 0,
      // Chrome reports a cancel on the change to idle or paused: one made idle (`new Animation()`)
      // never had it, nor one already paused when first seen.
      canceled: pausedOrIdle(animation),
      released: false,
    };
    tracked.set(animation, t);
    collected.register(t, t.id);
    awake.set(t.id, t);
    // The slowed rate a disable left is no change of the page's; one the page set since is.
    t.seen = owed.get(animation)?.seen ?? animation.playbackRate;
    owed.delete(animation);
    syncRate(t);
    session.emit('Animation.animationCreated', { id: t.id });
  };

  /**
   * Takes a playback rate other than the one last written or seen as the page's, and applies the
   * domain's to it; whether the page changed it. `reverse()` negates the rate it reads, the
   * domain's included; any other value is one the page set (one equal to the negated rate is taken
   * for `reverse()` as well).
   *
   * Not while pending: a rate the page set with `reverse()` or `updatePlaybackRate()` is pending
   * until the animation is ready, `playbackRate` still reads the old one, and writing it would drop
   * the page's. The domain's rate is applied once the animation is ready, a frame late at most.
   */
  const syncRate = (t: Tracked): boolean => {
    const { animation } = t;
    if (animation.pending) return false;
    const now = animation.playbackRate;
    const changed = now !== t.seen;
    if (changed) t.rate = now === -t.seen ? -t.rate : now;
    // The domain's rate is that of the documents' timelines in Chrome: a scroll-driven animation
    // keeps its own (measured: its playbackRate stays 1 at a panel rate of 0.5).
    const wanted = scrollDriven(animation) ? t.rate : t.rate * rate;
    if (now !== wanted) {
      // The start time this moves is the domain's doing, not the page's.
      const known = startOf(animation) === t.start;
      animation.playbackRate = wanted;
      if (known) t.start = startOf(animation) ?? t.start;
    }
    t.seen = animation.playbackRate;
    return changed;
  };

  /** Reports what the page changed: the start (Chrome's `animationStarted`), the start time, the rate. */
  /** Whether an update was sent. */
  const check = (t: Tracked): boolean => {
    const { animation } = t;
    const rated = syncRate(t);
    if (t.released) return false;
    if (!t.started) {
      // Chrome announces no start of one paused before it started (measured).
      if (animation.pending || pausedOrIdle(animation)) return false;
      t.started = true;
      t.start = startOf(animation);
      session.emit('Animation.animationStarted', { animation: describe(t) });
      // A rate the page set while it was pending, taken over from a disable (see `owed`): Chrome
      // reports it with an update after the start.
      if (rated) session.emit('Animation.animationUpdated', { animation: describe(t) });
      return rated;
    }
    if (t.hold > 0) {
      t.hold--;
      return false;
    }
    // A paused one's start time is the pause's doing (or the page's in the task that paused it),
    // which Chrome reports with the cancel alone (measured).
    if (animation.playState === 'paused') return false;
    const start = startOf(animation);
    if ((start !== null && start !== t.start) || rated) {
      t.start = start ?? t.start;
      session.emit('Animation.animationUpdated', { animation: describe(t) });
      return true;
    }
    return false;
  };

  /**
   * Reports a change to paused or idle as Chrome does, with a cancel (even before the start), and
   * lets ended ones sleep. The panel keeps showing a paused one: its model only drops the id from
   * the ones waiting to be grouped.
   */
  const settle = (t: Tracked) => {
    const state = pausedOrIdle(t.animation);
    if (state !== t.canceled) {
      t.canceled = state;
      if (state === 'idle') t.start = null;
      if (state && !t.released) session.emit('Animation.animationCanceled', { id: t.id });
    }
    if (t.animation.playState === 'idle' || t.animation.playState === 'finished') sleep(t);
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
   * Runs `change` and takes what it did as known, so it is not reported as the page's. What the page
   * changed before, in the same frame, is reported first. The start time of an animation `change`
   * left pending is not known yet: Chrome reports it once it is, and so does the next frame here.
   */
  const quietly = (t: Tracked, change: () => void) => {
    const updated = check(t);
    change();
    t.start = startOf(t.animation) ?? t.start;
    t.seen = t.animation.playbackRate;
    return updated;
  };

  const setRate = (value: number) => {
    const list = all();
    // What the page changed is the page's under the old rate.
    list.forEach(check);
    rate = value;
    for (const t of list) syncRate(t);
  };

  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    stopShadowRoots?.();
    stopShadowRoots = null;
    stopAnimations?.();
    stopAnimations = null;
    // Every animation slowed down gets its own rate back: cancelled and released ones too, and
    // pending ones once they are ready (or cancelled), not to drop a rate the page set meanwhile.
    // The rate to restore is fixed now: by the time a pending one is ready the domain may be enabled
    // again with another rate, and tracking it anew. The page's change meanwhile is kept (its
    // reverse() negated). One pending for good (its timeline inactive) keeps the panel's rate.
    rate = 1;
    for (const t of all()) {
      const { animation } = t;
      if (!animation.pending) {
        syncRate(t);
        continue;
      }
      const { rate: own, seen } = t;
      owed.set(animation, { own, seen });
      const restore = () => {
        // Pending again (the page played or changed its rate meanwhile): writing now would drop it.
        if (animation.pending) {
          animation.ready.then(restore, restore);
          return;
        }
        // Taken by a session enabled since, which writes the rate itself: no longer `seen`. A rate
        // the page set meanwhile is kept, and stays owed for the next session to report.
        const now = animation.playbackRate;
        if (now !== seen && now !== -seen) return;
        owed.delete(animation);
        animation.playbackRate = now === seen ? own : -own;
      };
      animation.ready.then(restore, restore);
    }
    awake.clear();
    asleep.clear();
    tracked = new WeakMap();
  };
  session.onReset(stop);

  session.register('Animation', {
    enable: () => {
      stopShadowRoots ??= ctx.shadowRoots.acquire();
      stopAnimations ??= ctx.probe.onAnimation(animation => track(animation, true));
      if (!frame) loop();
    },
    disable: stop,
    getPlaybackRate: () => ({ playbackRate: rate }),
    setPlaybackRate: ({ playbackRate }: Protocol.Animation.SetPlaybackRateRequest) => setRate(playbackRate),
    getCurrentTime: ({ id }: Protocol.Animation.GetCurrentTimeRequest) => ({ currentTime: timeOf(find(id)) }),
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
      // As in Chrome, one not paused is played first (a finished or cancelled one starts over), and
      // the time stops at the end of the effect; a negative one is kept.
      // A scroll-driven one follows its scroller while it runs: Chrome leaves it be (its seek throws
      // inside and is ignored), and moves a paused one, taking the time in its scroll-timeline
      // milliseconds (see `MS_PER_PX`). What the page throws for one animation (`play()` of one
      // that cannot be played) is ignored, as Chrome ignores it, so the others are still seeked.
      for (const [i, t] of list.entries()) {
        const { animation } = t;
        check(t);
        const time = currentTimes?.[i] ?? currentTime ?? 0;
        const end = numberOf(animation.effect?.getComputedTiming().endTime);
        const timeline = timelineOf(ctx, animation);
        let value: CSSNumberish | null = null;
        if (!timeline) value = end === null ? time : Math.min(time, end);
        else if (animation.playState === 'paused') {
          const range = (timeline.endOffset ?? 0) - (timeline.startOffset ?? 0);
          const percent = range > 0 ? (time / MS_PER_PX / range) * 100 : 0;
          value = CSS.percent(end === null ? percent : Math.min(percent, end));
        }
        // Only the page's own calls: they throw a DOMException (or a TypeError) the page decides.
        try {
          if (animation.playState !== 'paused') animation.play();
          if (value !== null) animation.currentTime = value;
        } catch (error) {
          // Of any realm: an iframe's animation throws its window's errors.
          const pageError =
            Object.prototype.toString.call(error) === '[object DOMException]' ||
            (typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'TypeError');
          if (!pageError) throw error;
        }
        t.hold = 2;
        wake(t);
      }
    },
    setTiming: ({ animationId, duration, delay }: Protocol.Animation.SetTimingRequest) => {
      const t = find(animationId);
      const updated = quietly(t, () => t.animation.effect?.updateTiming({ duration, delay }));
      // Chrome reports a scroll-driven one with an update, its timing back in percent (measured),
      // and one only when the page changed its rate in that frame too (measured): the page's
      // change, reported first, stands for it.
      if (!updated && scrollDriven(t.animation)) session.emit('Animation.animationUpdated', { animation: describe(t) });
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
