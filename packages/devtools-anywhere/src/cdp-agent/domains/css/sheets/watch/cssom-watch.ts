import { isCssom, realmOf } from '../../../../core/realm';
import type { CssNatives } from '../../../../probe/types';

/**
 * Notices the page changing style sheets through the CSSOM: the methods that add and remove
 * rules, replace() and replaceSync(), setProperty() and removeProperty(), the setters of rules
 * and their styles (`cssText`, `selectorText`, `keyText`), and those of a rule's media list
 * (`mediaText`, appendMedium(), deleteMedium()), hooked on the prototypes of each realm while
 * someone watches (like adopted.ts). The hooks are proxies of the native functions: their name,
 * length and that they cannot be constructed stay the same, and `toString()` keeps the native
 * form (without the name). The CSS domain's own changes are not reported: made through the
 * native functions (`ownCall`, `ownSet`), past the hooks, or within `ownEdit`.
 *
 * A MediaList does not tell its rule: the `media` getters of rules note it (`rule.media` is the
 * same list each time), so a list taken before anyone watched goes unseen, as does the sheet's
 * own (`sheet.media`), which changes no rule.
 *
 * A style's properties by name (`rule.style.color = …`, `marginTop`) cannot be hooked: in Chrome
 * they are data properties of each CSSStyleDeclaration itself (some 750), no accessors of its
 * prototype, and a proxy of the style fails the native methods' checks. They are seen afterwards
 * instead (`settle`): a page writes them through `rule.style`, whose getter notes the rule with
 * its style's text then, before the write; before the sheet's text is used, the rules noted are
 * compared with their text, and those changed reported as changes of their top-level rule.
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
/** How many times each sheet was reported changed, or edited by a session: for replace(). */
const versions = new WeakMap<CSSStyleSheet, number>();
const changedAgain = (sheet: CSSStyleSheet) => versions.set(sheet, (versions.get(sheet) ?? 0) + 1);
/** The sheets whose rules the page or a session changed while watched (`rulesChanged`). */
const mutated = new WeakSet<CSSStyleSheet>();

/**
 * Whether the page (through the CSSOM) or a session changed the rules of `sheet` while watched:
 * like Chrome's StyleSheetContents::IsMutable(), set by CSSStyleSheet::WillMutateRules and never
 * cleared. A change the page made while nobody watched goes unseen (Chrome counts it), and so
 * does a property written by name with a value the browser rejects (`style.color = 'nope'`,
 * seen only by comparing texts: Chrome counts it too).
 */
export function rulesChanged(sheet: CSSStyleSheet): boolean {
  return mutated.has(sheet);
}

type Recorder = (sheet: CSSStyleSheet, text?: string, change?: CssomChange) => void;

/** Records a change of the page in the texts the sessions share, before they are told. */
let record: Recorder = () => {};

/** Sets what records each change the page makes, once for every session. */
export function recordPageChanges(fn: Recorder): void {
  record = fn;
}

function notify(sheet: CSSStyleSheet | null | undefined, text?: string, change?: CssomChange) {
  if (!own) report(sheet, text, change);
}

/**
 * Records and tells a change of the page, even from within the CSS domain's code (`settle`).
 * `counts`: Chrome would take the sheet as mutated (`rulesChanged`); its text is dropped either way.
 */
