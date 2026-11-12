// matchMedia() while DevTools emulates media (Emulation.setEmulatedMedia). The page's media queries
// are rewritten as the emulated style sheets are (domains/emulation/media.ts), so each query list
// reports what Chrome's emulation reports. A list is the browser's own, with its `media`; its
// `matches` and its change events follow a shadow list, which the browser makes for the rewritten
// query. The windows hooked share one state.
//
// What the hooks cannot do (docs/limitations.md, "Emulated media"): the change events the emulation
// makes are dispatched by script, so their `isTrusted` is false, where the browser's are trusted; they
// are dispatched in an animation frame callback, the next frame after the emulation changed, where
// the browser dispatches its own before that frame's callbacks; and a list the page made before the
// hooks were in place (before the probe ran or, in a same-origin iframe, before its load event) is
// not known to them, so it keeps the browser's own result and events.
import { onAbort } from './natives';
import type { Realm } from './network';
import type { TopNatives } from './types';

/** Rewrites the text of a media query list. */
export type MediaRewrite = (text: string) => string;

/** The browser's own functions of one window, taken before the page's code runs in it. */
export interface MediaNatives {
  win: Realm;
  match: Realm['matchMedia'];
  matches: (this: MediaQueryList) => boolean;
  media: (this: MediaQueryList) => string;
  dispatch: (this: EventTarget, event: Event) => boolean;
  stop: (this: Event) => void;
  listEvent: typeof MediaQueryListEvent;
}

/** A list's shadow: the list of the rewritten query, and the listener that forwards its changes. */
interface Shadow {
  list: MediaQueryList;
  forward: () => void;
}

/** A listener counted: what takes away the listeners the probe added with it, and the signal it was added with. */
interface Counted {
  off: () => void;
  signal?: unknown;
}

interface Rec {
  /** The query as the browser gives it. */
  text: string;
  natives: MediaNatives;
  /**
   * The page's change listeners of the list that are still there, by listener (the onchange handler
   * by ONCHANGE): under 1 for one that bubbles, under 2 for one that captures (see Counted and
   * add). While there are any, the guard and the shadow's
   * forwarder are listeners too; with none, they are not, and the list can be collected.
   */
  listeners: Map<object, Partial<Record<number, Counted>>>;
  /** Set while the rewrite changes the query. */
  shadow: Shadow | null;
  /**
   * The result the page has: the one its listeners were last told, or, from the first listener on, the one
   * it saw then (before a change, with none). Only flush reads it, and only while there are listeners.
   */
  reported: boolean;
}

/** The onchange handler of a list, counted as a listener: the browser replaces the handler, one listener. */
const ONCHANGE = {};

const isObject = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

/** Whether `signal` is a signal that is aborted. What is not a signal is the browser's to refuse, with its own message. */
function isAborted(signal: unknown): boolean {
  try {
    return isObject(signal) && Reflect.get(signal, 'aborted') === true;
  } catch {
    return false;
  }
}

/**
 * The options of addEventListener (`adding`) or removeEventListener, as the browser converts them (WebIDL): whether the
 * listener captures, whether the browser removes it once it has run (`once`), the signal that removes it, and the
 * options the browser is given in their place. An object's members are read once each, in
 * WebIDL's order, so the page's getters run here and not again in the browser (or in the probe's own listener wrapper,
 * which is given the same options); a value that is not an object is given as the boolean it converts to.
 */
function optionsOf(
  options: unknown,
  adding: boolean
): { capture: boolean; given: unknown; once?: boolean; signal?: unknown } {
  if (!isObject(options)) {
    const capture = !!options;
    return { capture, given: capture };
  }
  const capture = !!Reflect.get(options, 'capture');
  if (!adding) return { capture, given: { capture } };
  const once = !!Reflect.get(options, 'once');
  const passive = Reflect.get(options, 'passive');
  const signal = Reflect.get(options, 'signal');
  return {
    capture,
    once,
    signal,
    given: { capture, once, passive: passive === undefined ? undefined : !!passive, signal },
  };
}

/**
 * The apply trap of a hooked addEventListener (`adding`) or removeEventListener: the arguments are converted as the browser
 * converts them, the type once, as a string, and the options as optionsOf gives them, and a `change` listener is counted by
 * `state`. Fewer than two arguments are the browser's to refuse, so they go on unconverted. The trap calls the browser's
 * function itself, so that an error shows the trap and the probe's own listener wrapper, and no frame of its own.
 */
