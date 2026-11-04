import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import type { Inspectable, PseudoType } from '../../core/nodes';
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
}

/** The animation's type and name, as Chrome names them. */
function kindOf(animation: Animation): [Protocol.Animation.Animation['type'], string] {
  if (typeof CSSAnimation === 'function' && animation instanceof CSSAnimation)
    return ['CSSAnimation', animation.animationName];
  if (typeof CSSTransition === 'function' && animation instanceof CSSTransition)
    return ['CSSTransition', animation.transitionProperty];
  return ['WebAnimation', animation.id];
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
 * finishing it, or playing it again once finished), not when the page pauses it, nor for what the
 * domain's own commands change. Null while paused or pending, which is no update.
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
    if (effect instanceof KeyframeEffect) {
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
          keyframes: effect.getKeyframes().map(k => ({
            offset: percent(k.computedOffset),
            easing: k.easing ?? 'linear',
          })),
        };
      }
      result.source = source;
    }
    return result;
  };

  const documents = () => Array.from(ctx.frames, f => f.document);

  /** Announces new animations, and changes the page made to the ones announced. */
  const scan = () => {
    for (const doc of documents()) {
      let animations: Animation[];
      try {
        animations = doc.getAnimations();
      } catch {
        continue;
      }
      for (const animation of animations) {
        if (released.has(animation)) continue;
        let t = tracked.get(animation);
        if (!t) {
          t = { id: String(++seq), animation, started: false, rate: animation.playbackRate, start: null };
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
    if (rate !== 1) setRate(1);
    byId.clear();
    tracked = new WeakMap();
    released.clear();
  };
  session.onReset(stop);

  session.register('Animation', {
    enable: () => {
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
    seekAnimations: ({ animations, currentTime }: Protocol.Animation.SeekAnimationsRequest) => {
      const list = animations.map(find);
      for (const t of list) quietly(t, () => (t.animation.currentTime = currentTime ?? 0));
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