function report(sheet: CSSStyleSheet | null | undefined, text?: string, change?: CssomChange, counts = true) {
  if (!sheet || !listeners.size) return;
  changedAgain(sheet);
  if (counts) mutated.add(sheet);
  if (change?.kind === 'rule' && suspects.size) reported.add(change.rule);
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

/** A rule no longer in a sheet, or in one of a document unloaded (a frame removed or gone). */
function gone(rule: CSSRule): boolean {
  if (!topRuleOf(rule)) return true;
  const doc = rule.parentStyleSheet?.ownerNode?.ownerDocument;
  return !!doc && !doc.defaultView;
}

/** A change of what is in `rule`, or of `rule` itself, at its top-level rule. */
function inRule(rule: unknown): CssomChange | undefined {
  const top = typeof rule === 'object' && rule !== null && 'parentRule' in rule ? topRuleOf(rule as CSSRule) : null;
  return top ? { kind: 'rule', rule: top } : undefined;
}

/**
 * An index argument as Web IDL's `unsigned long` takes it; undefined for an object, which the
 * page's own conversion (`valueOf()`, `toString()`) would see called again.
 */
const index = (value: unknown, otherwise: number) =>
  value === undefined
    ? otherwise
    : typeof value === 'object' || typeof value === 'function'
      ? undefined
      : Number(value) >>> 0;

/** A text argument, as the native function took it; undefined for an object, as for `index`. */
const textOf = (value: unknown) =>
  (typeof value === 'object' && value !== null) || typeof value === 'function' ? undefined : String(value);

/**
 * `CSS` and its `supports`, as the page found them: the probe's, taken before the page's code
 * (`useCssNatives`), else those of this realm when this module loaded. The answer for a property
 * name does not depend on the realm, so sheets of iframes use the same. Known limit: without the
 * probe's (an older probe), a page that replaced `CSS` or `CSS.supports` before this bundle loaded
 * has its function called, and its answers taken.
 */
let cssNatives: CssNatives | undefined = typeof CSS === 'undefined' ? undefined : { CSS, supports: CSS.supports };

/** Takes the probe's `CSS` natives (undefined from an older probe: those found when loaded stay). */
export function useCssNatives(natives: CssNatives | undefined): void {
  if (!natives) return;
  cssNatives = natives;
  knownNames = { __proto__: null } as unknown as Record<string, boolean>;
  knownCount = 0;
}

/**
 * Whether a property has the name, by name as written, kept for the next writes: a dictionary
 * with no prototype, read and written with no method of the page's to call (Map's could be
 * replaced), emptied past `KNOWN_NAMES_LIMIT` names.
 */
let knownNames: Record<string, boolean> = { __proto__: null } as unknown as Record<string, boolean>;
let knownCount = 0;
const KNOWN_NAMES_LIMIT = 1024;

/** ASCII letter, digit or `-`, the characters a property's name has, with no method called. */
const nameChar = (c: string | undefined) =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-');

/**
 * Whether a name given to setProperty() or removeProperty() is a property's, as Chrome reads it:
 * as written (no unescaping, no trimming; ASCII case does not matter), custom properties
 * included (`--` alone is none). A name the page's own conversion makes (an object) is taken as
 * one. Only string indexing and comparisons: no method of the page's prototypes is called.
 */
export function knownProperty(value: unknown): boolean {
  const name = typeof value === 'string' ? value : textOf(value);
  if (name === undefined) return true;
  if (isCustom(name)) return true;
  let known = knownNames[name];
  if (known !== undefined) return known;
  known = name.length > 0;
  for (let i = 0; known && i < name.length; i++) known = nameChar(name[i]);
  // Descriptors are names to Chrome too, in any rule (`src` in a style rule counts), though
  // CSS.supports() knows them not.
  if (known && DESCRIPTORS[asciiLower(name)]) known = true;
  else if (known && cssNatives)
    try {
      known = Reflect.apply(cssNatives.supports, cssNatives.CSS, [name, 'inherit']) === true;
    } catch {
      known = true;
    }
  if (knownCount >= KNOWN_NAMES_LIMIT) {
    knownNames = { __proto__: null } as unknown as Record<string, boolean>;
    knownCount = 0;
  }
  knownNames[name] = known;
  knownCount++;
  return known;
}

/** A custom property's name: `--` and more. */
const isCustom = (name: string) => name.length > 2 && name[0] === '-' && name[1] === '-';

/** A dictionary of `names`, made with no method of the page's called. */
const dictionary = (names: string[]): Record<string, true> => {
  const out = { __proto__: null } as unknown as Record<string, true>;
  for (let i = 0; i < names.length; i++) out[names[i] ?? ''] = true;
  return out;
};

/**
 * The descriptors of at-rules that are no properties (Chrome's property ids for them): written
 * through any rule's style, they change it in Chrome, as properties do. CSS.supports() knows
 * none of them (a descriptor that is a property too, such as @page's `size`, it does). Taken
 * from the descriptors of @font-face, @property, @font-palette-values, @counter-style, @page and
 * @view-transition, and checked in Chrome 157.0.8103.39 for `src`, `syntax`, `system`,
 * `types`, `navigation` and `range`; `marks`, `bleed` and `font-named-instance` change nothing
 * there and are left out. Tested in cssom-watch.test.ts.
 */
const DESCRIPTORS = dictionary([
  'src',
  'unicode-range',
  'font-display',
  'ascent-override',
  'descent-override',
  'line-gap-override',
  'size-adjust',
  'syntax',
  'inherits',
  'initial-value',
  'base-palette',
  'override-colors',
  'system',
  'symbols',
  'additive-symbols',
  'negative',
  'prefix',
  'suffix',
  'range',
  'pad',
  'speak-as',
  'fallback',
  'page-orientation',
  'navigation',
  'types',
]);

/**
 * The properties an @position-try rule takes (insets, margins, sizes, self-alignment, the
 * anchor and area, as CSS Anchor Positioning lists them): setProperty() of any other there,
 * custom ones included, changes nothing in Chrome 157.0.8103.39 (removeProperty() of a known
 * one does change it). Tested in cssom-watch.test.ts.
 */
const POSITION_TRY = dictionary([
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'inset-block',
  'inset-block-start',
  'inset-block-end',
  'inset-inline',
  'inset-inline-start',
  'inset-inline-end',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-block',
  'margin-block-start',
  'margin-block-end',
  'margin-inline',
  'margin-inline-start',
  'margin-inline-end',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'block-size',
  'inline-size',
  'min-block-size',
  'min-inline-size',
  'max-block-size',
  'max-inline-size',
  'align-self',
  'justify-self',
  'place-self',
  'position-anchor',
  'position-area',
  'inset-area',
]);

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const TO_LOWER = { __proto__: null } as unknown as Record<string, string>;
for (let i = 0; i < UPPER.length; i++) TO_LOWER[UPPER[i] ?? ''] = LOWER[i] ?? '';

/** A name in ASCII lower case, with no method called. */
function asciiLower(name: string): string {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const c = name[i] ?? '';
    out += TO_LOWER[c] ?? c;
  }
  return out;
}

