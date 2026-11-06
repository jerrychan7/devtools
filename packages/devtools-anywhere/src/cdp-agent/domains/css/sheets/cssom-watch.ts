import { isCssom, realmOf } from '../../../core/realm';

/**
 * Notices the page changing style sheets through the CSSOM: the methods that add and remove
 * rules, replace() and replaceSync(), setProperty() and removeProperty(), the setters of rules
 * and their styles (`cssText`, `selectorText`, `keyText`), and those of a rule's media list
 * (`mediaText`, appendMedium(), deleteMedium()), hooked on the prototypes of each realm while
 * someone watches (like adopted.ts). The hooks are proxies of the native functions: their name,
 * length and that they cannot be constructed stay the same, and `toString()` keeps the native
 * form (without the name). The CSS domain's own changes are made through `ownEdit`, and not
 * reported.
 *
 * A MediaList does not tell its rule: the `media` getters of rules note it (`rule.media` is the
 * same list each time), so a list taken before anyone watched goes unseen, as does the sheet's
 * own (`sheet.media`), which changes no rule.
 *
 * A style's properties by name (`rule.style.color = …`) go unseen: in Chrome they are data
 * properties of each CSSStyleDeclaration itself, no accessors of its prototype.
 */
/**
 * Where in its sheet a change of the page is, for a text serialized from the CSSOM to be changed
 * there alone: the top-level rule whose text is now another (what is in it, or its selector, or
 * its style, changed), or the index of a top-level rule inserted or deleted. None when not known:
 * the text changes everywhere (replace(), replaceSync()), or where is not told.
 */
export type CssomChange =
  | { kind: 'rule'; rule: CSSRule }
  | { kind: 'insert'; index: number }
  | { kind: 'delete'; index: number };

/** `by`: the CSS domain session that made the change, for one of its own edits. */
type Listener = (sheet: CSSStyleSheet, text?: string, by?: object) => void;
type After = (self: unknown, args: unknown[], result: unknown) => void;
/** What of a property is hooked: a method, or an accessor's getter or setter. */
type Part = 'value' | 'get' | 'set';

const listeners = new Set<Listener>();
/** The functions replaced, by prototype and `part:name`, with the one hooked for each. */
const natives = new Map<object, Map<string, { part: Part; name: string; native: unknown; hook: unknown }>>();
let own = 0;

type Recorder = (sheet: CSSStyleSheet, text?: string, change?: CssomChange) => void;

/** Records a change of the page in the texts the sessions share, before they are told. */
let record: Recorder = () => {};

/** Sets what records each change the page makes, once for every session. */
export function recordPageChanges(fn: Recorder): void {
  record = fn;
}