const listenerTrap =
  <F extends Function>(state: MediaState, adding: boolean) =>
  (f: F, self: unknown, args: unknown[]): unknown => {
    if (args.length < 2) return Reflect.apply(f, self, args);
    let type: string;
    try {
      type = `${args[0]}`;
    } catch {
      // A type that does not convert is refused by the browser, with its own message: the call goes on as it was made.
      return Reflect.apply(f, self, args);
    }
    const { capture, given, once, signal } = optionsOf(args[2], adding);
    if (type !== 'change') return Reflect.apply(f, self, [type, args[1], given]);
    const call = () => Reflect.apply(f, self, [type, args[1], given]);
    const mql = self as MediaQueryList;
    return adding ? state.add(mql, args[1], capture, call, once, signal) : state.remove(mql, args[1], capture, call);
  };

/** The state the hooks of every window share. */
export interface MediaState {
  set(rewrite: MediaRewrite | null): void;
  keep(mql: MediaQueryList, natives: MediaNatives): void;
  /**
   * Runs `call`, which adds `listener` (ONCHANGE for the onchange handler) to `mql`, and counts it: until the page
   * removes it, or the browser does, after its first event with `once`, or when `signal` is aborted.
   */
  add(
    mql: MediaQueryList,
    listener: unknown,
    capture: boolean,
    call: () => unknown,
    once?: boolean,
    signal?: unknown
  ): unknown;
  /** Runs `call`, which removes `listener` from `mql`, and uncounts it. */
  remove(mql: MediaQueryList, listener: unknown, capture: boolean, call: () => unknown): unknown;
  shadowOf(mql: MediaQueryList): MediaQueryList | null;
}

