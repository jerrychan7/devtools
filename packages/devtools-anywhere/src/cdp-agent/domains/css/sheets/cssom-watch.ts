import { isCssom, realmOf } from '../../../core/realm';

/**
 * Notices the page changing style sheets through the CSSOM: the methods that add and remove
 * rules, replace() and replaceSync(), setProperty() and removeProperty(), and the setters of rules
 * and their styles (`rule.style.color = …`, `cssText`, `selectorText`, `keyText`), hooked on the
 * prototypes of each realm while someone watches (like adopted.ts). The hooks are proxies of the
 * native functions: their name, length and that they cannot be constructed stay the same, and
 * `toString()` keeps the native form (without the name). A media list's text (`media.mediaText`)
 * goes unseen: a MediaList does not tell its rule. The CSS domain's own changes are made through
 * `ownEdit`, and not reported.
 */
/** `by`: the CSS domain session that made the change, for one of its own edits. */
type Listener = (sheet: CSSStyleSheet, text?: string, by?: object) => void;
type After = (self: unknown, args: unknown[], result: unknown) => void;

const listeners = new Set<Listener>();
/** The descriptors replaced, by prototype and name, with the function hooked in each. */
const natives = new Map<object, Map<string, { descriptor: PropertyDescriptor; hook: unknown }>>();
let own = 0;

function notify(sheet: CSSStyleSheet | null | undefined, text?: string) {
  if (!sheet || own) return;
  for (const listener of listeners)
    try {
      listener(sheet, text);
    } catch {
      // Ours, not the page's: its call goes on.
    }
}

/** The sheet a CSSOM object (sheet, rule, style) belongs to. */
function sheetOf(target: unknown): CSSStyleSheet | null {
  if (isCssom(target, 'CSSStyleSheet')) return target;
  if (isCssom(target, 'CSSStyleDeclaration')) return target.parentRule ? sheetOf(target.parentRule) : null;
  return typeof target === 'object' && target !== null && 'parentStyleSheet' in target
    ? sheetOf(Reflect.get(target, 'parentStyleSheet'))
    : null;
}

/** Hooks a method, or with `setter`, an accessor's setter, calling `after` past the native one. */
function hook(proto: object, name: string, after: After, setter = false) {
  let hooked = natives.get(proto);
  if (hooked?.has(name)) return;
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  const native: unknown = setter ? descriptor?.set : descriptor?.value;
  if (!descriptor || typeof native !== 'function') return;
  const proxy = new Proxy(native, {
    apply(f, self, args) {
      const result: unknown = Reflect.apply(f, self, args);
      if (listeners.size && !own) after(self, args, result);
      return result;
    },
  });
  if (!hooked) natives.set(proto, (hooked = new Map()));
  hooked.set(name, { descriptor, hook: proxy });
  const next: PropertyDescriptor = { ...descriptor };
  if (setter) next.set = proxy as (value: unknown) => void;
  else next.value = proxy;
  Object.defineProperty(proto, name, next);
}

function install(realm: Window & typeof globalThis) {
  const changed: After = self => notify(sheetOf(self));
  for (const proto of [realm.CSSStyleSheet.prototype, realm.CSSGroupingRule.prototype])
    for (const name of ['insertRule', 'deleteRule', 'addRule', 'removeRule']) hook(proto, name, changed);
  if (realm.CSSKeyframesRule)
    for (const name of ['appendRule', 'deleteRule']) hook(realm.CSSKeyframesRule.prototype, name, changed);
  // An element's own style shares the prototype, and belongs to no sheet: its parent rule, read
  // through the realm's native getter, ends its writes' hooks at once.
  const parentRule = Object.getOwnPropertyDescriptor(realm.CSSStyleDeclaration.prototype, 'parentRule')?.get;
  const styleChanged: After = self => {
    let rule: unknown;
    try {
      rule = parentRule ? Reflect.apply(parentRule, self, []) : null;
    } catch {
      return; // Not a style.
    }
    if (rule) notify(sheetOf(rule));
  };
  for (const name of ['setProperty', 'removeProperty']) hook(realm.CSSStyleDeclaration.prototype, name, styleChanged);
  // A style's setters (in Chrome 157 `cssText` and `cssFloat`: `color` and the like are no
  // accessors, so `el.style.left = …` is not hooked and costs nothing), a rule's selector, a
  // keyframe's key. While watching, an element's `style.cssText = …` costs about 40% more
  // (Chrome 157, 1000 writes: 0.33 ms against 0.24 ms), the proxy's.
  // A style's properties may be on an interface of its own (CSSStyleProperties) above it.
  const styles: object[] = [];
  for (let p: unknown = Object.getPrototypeOf(realm.document.createElement('div').style); ;) {
    if (typeof p !== 'object' || p === null || p === realm.Object.prototype) break;
    styles.push(p);
    p = Object.getPrototypeOf(p);
  }
  for (const proto of styles)
    for (const name of Object.getOwnPropertyNames(proto))
      if (Object.getOwnPropertyDescriptor(proto, name)?.set) hook(proto, name, styleChanged, true);
  for (const proto of [
    realm.CSSStyleRule.prototype,
    realm.CSSKeyframeRule?.prototype,
    realm.CSSKeyframesRule?.prototype,
    realm.CSSPageRule?.prototype,
  ])
    if (proto)
      for (const name of Object.getOwnPropertyNames(proto))
        if (Object.getOwnPropertyDescriptor(proto, name)?.set) hook(proto, name, changed, true);
  const sheetProto = realm.CSSStyleSheet.prototype;
  hook(sheetProto, 'replaceSync', (self, args) => notify(sheetOf(self), String(args[0])));
  hook(sheetProto, 'replace', (self, args, result) => {
    const sheet = sheetOf(self);
    const text = String(args[0]);
    // A promise of the sheet's realm.
    if (typeof result === 'object' && result !== null && 'then' in result)
      void Promise.resolve(result).then(
        () => notify(sheet, text),
        () => {}
      );
  });
}

function uninstall() {
  // A hook the page replaced since is kept (it does nothing without listeners).
  for (const [proto, hooked] of natives)
    for (const [name, { descriptor, hook }] of hooked) {
      const now = Object.getOwnPropertyDescriptor(proto, name);
      if ((descriptor.set ? now?.set : now?.value) !== hook) continue;
      Object.defineProperty(proto, name, descriptor);
      hooked.delete(name);
    }
}

/** Calls `listener` with each sheet the page changes, and the text it replaces one with. */
export function watchCssom(listener: Listener, realms: () => (Window & typeof globalThis)[]): () => void {
  listeners.add(listener);
  realms().forEach(install);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) uninstall();
  };
}

/** Whether some session watches: the page's changes are seen. */
export function watching(): boolean {
  return listeners.size > 0;
}

/** Hooks the realms of documents seen since watching started. */
export function watchRealms(docs: Document[]): void {
  if (listeners.size) for (const doc of docs) install(realmOf(doc));
}

/**
 * Tells every session of an edit session `by` made to a sheet, its text now `text` (undefined:
 * not known), recorded already in the shared store. Unlike Chrome, the others send styleSheetChanged.
 */
export function editedBy(by: object, sheet: CSSStyleSheet, text: string | undefined): void {
  for (const listener of listeners)
    try {
      listener(sheet, text, by);
    } catch {
      // Ours: the edit goes on.
    }
}

/** Runs `fn`, the CSS domain's own change, without reporting it. */
export function ownEdit<T>(fn: () => T): T {
  own++;
  try {
    return fn();
  } finally {
    own--;
  }
}
