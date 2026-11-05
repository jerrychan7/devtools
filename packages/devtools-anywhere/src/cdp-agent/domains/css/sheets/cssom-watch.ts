import { isCssom, realmOf } from '../../../core/realm';

/**
 * Notices the page changing style sheets through the CSSOM: the methods that add and remove
 * rules, replace() and replaceSync(), and setProperty() and removeProperty() of rules' styles,
 * hooked on the prototypes of each realm while someone watches (like adopted.ts). Setting a
 * property of a style directly (`rule.style.color = …`, `cssText`, `selectorText`) goes unseen.
 * The CSS domain's own changes are made through `ownEdit`, and not reported.
 */
type Listener = (sheet: CSSStyleSheet, text?: string) => void;
type Method = (this: unknown, ...args: unknown[]) => unknown;

const listeners = new Set<Listener>();
/** The native methods hooked, by prototype and name. */
const natives = new Map<object, Map<string, { native: unknown; hook: Method }>>();
let own = 0;

function notify(sheet: CSSStyleSheet | null | undefined, text?: string) {
  if (!sheet || own) return;
  for (const listener of listeners) listener(sheet, text);
}

/** The sheet a CSSOM object (sheet, rule, style) belongs to. */
function sheetOf(target: unknown): CSSStyleSheet | null {
  if (isCssom(target, 'CSSStyleSheet')) return target;
  if (isCssom(target, 'CSSStyleDeclaration')) return target.parentRule ? sheetOf(target.parentRule) : null;
  return typeof target === 'object' && target !== null && 'parentStyleSheet' in target
    ? sheetOf(Reflect.get(target, 'parentStyleSheet'))
    : null;
}

function hook(proto: object, name: string, after: (self: unknown, args: unknown[], result: unknown) => void) {
  const native: unknown = Reflect.get(proto, name);
  if (typeof native !== 'function') return;
  let hooked = natives.get(proto);
  if (hooked?.has(name)) return;
  if (!hooked) natives.set(proto, (hooked = new Map()));
  const wrapped: Method = function (this: unknown, ...args: unknown[]) {
    const result: unknown = Reflect.apply(native, this, args);
    after(this, args, result);
    return result;
  };
  hooked.set(name, { native, hook: wrapped });
  Object.defineProperty(proto, name, { configurable: true, writable: true, enumerable: true, value: wrapped });
}

function install(realm: Window & typeof globalThis) {
  const changed = (self: unknown) => notify(sheetOf(self));
  for (const proto of [realm.CSSStyleSheet.prototype, realm.CSSGroupingRule.prototype])
    for (const name of ['insertRule', 'deleteRule', 'addRule', 'removeRule']) hook(proto, name, changed);
  if (realm.CSSKeyframesRule)
    for (const name of ['appendRule', 'deleteRule']) hook(realm.CSSKeyframesRule.prototype, name, changed);
  for (const name of ['setProperty', 'removeProperty']) hook(realm.CSSStyleDeclaration.prototype, name, changed);
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
  // A hook the page wrapped since is kept (it does nothing without listeners).
  for (const [proto, methods] of natives)
    for (const [name, { native, hook }] of methods) {
      if (Reflect.get(proto, name) !== hook) continue;
      Object.defineProperty(proto, name, { configurable: true, writable: true, enumerable: true, value: native });
      methods.delete(name);
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

/** Hooks the realms of documents seen since watching started. */
export function watchRealms(docs: Document[]): void {
  if (listeners.size) for (const doc of docs) install(realmOf(doc));
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