export function mediaState({ listen, unlisten, raf }: TopNatives): MediaState {
  const recs = new WeakMap<MediaQueryList, Rec>();
  // Held weakly, and pruned as the array grows past `limit`.
  let kept: WeakRef<MediaQueryList>[] = [];
  let limit = 256;
  let rewrite: MediaRewrite | null = null;
  // The lists the rewrite touched since the last frame (see set): flush reports their changes in that frame.
  let pending = new Set<MediaQueryList>();
  let scheduled = false;

  const shownOf = (mql: MediaQueryList, rec: Rec) => Reflect.apply(rec.natives.matches, rec.shadow?.list ?? mql, []);

  // The browser calls a list's listeners in the order they were added, whatever their capture flag, so
  // the guard is added before the page's first listener (see add). A list with a shadow gets its own
  // change events from the browser too: those are not the page's, so they are stopped here. A list
  // without one has its changes from the browser passed on, and they tell the page its result. Events a
  // script dispatches are not trusted, as ours are, and pass.
  function guard(this: MediaQueryList, event: Event) {
    const rec = recs.get(this);
    if (!rec || !event.isTrusted) return;
    if (rec.shadow) Reflect.apply(rec.natives.stop, event, []);
    else rec.reported = shownOf(this, rec);
  }

  // The guard and the forwarder are listeners of the list while the page has some (see Rec): a listener
  // keeps its list alive in the browser, so they are taken off when the last one goes. The page's result
  // is what it sees as it starts to listen, unless a change is pending (flush decides that one).
  function open(mql: MediaQueryList, rec: Rec) {
    Reflect.apply(listen, mql, ['change', guard, true]);
    if (rec.shadow) Reflect.apply(listen, rec.shadow.list, ['change', rec.shadow.forward]);
    if (!pending.has(mql)) rec.reported = shownOf(mql, rec);
  }

  function close(mql: MediaQueryList, rec: Rec) {
    Reflect.apply(unlisten, mql, ['change', guard, true]);
    if (rec.shadow) Reflect.apply(unlisten, rec.shadow.list, ['change', rec.shadow.forward]);
  }

  // Uncounts the listener `listener` of the list that `bit` names (1 bubbles, 2 captures), which the page or the
  // browser removed, with what the probe added for it; with none left, the guard and the forwarder go too.
  function drop(mql: MediaQueryList, rec: Rec, listener: object, bit: number) {
    const offs = rec.listeners.get(listener);
    const counted = offs?.[bit];
    if (!offs || !counted) return;
    counted.off();
    delete offs[bit];
    if (!offs[3 - bit]) rec.listeners.delete(listener);
    if (rec.listeners.size === 0) close(mql, rec);
  }

  function attach(rec: Rec, mql: MediaQueryList) {
    if (!rewrite) return;
    const text = rewrite(rec.text);
    if (text === rec.text) return;
    const { natives } = rec;
    const list = Reflect.apply(natives.match, natives.win, [text]);
    // Held weakly: the shadow stays alive while it listens, and must not keep the page's list.
    const ref = new WeakRef(mql);
    const forward = () => {
      const real = ref.deref();
      const r = real && recs.get(real);
      if (!real || !r || r.shadow?.list !== list) return;
      // The rewrite changed this list since the last frame: flush reports it, once, against what the page has.
      if (pending.has(real)) return;
      r.reported = Reflect.apply(natives.matches, list, []);
      emit(real, r, r.reported);
    };
    rec.shadow = { list, forward };
    if (rec.listeners.size) Reflect.apply(listen, list, ['change', forward]);
  }

  function detach(rec: Rec) {
    const shadow = rec.shadow;
    if (!shadow) return;
    Reflect.apply(unlisten, shadow.list, ['change', shadow.forward]);
    rec.shadow = null;
  }

  function emit(mql: MediaQueryList, rec: Rec, matches: boolean) {
    Reflect.apply(rec.natives.dispatch, mql, [new rec.natives.listEvent('change', { media: rec.text, matches })]);
  }

  function flush() {
    const due = pending;
    pending = new Set();
    scheduled = false;
    for (const mql of due) {
      const rec = recs.get(mql);
      if (!rec || rec.listeners.size === 0) continue;
      const now = shownOf(mql, rec);
      if (now !== rec.reported) {
        rec.reported = now;
        emit(mql, rec, now);
      }
    }
  }

  return {
    set(next) {
      rewrite = next;
      for (const ref of kept) {
        const mql = ref.deref();
        const rec = mql && recs.get(mql);
        if (!mql || !rec) continue;
        const had = rec.shadow !== null;
        const shown = shownOf(mql, rec);
        detach(rec);
        attach(rec, mql);
        // A list the rewrite touches neither before nor after is the browser's alone: it reports its changes.
        if (!had && !rec.shadow) continue;
        if (!pending.has(mql)) {
          // With no listener, the page has the result from before the change (nothing else has told it).
          if (rec.listeners.size === 0) rec.reported = shown;
          pending.add(mql);
        }
      }
      if (pending.size && !scheduled) {
        scheduled = true;
        Reflect.apply(raf, globalThis, [flush]);
      }
    },
    keep(mql, natives) {
      const rec: Rec = {
        text: Reflect.apply(natives.media, mql, []),
        natives,
        listeners: new Map(),
        shadow: null,
        reported: false,
      };
      recs.set(mql, rec);
      if (kept.length >= limit) {
        kept = kept.filter(ref => ref.deref() !== undefined);
        limit = Math.max(256, 2 * kept.length);
      }
      kept.push(new WeakRef(mql));
      attach(rec, mql);
    },
    add(mql, listener, capture, call, once, signal) {
      const rec = recs.get(mql);
      // With a signal aborted already, the browser adds no listener.
      if (!rec || !isObject(listener) || isAborted(signal)) return call();
      const bit = capture ? 2 : 1;
      // A listener counted whose signal is aborted is one the browser has removed: the page's own listeners of
      // that signal run before the probe hears of the abort, and one of them may add the listener again here.
      if (isAborted(rec.listeners.get(listener)?.[bit]?.signal)) drop(mql, rec, listener, bit);
      const offs = rec.listeners.get(listener) ?? {};
      // A listener the list has already is not added again, and keeps the options it was added with.
      const known = offs[bit];
      // The guard goes in first: before the page's first listener, and as the first one again after none.
      const first = rec.listeners.size === 0;
      if (first) open(mql, rec);
      const gone = () => drop(mql, rec, listener, bit);
      // A listener the browser removes after its first event is uncounted by a listener of the probe's own,
      // removed the same way and added just before it: where this one runs, that one runs next.
      if (!known && once) Reflect.apply(listen, mql, ['change', gone, { capture, once }]);
      let result: unknown;
      try {
        result = call();
      } catch (error) {
        Reflect.apply(unlisten, mql, ['change', gone, capture]);
        if (first) close(mql, rec);
        throw error;
      }
      if (!known) {
        // The browser took the signal, so it is one: its abort removes the listener, and uncounts it.
        const offAbort = isObject(signal) ? onAbort(listen, unlisten, signal as AbortSignal, gone) : undefined;
        offs[bit] = {
          off: () => {
            Reflect.apply(unlisten, mql, ['change', gone, capture]);
            offAbort?.();
          },
          signal,
        };
        rec.listeners.set(listener, offs);
      }
      return result;
    },
    remove(mql, listener, capture, call) {
      const rec = recs.get(mql);
      if (!rec || !isObject(listener)) return call();
      const result = call();
      drop(mql, rec, listener, capture ? 2 : 1);
      return result;
    },
    shadowOf: mql => recs.get(mql)?.shadow?.list ?? null,
  };
}