function notify(sheet: CSSStyleSheet | null | undefined, text?: string, change?: CssomChange) {
  if (!sheet || own || !listeners.size) return;
  try {
    record(sheet, text, change);
  } catch {
    // Ours, not the page's: its call goes on.
  }
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

/** The top-level rule a rule is in, or is; null for one no longer in a sheet. */
function topRuleOf(rule: CSSRule): CSSRule | null {
  let top = rule;
  for (let up = top.parentRule; up; up = up.parentRule) top = up;
  return top.parentStyleSheet ? top : null;
}

/** A change of what is in `rule`, or of `rule` itself, at its top-level rule. */
function inRule(rule: unknown): CssomChange | undefined {
  const top = typeof rule === 'object' && rule !== null && 'parentRule' in rule ? topRuleOf(rule as CSSRule) : null;
  return top ? { kind: 'rule', rule: top } : undefined;
}

/** An index argument as Web IDL's `unsigned long` takes it. */
const index = (value: unknown, otherwise: number) => (value === undefined ? otherwise : Number(value) >>> 0);

/**
 * Hooks a method, or with `part`, an accessor's setter or getter, calling `after` past the native
 * one, while some session watches and, but with `always`, outside the CSS domain's own code.
 */
function hook(proto: object, name: string, after: After, part: Part = 'value', always = false) {
  let hooked = natives.get(proto);
  const key = `${part}:${name}`;
  if (hooked?.has(key)) return;
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  const native: unknown = descriptor?.[part];
  if (!descriptor || typeof native !== 'function') return;
  const proxy = new Proxy(native, {
    apply(f, self, args) {
      const result: unknown = Reflect.apply(f, self, args);
      if (listeners.size && (always || !own)) after(self, args, result);
      return result;
    },
  });
  if (!hooked) natives.set(proto, (hooked = new Map()));
  hooked.set(key, { part, name, native, hook: proxy });
  Object.defineProperty(proto, name, { ...descriptor, [part]: proxy });
}

/** The rule each media list belongs to, noted when read (`rule.media`). */
const mediaOwners = new WeakMap<object, CSSRule>();

function install(realm: Window & typeof globalThis) {
  const changed: After = self => notify(sheetOf(self), undefined, inRule(self));
  const sheetProto = realm.CSSStyleSheet.prototype;
  // Where a sheet's method inserted (insertRule's result; addRule's, -1, is none: its index or
  // the end) or deleted, as the browser took the arguments: the call returned, so they were good.
  const sheetLevel = (self: unknown, change: (sheet: CSSStyleSheet) => CssomChange) => {
    const sheet = sheetOf(self);
    if (sheet) notify(sheet, undefined, change(sheet));
  };
  hook(sheetProto, 'insertRule', (self, _args, result) =>
    sheetLevel(self, () => ({ kind: 'insert', index: Number(result) }))
  );
  hook(sheetProto, 'addRule', (self, args) =>
    sheetLevel(self, sheet => ({ kind: 'insert', index: index(args[2], sheet.cssRules.length - 1) }))
  );
  hook(sheetProto, 'deleteRule', (self, args) =>
    sheetLevel(self, () => ({ kind: 'delete', index: index(args[0], 0) }))
  );
  hook(sheetProto, 'removeRule', (self, args) =>
    sheetLevel(self, () => ({ kind: 'delete', index: index(args[0], 0) }))
  );
  // A style rule's nested rules (CSS nesting) are changed through its own methods.
  for (const proto of [realm.CSSGroupingRule.prototype, realm.CSSStyleRule.prototype])
    for (const name of ['insertRule', 'deleteRule']) hook(proto, name, changed);
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
    if (rule) notify(sheetOf(rule), undefined, inRule(rule));
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
      if (Object.getOwnPropertyDescriptor(proto, name)?.set) hook(proto, name, styleChanged, 'set');
  for (const proto of [
    realm.CSSStyleRule.prototype,
    realm.CSSKeyframeRule?.prototype,
    realm.CSSKeyframesRule?.prototype,
    realm.CSSPageRule?.prototype,
  ])
    if (proto)
      for (const name of Object.getOwnPropertyNames(proto))
        if (Object.getOwnPropertyDescriptor(proto, name)?.set) hook(proto, name, changed, 'set');
  // A rule's media list, noted to tell its changes.
  for (const name of Object.getOwnPropertyNames(realm)) {
    if (!/^CSS\w*(Rule|Declarations)$/.test(name)) continue;
    const proto: unknown = (Reflect.get(realm, name) as { prototype?: unknown } | undefined)?.prototype;
    if (typeof proto !== 'object' || proto === null) continue;
    hook(
      proto,
      'media',
      (self, _args, list) => {
        if (typeof list === 'object' && list !== null) mediaOwners.set(list, self as CSSRule);
      },
      'get',
      true
    );
  }
  if (realm.MediaList) {
    const listChanged: After = self => {
      const rule = typeof self === 'object' && self !== null ? mediaOwners.get(self) : undefined;
      if (rule) notify(sheetOf(rule), undefined, inRule(rule));
    };
    hook(realm.MediaList.prototype, 'mediaText', listChanged, 'set');
    for (const name of ['appendMedium', 'deleteMedium']) hook(realm.MediaList.prototype, name, listChanged);
  }
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
    for (const [key, { part, name, native, hook }] of hooked) {
      const now = Object.getOwnPropertyDescriptor(proto, name);
      if (!now || now[part] !== hook) continue;
      Object.defineProperty(proto, name, { ...now, [part]: native });
      hooked.delete(key);
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
 * not known), recorded already in the texts they share. Unlike Chrome, the others send
 * styleSheetChanged.
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