/** An @position-try rule, of any realm (as `isCssom`, which has no type for it). */
function isPositionTry(rule: unknown): boolean {
  if (typeof rule !== 'object' || rule === null) return false;
  for (let proto: unknown = Object.getPrototypeOf(rule); typeof proto === 'object' && proto !== null;) {
    if (Object.getOwnPropertyDescriptor(proto, Symbol.toStringTag)?.value === 'CSSPositionTryRule') return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/** Whether setProperty() of `value` changes an @position-try rule, as in Chrome. */
export function positionTryTakes(value: unknown): boolean {
  const name = typeof value === 'string' ? value : textOf(value);
  return name === undefined || (!isCustom(name) && POSITION_TRY[asciiLower(name)] === true);
}

/** `important` in any ASCII case, with no method called. */
function isImportant(text: string): boolean {
  const lower = 'important';
  const upper = 'IMPORTANT';
  if (text.length !== lower.length) return false;
  for (let i = 0; i < lower.length; i++) if (text[i] !== lower[i] && text[i] !== upper[i]) return false;
  return true;
}

/** Whether setProperty() takes a priority: none, empty, or `important` in any ASCII case. */
function validPriority(value: unknown): boolean {
  if (value === undefined) return true;
  const text = typeof value === 'string' ? value : textOf(value);
  return text === undefined || text === '' || isImportant(text);
}

/**
 * Hooks a method, or with `part`, an accessor's setter or getter, calling `after` past the native
 * one, while some session watches and, but with `always`, outside the CSS domain's own code.
 */
function hook(proto: object, name: string, after: After, part: Part = 'value', always = false, onThrow = false) {
  let hooked = natives.get(proto);
  const key = `${part}:${name}`;
  if (hooked?.has(key)) return;
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  const native: unknown = descriptor?.[part];
  // A property the page made non-configurable (a frozen prototype) is left alone, unseen.
  if (!descriptor?.configurable || typeof native !== 'function') return;
  const proxy = new Proxy(native, {
    apply(f, self, args) {
      const tell = (result: unknown) => {
        if (listeners.size && (always || !own))
          try {
            after(self, args, result);
          } catch {
            // Ours, not the page's: its call went through.
          }
      };
      let result: unknown;
      try {
        result = Reflect.apply(f, self, args);
      } catch (e) {
        if (onThrow) tell(undefined);
        throw e;
      }
      tell(result);
      return result;
    },
  });
  try {
    Object.defineProperty(proto, name, { ...descriptor, [part]: proxy });
  } catch {
    return;
  }
  if (!hooked) natives.set(proto, (hooked = new Map()));
  hooked.set(key, { part, name, native, hook: proxy });
}

/**
 * The rules whose style the page took (`rule.style`), with the style and its text when taken or
 * last compared (`settle`): all kept and compared each time, for a style the page keeps to write
 * later, up to `SUSPECTS_LIMIT`.
 */
const suspects = new Map<CSSRule, { style: CSSStyleDeclaration; text: string }>();
/** Top-level rules reported changed since the last `settle`: their whole text is serialized anew. */
const reported = new Set<CSSRule>();
/** How many rules were taken since the last `settle`. */
let taken = 0;
/** Nothing taken nor run since the last `settle`: the page has not run since (a microtask). */
let settled = false;
/**
 * How many rules are watched: past that, taken between two `settle`s or kept from before, the
 * sheets they are in are taken as changed everywhere (their texts serialized anew; not taken as
 * mutated) and none is watched any more, rather than reading every style taken each time. A
 * style the page keeps from then on and writes later goes unseen.
 */
const SUSPECTS_LIMIT = 2048;

/**
 * The sheets of `rules` changed where it is not told: their texts are serialized anew. They are
 * not taken as mutated (`rulesChanged`): most of these styles were only read, and Chrome keeps
 * such sheets immutable; a write through one of them goes uncounted.
 */
const lost = (rules: Iterable<CSSRule>) => {
  const seen = new Set<CSSStyleSheet>();
  for (const rule of rules) {
    const sheet = sheetOf(rule);
    if (sheet && !seen.has(sheet)) report(sheet, undefined, undefined, false);
    if (sheet) seen.add(sheet);
  }
};

/** The page took `rule`'s style: its text now is what it was before any write through it. */
function taking(rule: unknown, style: unknown) {
  if (typeof rule !== 'object' || rule === null || suspects.has(rule as CSSRule)) return;
  if (!isCssom(style, 'CSSStyleDeclaration')) return;
  suspects.set(rule as CSSRule, { style, text: style.cssText });
  settled = false;
  if (++taken <= SUSPECTS_LIMIT && suspects.size <= SUSPECTS_LIMIT) return;
  giveUp();
}

/** Too many rules watched: their sheets are serialized anew, and none is watched. */
function giveUp() {
  const rules = [...suspects.keys()];
  suspects.clear();
  reported.clear();
  taken = 0;
  lost(rules);
}

/**
 * Reports the rules whose style the page wrote by name since it took it (or since this was
 * last called): before the CSS domain uses a sheet's text, each rule taken is compared with its
 * text then. The page writing through a style it took before anyone watched goes unseen.
 */
export function settle(): void {
  if (!suspects.size || settled) return;
  settled = true;
  taken = 0;
  queueMicrotask(() => (settled = false));
  const changed: CSSRule[] = [];
  for (const [rule, entry] of suspects) {
    const top = topRuleOf(rule);
    if (!top || gone(rule)) {
      suspects.delete(rule);
      continue;
    }
    const text = entry.style.cssText;
    if (text === entry.text) continue;
    entry.text = text;
    if (!reported.has(top)) changed.push(top);
  }
  for (const top of new Set(changed)) report(sheetOf(top), undefined, { kind: 'rule', rule: top });
  reported.clear();
}

/**
 * Drops what was written through the styles taken of `sheet`'s rules and not reported yet: its
 * text is serialized anew from its rules, which holds it. The styles are still watched, compared
 * from now on with their text now, for a style the page keeps to write later.
 */
export function forgetSheet(sheet: CSSStyleSheet): void {
  for (const [rule, entry] of suspects) {
    if (sheetOf(rule) !== sheet) continue;
    if (gone(rule)) suspects.delete(rule);
    else entry.text = entry.style.cssText;
  }
  for (const rule of reported) if (sheetOf(rule) === sheet) reported.delete(rule);
}

/** What the CSS domain changes the CSSOM with, as `part:name`. */
const OWN_KEYS = [
  'value:insertRule',
  'value:deleteRule',
  'value:replaceSync',
  'set:cssText',
  'set:selectorText',
  'set:keyText',
  'set:mediaText',
  'get:style',
];
type Native = (...args: unknown[]) => unknown;

/**
 * The functions of `OWN_KEYS` on the top window's interface prototypes, by prototype and by
 * interface name: taken when the agent loads, before our hooks replace them. They are the native
 * ones unless a page script that ran before the agent replaced them already; those are called
 * then, as they were before. Web IDL checks the interface, not the realm: the top page's take an
 * iframe's objects too.
 */
const topNatives = new Map<object, Map<string, Native>>();
const ownNatives = new Map<string, Map<string, Native>>();
for (const name of Object.getOwnPropertyNames(globalThis)) {
  if (!/^(CSS\w*|MediaList)$/.test(name)) continue;
  const proto: unknown = (Reflect.get(globalThis, name) as { prototype?: unknown } | undefined)?.prototype;
  if (typeof proto !== 'object' || proto === null) continue;
  const found = new Map<string, Native>();
  for (const key of OWN_KEYS) {
    const [part, prop] = key.split(':') as [Part, string];
    const fn: unknown = Object.getOwnPropertyDescriptor(proto, prop)?.[part];
    if (typeof fn === 'function') found.set(key, fn as Native);
  }
  if (!found.size) continue;
  topNatives.set(proto, found);
  ownNatives.set(name, found);
}
/** The native function found for each prototype and `part:name` (null: none). */
const nativeCache = new WeakMap<object, Map<string, Native | null>>();

/**
 * The native function `self`'s `part:name` is, up its prototypes: the top window's own, or, in
 * another realm, the top window's of the interface the prototype names (`Symbol.toStringTag`),
 * if it has `name` of its own. The page may rename a prototype: a function that then refuses
 * `self` is given up (`viaNative`).
 */
function nativeOf(self: object, key: string): Native | null {
  const proto: unknown = Object.getPrototypeOf(self);
  if (typeof proto !== 'object' || proto === null) return null;
  let cached = nativeCache.get(proto);
  if (!cached) nativeCache.set(proto, (cached = new Map()));
  let fn = cached.get(key);
  if (fn !== undefined) return fn;
  fn = null;
  const [part, prop] = key.split(':') as [Part, string];
  for (let p: unknown = proto; !fn && typeof p === 'object' && p !== null; p = Object.getPrototypeOf(p)) {
    const top = topNatives.get(p);
    if (top) {
      fn = top.get(key) ?? null;
      continue;
    }
    if (typeof Object.getOwnPropertyDescriptor(p, prop)?.[part] !== 'function') continue;
    const tag: unknown = Object.getOwnPropertyDescriptor(p, Symbol.toStringTag)?.value;
    fn = (typeof tag === 'string' && ownNatives.get(tag)?.get(key)) || null;
  }
  cached.set(key, fn);
  return fn;
}

/**
 * Runs `native` with `self`'s native function for `key`, or `otherwise` within `ownEdit` when
 * there is none, or when it refuses `self` (a TypeError: an interface the page renamed).
 */
function viaNative<T>(self: object, key: string, native: (fn: Native) => T, otherwise: () => T): T {
  const fn = nativeOf(self, key);
  if (fn)
    try {
      return native(fn);
    } catch (e) {
      if (!(e instanceof TypeError) && (e as { name?: unknown } | null)?.name !== 'TypeError') throw e;
      nativeCache.get(Object.getPrototypeOf(self) as object)?.set(key, null);
    }
  return ownEdit(otherwise);
}

/**
 * Calls `self`'s method `name` (insertRule(), deleteRule(), replaceSync()), the CSS domain's own
 * change: the native function, past the hooks. The hooks do nothing for it (`own`); called
 * thousands of times when a sheet's text is set rule by rule. Through `ownEdit` for a method with
 * no native function known.
 */
export function ownCall<T>(self: object, name: string, ...args: unknown[]): T {
  return viaNative(
    self,
    `value:${name}`,
    fn => Reflect.apply(fn, self, args) as T,
    () => Reflect.apply(Reflect.get(self, name) as Native, self, args) as T
  );
}

/** Sets `self`'s `name` (`cssText`, `selectorText`, `keyText`, `mediaText`), like `ownCall`. */
export function ownSet(self: object, name: string, value: unknown): void {
  viaNative(
    self,
    `set:${name}`,
    fn => void Reflect.apply(fn, self, [value]),
    () => void Reflect.set(self, name, value)
  );
}

/** A rule's style, read by the CSS domain (not taken by the page): through the native getter. */
export function ownStyle(rule: { style: CSSStyleDeclaration }): CSSStyleDeclaration {
  return viaNative(
    rule,
    'get:style',
    fn => Reflect.apply(fn, rule, []) as CSSStyleDeclaration,
    () => rule.style
  );
}

/** The rule each media list belongs to, noted when read (`rule.media`). */
const mediaOwners = new WeakMap<object, CSSRule>();

function install(realm: Window & typeof globalThis) {
  const changed: After = self => notify(sheetOf(self), undefined, inRule(self));
  const sheetProto = realm.CSSStyleSheet.prototype;
  // Where a sheet's method inserted (insertRule's result; addRule's, -1, is none: its index or
  // the end) or deleted, as the browser took the arguments: the call returned, so they were good.
  // An index not known (`index`): no place.
  const sheetLevel = (self: unknown, change: (sheet: CSSStyleSheet) => CssomChange | undefined) => {
    const sheet = sheetOf(self);
    if (sheet) notify(sheet, undefined, change(sheet));
  };
  const at = (kind: 'insert' | 'delete', i: number | undefined): CssomChange | undefined =>
    i === undefined ? undefined : { kind, index: i };
  hook(sheetProto, 'insertRule', (self, _args, result) =>
    sheetLevel(self, () => ({ kind: 'insert', index: Number(result) }))
  );
  hook(sheetProto, 'addRule', (self, args) =>
    sheetLevel(self, sheet => at('insert', index(args[2], sheet.cssRules.length - 1)))
  );
  hook(sheetProto, 'deleteRule', (self, args) => sheetLevel(self, () => at('delete', index(args[0], 0))));
  hook(sheetProto, 'removeRule', (self, args) => sheetLevel(self, () => at('delete', index(args[0], 0))));
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
  // Like Chrome, setProperty() and removeProperty() with a name no property has, and
  // setProperty() with a priority other than `important`, change nothing: no change is told.
  // With a value the property rejects, setProperty() does change the sheet (it is mutable).
  // The same in every kind of rule (@font-face, @page and its margin rules, keyframes), but
  // @position-try, where setProperty() takes only the properties it allows.
  const styleWritten = (args: unknown[], self: unknown, set: boolean) => {
    let rule: unknown;
    try {
      rule = parentRule ? Reflect.apply(parentRule, self, []) : null;
    } catch {
      return; // Not a style.
    }
    if (!knownProperty(args[0])) return;
    if (set && isPositionTry(rule) && !positionTryTakes(args[0])) return;
    styleChanged(self, args, undefined);
  };
  hook(realm.CSSStyleDeclaration.prototype, 'setProperty', (self, args) => {
    if (validPriority(args[2])) styleWritten(args, self, true);
  });
  hook(realm.CSSStyleDeclaration.prototype, 'removeProperty', (self, args) => styleWritten(args, self, false));
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
  // A style the page takes, to write its properties by name, and a rule's media list. Reading
  // `rule.style` costs more while watching (Chrome 157, 100k reads of one rule: 8.3 ms against
  // 1.6; of 1000 rules, each taken once, 9.3 ms), and stays at 6.2 ms once the native getter is
  // put back: V8 no longer inlines a getter defined again from script, even the same one.
  for (const name of Object.getOwnPropertyNames(realm)) {
    if (!/^CSS\w*(Rule|Declarations)$/.test(name)) continue;
    const proto: unknown = (Reflect.get(realm, name) as { prototype?: unknown } | undefined)?.prototype;
    if (typeof proto !== 'object' || proto === null) continue;
    // The setters of each kind of rule (a selector, a key, a counter style's `system`, a font
    // feature's `fontFamily`…); CSSRule's `cssText` sets nothing, `media` is forwarded to the
    // list's `mediaText`, watched below, and `style` (`rule.style = …`) to the style's `cssText`,
    // watched above (hooking it too would tell the change twice).
    if (name !== 'CSSRule' && name.endsWith('Rule'))
      for (const prop of Object.getOwnPropertyNames(proto))
        // Like Chrome, a key it rejects (and throws for) still takes the sheet as mutated.
        if (prop !== 'media' && prop !== 'style' && Object.getOwnPropertyDescriptor(proto, prop)?.set)
          hook(proto, prop, changed, 'set', false, true);
    hook(proto, 'style', (self, _args, style) => taking(self, style), 'get');
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
  hook(sheetProto, 'replaceSync', (self, args) => notify(sheetOf(self), textOf(args[0])));
  hook(sheetProto, 'replace', (self, args, result) => {
    const sheet = sheetOf(self);
    const text = textOf(args[0]);
    const version = sheet ? versions.get(sheet) : undefined;
    // A promise of the sheet's realm. The sheet changed again since (replaceSync() in the same
    // task, a session's edit): its text is no longer this one, but serialized anew.
    if (typeof result === 'object' && result !== null && 'then' in result)
      void Promise.resolve(result).then(
        () => notify(sheet, sheet && versions.get(sheet) === version ? text : undefined),
        () => {}
      );
  });
}

/** The realms hooked since watching started: hooking one again would only find its hooks there. */
let installed = new WeakSet<object>();

/** Hooks a realm, as far as it lets: what the page made unhookable is not watched. */
function tryInstall(realm: Window & typeof globalThis) {
  if (installed.has(realm)) return;
  installed.add(realm);
  try {
    install(realm);
  } catch {
    // The page's realm refused: watching goes on with what was hooked.
  }
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
  // Not to hold the prototypes, and through them their realms, of frames gone since.
  for (const [proto, hooked] of natives) if (!hooked.size) natives.delete(proto);
  suspects.clear();
  reported.clear();
  taken = 0;
  installed = new WeakSet();
}

/** Calls `listener` with each sheet the page changes, and the text it replaces one with. */
export function watchCssom(listener: Listener, realms: () => (Window & typeof globalThis)[]): () => void {
  listeners.add(listener);
  realms().forEach(tryInstall);
  return () => {
    // What the page wrote through the styles it took is counted before they are dropped.
    settle();
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
  if (listeners.size) for (const doc of docs) tryInstall(realmOf(doc));
}

/**
 * Tells every session of an edit session `by` made to a sheet, its text now `text` (undefined:
 * not known), recorded already in the texts they share. Unlike Chrome, the others send
 * styleSheetChanged.
 */
export function editedBy(by: object, sheet: CSSStyleSheet, text: string | undefined): void {
  changedAgain(sheet);
  mutated.add(sheet);
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