/** What Function.prototype.toString gives for the hooks: the browser's own functions' text. */
const printed = new WeakMap<object, string>();

/**
 * Hooks `w`'s matchMedia(), the `matches` getter of its MediaQueryList, the ways of adding and removing
 * a listener of one (addEventListener, addListener, onchange, removeEventListener, removeListener) and
 * Function.prototype.toString, for `state`. The hooks are proxies of the functions they replace: they have
 * their name and length, and their text, which `printed` gives to Function.prototype.toString. Those are the
 * browser's, except for the top window's addEventListener and removeEventListener, which are the probe's own
 * listener wrapper by then (index.ts): no name, a length of 3 where the browser's is 2, and the wrapper's source
 * as their text. An error thrown through a hook has the browser's message, but a stack with frames of this
 * bundle that the browser's stack does not have (docs/limitations.md, "Errors").
 */
export function hookMedia(w: Realm, state: MediaState): void {
  const proto = w.MediaQueryList.prototype;
  const match = w.matchMedia;
  const matches = Object.getOwnPropertyDescriptor(proto, 'matches');
  const media = Object.getOwnPropertyDescriptor(proto, 'media')?.get;
  // Browsers without WeakRef (before Chrome 84) keep matchMedia as it is: the hooks would throw in it.
  if (typeof WeakRef !== 'function' || !match || !matches?.get || !media) return;
  const toText = w.Function.prototype.toString;
  const natives: MediaNatives = {
    win: w,
    match,
    matches: matches.get,
    media,
    dispatch: w.EventTarget.prototype.dispatchEvent,
    stop: w.Event.prototype.stopImmediatePropagation,
    listEvent: w.MediaQueryListEvent,
  };
  const hide = <F extends Function>(target: F, handler: ProxyHandler<F>): F => {
    const proxy = new Proxy(target, handler);
    printed.set(proxy, Reflect.apply(toText, target, []));
    return proxy;
  };
  w.Function.prototype.toString = hide(toText, {
    apply: (f, self, args) => printed.get(self) ?? Reflect.apply(f, self, args),
  });
  w.matchMedia = hide(match, {
    apply: (f, self, args) => {
      const mql: MediaQueryList = Reflect.apply(f, self, args);
      state.keep(mql, natives);
      return mql;
    },
  });
  Object.defineProperty(proto, 'matches', {
    ...matches,
    get: hide(matches.get, {
      apply: (f, self, args) => Reflect.apply(f, state.shadowOf(self) ?? self, args),
    }),
  });
  proto.addListener = hide(proto.addListener, {
    apply: (f, self, args) => state.add(self, args[0], false, () => Reflect.apply(f, self, args)),
  });
  proto.removeListener = hide(proto.removeListener, {
    apply: (f, self, args) => state.remove(self, args[0], false, () => Reflect.apply(f, self, args)),
  });
  const onchange = Object.getOwnPropertyDescriptor(proto, 'onchange');
  if (onchange?.set) {
    Object.defineProperty(proto, 'onchange', {
      ...onchange,
      set: hide(onchange.set, {
        apply: (f, self, args) => {
          const call = () => Reflect.apply(f, self, args);
          return isObject(args[0]) ? state.add(self, ONCHANGE, false, call) : state.remove(self, ONCHANGE, false, call);
        },
      }),
    });
  }
  const add = w.EventTarget.prototype.addEventListener;
  const remove = w.EventTarget.prototype.removeEventListener;
  w.EventTarget.prototype.addEventListener = hide(add, { apply: listenerTrap<typeof add>(state, true) });
  w.EventTarget.prototype.removeEventListener = hide(remove, { apply: listenerTrap<typeof remove>(state, false) });
}
