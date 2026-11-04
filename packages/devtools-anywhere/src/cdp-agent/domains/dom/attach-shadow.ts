/**
 * Patches `Element.prototype.attachShadow` of each realm it is given (the top page's, each
 * same-origin iframe document's) so that `onAttach` hears of shadow roots as they are attached,
 * while on. Chrome reports the shadow roots of every frame's elements alike.
 */
export function attachShadowHook(onAttach: (host: Element, root: ShadowRoot) => void) {
  /** Each realm's prototype, with the method it had and our wrapper of it. */
  const patched = new Map<Element, { native: Element['attachShadow']; wrapper: Element['attachShadow'] }>();
  let on = false;
  /** Set within an attachShadow call: a wrapper under another of ours does not report it twice. */
  let attaching = false;

  return {
    /** Patches the realm of `win`, if not yet; reports attachments from now on. */
    patch(win: Window & typeof globalThis): void {
      on = true;
      const proto = win.Element.prototype;
      const native = proto.attachShadow;
      if (!native || patched.has(proto)) return;
      const wrapper = function (this: Element, init: ShadowRootInit): ShadowRoot {
        if (attaching) return native.call(this, init);
        attaching = true;
        let root: ShadowRoot;
        try {
          root = native.call(this, init);
        } finally {
          attaching = false;
        }
        if (on) onAttach(this, root);
        return root;
      };
      patched.set(proto, { native, wrapper });
      proto.attachShadow = wrapper;
    },

    /** Restores each realm's method; a wrapper installed on top of ours stays, and ours, silent, with it. */
    unpatch(): void {
      on = false;
      for (const [proto, { native, wrapper }] of patched) {
        if (proto.attachShadow !== wrapper) continue;
        proto.attachShadow = native;
        patched.delete(proto);
      }
    },
  };
}
