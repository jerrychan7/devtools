/**
 * What the page wrote its style sheets and declaration blocks in, kept as it writes: the browser gives a text
 * back serialized, and what it cannot serialize is lost with it. A shorthand whose value has a var() or an env()
 * is kept as written for each of its sides, and once a longhand of it is set after it the block reads as
 * longhands with no value: nothing a script reads of the block gives the shorthand's text then. The emulation
 * rewrites such a block from what was written (domains/emulation/rewrite.ts), and only from what is known to be
 * the block: each thing kept here says whether it still holds, and what may have changed unseen holds no more.
 *
 * - The text of a sheet (replace(), replaceSync(), or one the agent set) and of an inserted rule (insertRule(),
 *   addRule()), where it may call env() (`writtenText`), and which rules were inserted (`wasInserted`). The rules
 *   of a list (a sheet's, a rule's) are found in its text by their place, so a list from which a rule of the text
 *   was deleted, or whose change is not told, is broken (`listBroken`): its text gives nothing for its rules.
 * - For a declaration block, a record of its writes (`BlockRecord`): the text it started from, and each property
 *   set or removed since, in order. Played again on an empty block (`play`), they give the block: the browser
 *   itself decides what each write does (a shorthand over its longhands, a logical property moved after its
 *   physical one, a value it rejects). A record starts where the block is known: set to a text (`cssText`), or
 *   read before a write as a text that holds all of it; a rule's block that does not hold all it declares starts
 *   from its rule's text, looked for when the record is used. A rule's record starts with the first write to its
 *   block, an element's with a write that may call env(). A write that cannot be told (a value or a name that is
 *   an object, the typed OM) ends the record, and so do more writes than `MAX_WRITES`, and a write made past the
 *   proxies, as far as it shows (see Sealing below).
 * - Which blocks were written at all (`touched`): the text of a sheet is not taken for such a rule's block.
 *
 * The writes are seen by proxies of the functions that make them, put on the prototypes of a realm
 * (`keepWritten`): the methods that insert and delete rules, replace() and replaceSync(), a style's `cssText` and
 * `cssFloat` setters, setProperty() and removeProperty(), and the methods of StylePropertyMap. A property written
 * by name (`style.padding = ...`) is no function of a prototype in Chrome: the names are properties of each style
 * itself, answered by the browser, unless a prototype has a property of that name, which then takes the read and
 * the write. So an accessor is put on CSSStyleDeclaration.prototype for each name the browser gives a style, in
 * each spelling it takes (`paddingTop`, `padding-top`, `webkitTransform`: some 1550), which reads through
 * getPropertyValue() and writes through setProperty(), as the browser does for the name (tested over every name
 * in written-blocks.conformance.test.ts). The accessors are not enumerable, so `for (name in style)` lists what
 * the browser lists; a style no longer has the names as properties of its own (`Object.hasOwn(style, 'color')`,
 * its descriptor, `{ ...style }`), which a prototype's property hides by Web IDL's rules: see docs/limitations.md
 * for what a page can tell. The proxies and accessors call only functions taken when they were put, and index
 * strings: no method of the page's prototypes, but those of WeakMap.
 *
 * With `ALWAYS`, the proxies are there from the moment the agent loads, in the top window; without it, those of
 * the styles are there only while someone watches (cssom-watch.ts), and nothing written before is trusted.
 */

import { disconnect, newObserver, observe, takeRecords } from '../../../../core/natives';

/**
 * Whether the writes of declaration blocks are followed from the moment the agent loads (true), or only while
 * someone watches the CSSOM (false): the one switch. Without it, a block written while nobody watched is not
 * known, so the text of a sheet or of an inserted rule is never taken for a block (`sourceTrusted`), and every
 * record ends when the watching does.
 */
export const ALWAYS = false;

/** The most writes a record holds: past it, the record ends (a block animated property by property). */
export const MAX_WRITES = 64;

/** A property set, or removed, after the text a block started from. */
export interface Write {
  name: string;
  /** The value given to setProperty(), with its priority; none for removeProperty(). */
  value: string;
  priority: string;
  remove?: true;
  /** The value the block holds for it, where the emulation rewrote it. */
  held?: string;
}

/** The writes of a declaration block, from a text it is known to have read as. */
export interface BlockRecord {
  /** The text the block started from; null: the rule's text in its sheet, not looked for yet (`pre`). */
  base: string | null;
  /** How the base is known: a text the block was set to, or its serialization before the first write kept. */
  from: 'text' | 'read';
  /** The block's serialization before its first write kept. */
  pre: string;
  /** The base as the block holds it, where the emulation rewrote it. */
  heldBase?: string;
  writes: Write[];
  epoch: number;
  /** The element whose style the block is, observed since the record started (`sealing`); null for a rule's. */
  owner: Element | null;
  /** A rule's block: what it read as after the last write kept, which it must still read as before the next. */
  last?: string | undefined;
}

const records = new WeakMap<object, BlockRecord>();
/** The styles the page wrote, in any way: for a rule's, its text in its sheet is no longer taken for its block. */
const touched = new WeakSet<object>();
/** The lists of rules (by the sheet or the rule that has them) no longer found in their text. */
const broken = new WeakSet<object>();
/** The texts of sheets and of inserted rules. Each an object of its own: a later write of the same text is another. */
const written = new WeakMap<object, { text: string }>();
/** The rules inserted (insertRule(), addRule()), whatever their text: a sheet's own text was not written with them. */
const inserted = new WeakSet<object>();
/** Raised by each write this module does not follow: the records made before it have ended. */
let epoch = 0;
/** Whether such a write was made: no text of a sheet is trusted any more. */
let unfollowed = false;
/** Whether someone watches the CSSOM (cssom-watch.ts): without `ALWAYS`, the writes are followed only then. */
let watched = false;

/** The agent's own calls are not the page's writes: raised around them (cssom-watch.ts, ownEdit). */
export const agent = { busy: 0 };

/** A write was made that is not known of any block: every record has ended, and no text of a sheet is trusted. */
function unseen(): void {
  epoch++;
  unfollowed = true;
}

/*
 * Sealing. A block can be written past the proxies: by the functions of another realm (an iframe's
 * `CSSStyleDeclaration.prototype.setProperty.call(style, ...)`), by functions the page took before the agent
 * loaded, by `Object.defineProperty(style, name, { value })`, by the element's `style` attribute. Such a write may
 * leave the block reading as before (a shorthand with an env() set over another, with the same longhand after it),
 * so comparing what the record gives with the block does not tell it.
 *
 * An element's block tells it itself: each change of an inline style is a mutation of the `style` attribute. The
 * element is observed from before the write that starts its record, by an observer of the agent's own, whose
 * records are taken around each write the proxies see: one that is not such a write's ends the record. The
 * element of a style is known from the `style` getter (a proxy on the element prototypes): a style taken another
 * way has no record.
 *
 * A rule's block tells nothing. Its record keeps what the block read as after each write, and ends where the block
 * reads another text before the next: writes past the proxies that leave the text as it was are not seen (see
 * docs/limitations.md).
 */
/** The element each inline style was read from (`el.style`), and the style of each element observed. */
const owners = new WeakMap<object, Element>();
let observedStyles = new WeakMap<Element, object>();
let sealer: MutationObserver | undefined;

/** Ends the records of the elements `list` tells a change of, but `own`'s; returns how many were `own`'s. */
function ended(list: MutationRecord[], own?: Element): number {
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    const target = list[i]?.target as Element;
    if (target === own) count++;
    else {
      const style = observedStyles.get(target);
      if (style) records.delete(style);
    }
  }
  return count;
}

/** Takes the changes observed so far: see `ended`. */
const drain = (own?: Element): number => (sealer ? ended(takeRecords(sealer), own) : 0);

/** The element of `style`, observed from here on; undefined where it is not known. */
function sealing(style: object): Element | undefined {
  const owner = owners.get(style);
  if (!owner) return undefined;
  if (observedStyles.get(owner) !== style) {
    sealer ??= newObserver(list => void ended(list));
    observe(sealer, owner, { attributes: true, attributeFilter: ['style'] });
    observedStyles.set(owner, style);
  }
  return owner;
}

/** What `style` reads as, by its realm's own getter; undefined where its writes are not followed. */
function reading(style: object): string | undefined {
  const get = followed(style)?.natives.get('get:cssText');
  return get ? (call(get, style) as string) : undefined;
}

/**
 * The agent wrote `style` as its record says (the emulation playing it, cssom-watch.ts): the block is the
 * record's from here on.
 */
export function sealRecord(style: object): void {
  const record = records.get(style);
  if (!record) return;
  if (record.owner) drain(record.owner);
  else record.last = reading(style);
}

/** What is known of a realm's styles, by CSSStyleDeclaration.prototype. */
interface Realm {
  /** Followed since the realm's scripts could first write: the texts of its sheets are its blocks. */
  fromStart: boolean;
  proto: object;
  /** The functions put on the prototype, and the accessors of the names of properties. */
  put: { name: string; part: 'value' | 'set'; native: unknown; proxy: unknown }[];
  /** The `style` getters of the element prototypes, with the proxies put over them. */
  getters: { proto: object; native: unknown; proxy: unknown }[];
  accessors: { key: string; set: unknown }[];
  names: Record<string, true>;
  /** The browser's functions of the prototype, by `part:name`. */
  natives: Map<string, unknown>;
}
const realms = new WeakMap<object, Realm>();

/** Whether the writes of `style` are followed now: its realm's proxies are where they were put. */
function followed(style: object): Realm | undefined {
  const proto: unknown = Object.getPrototypeOf(style);
  const realm = typeof proto === 'object' && proto !== null ? realms.get(proto) : undefined;
  if (!realm || !(ALWAYS || watched)) return undefined;
  // One accessor is looked at, for all: a page that took some of the others off is not noticed.
  const first = realm.accessors[0];
  if (!first || typeof Object.getOwnPropertyDescriptor(realm.proto, first.key)?.set !== 'function') return undefined;
  // The page may wrap a function (it still calls this one); the browser's own, put back, is not followed.
  for (const { name, part, native } of realm.put)
    if (Object.getOwnPropertyDescriptor(realm.proto, name)?.[part] === native) return undefined;
  return realm;
}

/** The record of the writes of `style`, where it holds: none ended it, and its writes are still followed. */
export function blockRecord(style: object): BlockRecord | undefined {
  drain();
  const record = records.get(style);
  if (!record) return undefined;
  // A rule's block that reads another text than the last write kept left it with was written unseen.
  const kept = record.owner || record.last === undefined || reading(style) === record.last;
  if (kept && record.epoch === epoch && followed(style)) return record;
  records.delete(style);
  return undefined;
}

/** Ends the record of `style`: the block is no longer what its writes say. */
export function dropRecord(style: object): void {
  records.delete(style);
}

/** Starts a record of `style`, set to `text` (by the agent, or found to read as it): its block from here on. */
export function startRecord(style: object, text: string): BlockRecord {
  const record: BlockRecord = { base: text, from: 'text', pre: '', writes: [], epoch, owner: null };
  records.set(style, record);
  record.last = reading(style);
  touched.add(style);
  return record;
}

/**
 * Whether the text `style`'s rule was written in (its sheet's, or an inserted rule's) is still the block: the
 * page wrote nothing to it since, as far as its writes were followed, which is from the start in its realm.
 */
export function sourceTrusted(style: object): boolean {
  const realm = followed(style);
  return ALWAYS && !unfollowed && !!realm && !touched.has(style);
}

/** Whether the text of `sheet`'s <style> or file is its rules': its realm was followed from the start. */
export function sheetTrusted(style: object): boolean {
  return !!followed(style)?.fromStart;
}

/** Whether the rules of `parent` (a sheet, or a rule) are no longer found in the text they were written in. */
export const listBroken = (parent: object): boolean => broken.has(parent);

/** Whether `rule` was inserted (insertRule(), addRule()) since this module loaded. */
export const wasInserted = (rule: CSSRule): boolean => inserted.has(rule);

/** The text `target` (a sheet, or an inserted rule) was last written in, where it is kept. */
export const writtenText = (target: object): { text: string } | undefined => written.get(target);

/** Tells whether someone watches the CSSOM. Without `ALWAYS`, what was written until now is not known. */
export function setWatched(now: boolean): void {
  if (!ALWAYS && now !== watched) epoch++;
  watched = now;
}

/**
 * Whether `text` may call env(): it has `env(` in any ASCII case, or a backslash, which the name may be
 * written with. Only string indexing and comparisons: no method of the page's prototypes is called.
 */
export function mayCallEnv(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') return true;
    if (c !== '(' || i < 3) continue;
    const e = text[i - 3];
    const n = text[i - 2];
    const v = text[i - 1];
    if ((e === 'e' || e === 'E') && (n === 'n' || n === 'N') && (v === 'v' || v === 'V')) return true;
  }
  return false;
}

/**
 * Whether a serialized block has a declaration with no value (`name: ;`, or `name:  !important;`): it does not
 * hold all it declares.
 */
function hasNoValue(text: string): boolean {
  for (let i = 2; i < text.length; i++) {
    const c = text[i];
    if (text[i - 1] !== ' ') continue;
    if (c === ';' && text[i - 2] === ':') return true;
    if (c === '!' && (text[i - 2] === ':' || (text[i - 2] === ' ' && text[i - 3] === ':'))) return true;
  }
  return false;
}

/**
 * An index argument as Web IDL's `unsigned long` takes it; undefined for an object, which the
 * page's own conversion (`valueOf()`, `toString()`) would see called again.
 */
export const index = (value: unknown, otherwise: number) =>
  value === undefined
    ? otherwise
    : typeof value === 'object' || typeof value === 'function'
      ? undefined
      : Number(value) >>> 0;

/** A text argument, as the native function took it; undefined for an object, as for `index`. */
export const textOf = (value: unknown) =>
  (typeof value === 'object' && value !== null) || typeof value === 'function' || typeof value === 'symbol'
    ? undefined
    : String(value);

/** Keeps, or forgets, what `target` was written in: `text` as the native function took it (`textOf`). */
function keepText(target: unknown, text: string | undefined): void {
  if (typeof target !== 'object' || target === null) return;
  if (text !== undefined && mayCallEnv(text)) written.set(target, { text });
  else written.delete(target);
}

type Fn = (this: unknown, ...args: unknown[]) => unknown;
const call = (fn: unknown, self: unknown, args: unknown[] = []): unknown => Reflect.apply(fn as Fn, self, args);
const then = Promise.prototype.then;

/** The rules of `parent`, by the getter of whichever of `getters` takes it. */
function rulesOf(getters: unknown[], parent: unknown): CSSRuleList | undefined {
  for (const get of getters)
    try {
      return call(get, parent) as CSSRuleList;
    } catch {
      // Not this interface's.
    }
  return undefined;
}

/**
 * The rule `parent` got at `at` is one inserted, written in `text` (undefined: not known). Also for the agent's
 * own insertions (cssom-watch.ts, ownCall), whose rules are not of the sheet's text either.
 */
export function noteInserted(rule: unknown, text: string | undefined): void {
  if (typeof rule !== 'object' || rule === null) return;
  inserted.add(rule);
  keepText(rule, text);
}

/** How many times a list was told broken: what was found in a text before may no longer be. */
let breaks = 0;
export const brokenLists = (): number => breaks;

/** The rules of `parent` are no longer found in its text: one of them was deleted, or it changed untold. */
export function noteBroken(parent: unknown): void {
  if (typeof parent !== 'object' || parent === null || broken.has(parent)) return;
  broken.add(parent);
  breaks++;
}

/** `sheet` was written whole in `text`: its rules are those of that text. */
export function noteReplaced(sheet: unknown, text: string | undefined): void {
  if (typeof sheet !== 'object' || sheet === null) return;
  keepText(sheet, text);
  breaks++;
  if (text === undefined) broken.add(sheet);
  else broken.delete(sheet);
}

/**
 * `sheet` now holds the rules of `text`, each where the text has it, `rules` being all of them, at any depth: the
 * agent set its text (CSS.setStyleSheetText), keeping the rules whose text did not change. None of them is an
 * inserted one any more, and the text is kept whatever it holds: the text of a <style> is no longer its sheet's.
 */
export function noteRetexted(sheet: object, text: string, rules: Iterable<object>): void {
  for (const rule of rules) {
    inserted.delete(rule);
    written.delete(rule);
    broken.delete(rule);
  }
  broken.delete(sheet);
  written.set(sheet, { text });
  breaks++;
}

/** A scratch block, to ask the browser whether it takes a write: made when first needed. */
let scratch: { style: object; realm: Realm } | undefined;

/** Whether the browser takes `write` in an empty block: it then replaces the write before it of the same name. */
function taken(write: Write): boolean {
  if (!scratch) return false;
  const { style, realm } = scratch;
  try {
    call(realm.natives.get('set:cssText'), style, ['']);
    call(realm.natives.get('value:setProperty'), style, [write.name, write.value, write.priority]);
    return (call(realm.natives.get('get:length'), style) as number) > 0;
  } catch {
    return false;
  }
}

/**
 * Adds `write` to `record`, or ends it where it holds too many. `holds`: whether the block now reads the write's
 * value for its name, as written.
 */
function add(style: object, record: BlockRecord, write: Write, holds: () => boolean): void {
  const { writes } = record;
  const last = writes[writes.length - 1];
  // Set again at once: the first write is as if not made, where the browser took the second. It did where the
  // block reads the value as written; else an empty block is asked (`taken`).
  if (last && !last.remove && !write.remove && last.name === write.name && (holds() || taken(write)))
    writes[writes.length - 1] = write;
  else if (writes.length < MAX_WRITES) writes.push(write);
  else records.delete(style);
}

/**
 * Puts the proxies on the prototypes of `realm`, once (see the module's note): those of the sheets and rules
 * stay for the life of the page; those of the styles too with `ALWAYS`, else until `unfollowStyles`.
 * `fromStart`: the realm's scripts have not written yet, as far as known (the top window, when the agent loads).
 */
export function keepWritten(realm: Window & typeof globalThis, fromStart = false): void {
  try {
    keepRules(realm);
  } catch {
    // A realm with no CSSOM (or one the page took apart): nothing is kept.
  }
  try {
    keepStyles(realm, fromStart);
  } catch {
    // The same: its blocks are not followed, and none is taken as known.
  }
}

const keptRules = new WeakSet<object>();

/** A proxy of `native`, the function `name` of `proto`, calling `before` and `after` around it; null if not put. */
function wrap(
  proto: object,
  name: string,
  part: 'value' | 'set',
  before: ((self: unknown, args: unknown[]) => unknown) | null,
  after: (self: unknown, args: unknown[], result: unknown, kept: unknown) => void
): { native: unknown; proxy: unknown } | null {
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  const native: unknown = descriptor?.[part];
  if (!descriptor?.configurable || typeof native !== 'function') return null;
  const proxy = new Proxy(native, {
    apply(f, self, args) {
      if (agent.busy) return Reflect.apply(f, self, args);
      let kept: unknown;
      if (before)
        try {
          kept = before(self, args);
        } catch {
          // Ours, not the page's: its call goes on, and `after` is told nothing was kept.
        }
      const result: unknown = Reflect.apply(f, self, args);
      try {
        after(self, args, result, kept);
      } catch {
        // Ours, not the page's: its call went through.
      }
      return result;
    },
  });
  try {
    Object.defineProperty(proto, name, { ...descriptor, [part]: proxy });
  } catch {
    return null;
  }
  return { native, proxy };
}

function keepRules(realm: Window & typeof globalThis): void {
  if (keptRules.has(realm)) return;
  keptRules.add(realm);
  const sheetProto = realm.CSSStyleSheet.prototype;
  const lists = [sheetProto, realm.CSSGroupingRule.prototype, realm.CSSStyleRule.prototype];
  const getters = lists.map(proto => Object.getOwnPropertyDescriptor(proto, 'cssRules')?.get);
  const ruleAt = (parent: unknown, at: number | undefined): unknown =>
    at === undefined ? undefined : rulesOf(getters, parent)?.[at];
  wrap(sheetProto, 'replaceSync', 'value', null, (self, args) => noteReplaced(self, textOf(args[0])));
  // The rules are replaced when the promise resolves: until then the sheet's text is not known.
  wrap(sheetProto, 'replace', 'value', null, (self, args, result) => {
    noteReplaced(self, undefined);
    const text = textOf(args[0]);
    if (typeof result === 'object' && result !== null) call(then, result, [() => noteReplaced(self, text), () => {}]);
  });
  // The rule is where the browser says it put it: the call returned, so the index is good.
  for (const proto of lists)
    wrap(proto, 'insertRule', 'value', null, (self, args, result) =>
      noteInserted(ruleAt(self, Number(result)), textOf(args[0]))
    );
  // addRule() inserts `selector { block }` at its index, or last.
  wrap(sheetProto, 'addRule', 'value', null, (self, args) => {
    const at = index(args[2], -1);
    const rules = rulesOf(getters, self);
    const selector = textOf(args[0]);
    const block = textOf(args[1]);
    if (at === undefined || !rules) return noteBroken(self);
    noteInserted(
      rules[at < 0 || at >= rules.length ? rules.length - 1 : at],
      selector === undefined || block === undefined ? undefined : `${selector} { ${block} }`
    );
  });
  // A rule deleted that the text was written with: the ones after it are no longer found by their place.
  const deleting = (self: unknown, args: unknown[]) => {
    const rule = ruleAt(self, index(args[0], 0));
    return typeof rule === 'object' && rule !== null && inserted.has(rule);
  };
  const deleted = (self: unknown, _args: unknown[], _result: unknown, wasInserted: unknown) => {
    if (wasInserted !== true) noteBroken(self);
  };
  for (const proto of lists) wrap(proto, 'deleteRule', 'value', deleting, deleted);
  wrap(sheetProto, 'removeRule', 'value', deleting, deleted);
  // The keyframes of a rule are deleted by their key and added last: not followed.
  if (realm.CSSKeyframesRule)
    for (const name of ['appendRule', 'deleteRule'])
      wrap(realm.CSSKeyframesRule.prototype, name, 'value', null, self => noteBroken(self));
  // The typed OM writes a block past everything here: the block of the map's owner is not known from then on.
  // A map taken before this was put has no owner known, and its write ends every record.
  if (realm.StylePropertyMap) {
    const owners = new WeakMap<object, () => unknown>();
    const owned = (proto: object | undefined, name: string) => {
      const descriptor = proto && Object.getOwnPropertyDescriptor(proto, name);
      const get: unknown = descriptor?.get;
      const style: unknown = proto && Object.getOwnPropertyDescriptor(proto, 'style')?.get;
      if (!proto || !descriptor?.configurable || typeof get !== 'function' || typeof style !== 'function') return;
      const proxy = new Proxy(get as () => unknown, {
        apply(f, self, args) {
          const map: unknown = Reflect.apply(f, self, args);
          if (typeof map === 'object' && map !== null) owners.set(map, () => call(style, self));
          return map;
        },
      });
      try {
        Object.defineProperty(proto, name, { ...descriptor, get: proxy });
      } catch {
        // The page's realm refused: a write through the map ends every record.
      }
    };
    owned(realm.CSSStyleRule.prototype, 'styleMap');
    for (const proto of [realm.HTMLElement, realm.SVGElement, realm.MathMLElement])
      owned(proto?.prototype, 'attributeStyleMap');
    for (const name of ['set', 'append', 'delete', 'clear'])
      wrap(realm.StylePropertyMap.prototype, name, 'value', null, self => {
        const style = typeof self === 'object' && self !== null ? owners.get(self)?.() : undefined;
        if (typeof style === 'object' && style !== null) {
          records.delete(style);
          touched.add(style);
        } else unseen();
      });
  }
}

/** Told of each style the page wrote a property of by name, once the write is made (the emulation's rewrites). */
let named: ((style: object) => void) | null = null;

/** Sets (or with null, removes) what is told of the page's writes by name. */
export function onNamedWrite(tell: ((style: object) => void) | null): void {
  named = tell;
}

/** Whether `name` of `proto` is an accessor put here for a property written by name. */
export const isNameAccessor = (proto: object, name: string): boolean => !!realms.get(proto)?.names[name];

/** The realms whose styles have the proxies now, to take them off (`unfollowStyles`): none with `ALWAYS`. */
const styleRealms = new Set<Realm>();

/** A style's property name (`paddingTop`, `webkitTransform`, `padding-top`) as setProperty() takes it. */
const dashed: Record<string, string> = { __proto__: null } as unknown as Record<string, string>;
function dashedName(key: string): string {
  const known = dashed[key];
  if (known !== undefined) return known;
  let out = '';
  for (let i = 0; i < key.length; i++) {
    const c = key[i] ?? '';
    if (c >= 'A' && c <= 'Z') out += (i ? '-' : '') + String.fromCharCode(c.charCodeAt(0) + 32);
    else out += c;
  }
  // `webkitTransform` and `WebkitTransform` are `-webkit-transform`.
  if (out.startsWith('webkit-')) out = `-${out}`;
  return (dashed[key] = out);
}

function keepStyles(realm: Window & typeof globalThis, fromStart: boolean): void {
  if (!ALWAYS && !watched) return;
  const proto = realm.CSSStyleDeclaration.prototype;
  if (realms.has(proto)) return;
  const natives = new Map<string, unknown>();
  for (const [part, name] of [
    ['get', 'cssText'],
    ['set', 'cssText'],
    ['get', 'parentRule'],
    ['get', 'length'],
    ['value', 'setProperty'],
    ['value', 'removeProperty'],
    ['value', 'getPropertyValue'],
    ['value', 'getPropertyPriority'],
  ] as const) {
    const fn: unknown = Object.getOwnPropertyDescriptor(proto, name)?.[part];
    if (typeof fn !== 'function') return;
    natives.set(`${part}:${name}`, fn);
  }
  const read = (style: unknown) => call(natives.get('get:cssText'), style) as string;
  const ruleOf = (style: unknown) => call(natives.get('get:parentRule'), style);

  /** What `before` found for a write: the block's text, where a record may start from it, and the element observed. */
  interface Kept {
    pre?: string | undefined;
    owner?: Element | undefined;
  }
  /**
   * Before a write to `style` that its record would hold, or that may start one (`env`): an element's block is
   * observed, and the changes told so far are taken (`sealing`); a rule's that reads another text than its record
   * left ends its record.
   */
  const guard = (style: object, env: boolean): Element | undefined => {
    const record = records.get(style);
    if (!record && !env) return undefined;
    const owner = sealing(style);
    if (owner) drain();
    else if (record && record.last !== undefined && read(style) !== record.last) records.delete(style);
    return owner;
  };
  /** Before a write of `value` to `style`: see `Kept`. */
  const before = (style: unknown, value: string | undefined): Kept | undefined => {
    if (typeof style !== 'object' || style === null) return undefined;
    const env = value !== undefined && mayCallEnv(value);
    const owner = guard(style, env);
    if (records.has(style)) return { owner };
    // An element's block is read before a write that may call env(); a rule's once, the first time it is written.
    // A style seen here once is not asked again whether it is a rule's.
    if (touched.has(style)) return { owner, pre: env && !ruleOf(style) ? read(style) : undefined };
    if (ruleOf(style)) return { owner, pre: read(style) };
    touched.add(style);
    return { owner, pre: env ? read(style) : undefined };
  };
  /** After the write `write` (undefined: one that cannot be told) to `style`, for which `before` gave `kept`. */
  const after = (style: unknown, kept: Kept | undefined, write: Write | undefined): void => {
    if (typeof style !== 'object' || style === null) return;
    const owner = kept?.owner;
    // An element's write is one change of its attribute, or none: another was made within it, unseen.
    if (!kept || (owner && drain(owner) > 1)) {
      records.delete(style);
      touched.add(style);
      return;
    }
    const record = records.get(style);
    if (record) {
      if (!write) return void records.delete(style);
      add(
        style,
        record,
        write,
        () =>
          call(natives.get('value:getPropertyValue'), style, [write.name]) === write.value &&
          (call(natives.get('value:getPropertyPriority'), style, [write.name]) === 'important') ===
            (write.priority !== '')
      );
      if (!record.owner) record.last = read(style);
      return;
    }
    const pre = kept.pre;
    if (pre === undefined) return;
    const rule = ruleOf(style);
    const whole = !hasNoValue(pre);
    // A rule's block is followed from its first write: from the text it read as, where that holds all of it, else
    // from the rule's own text in its sheet. An element's, from a write that may call env(), where its text holds
    // it and its element is observed.
    if (write && (rule ? !touched.has(style) : whole && !!owner && mayCallEnv(write.value)))
      records.set(style, {
        base: whole ? pre : null,
        from: 'read',
        pre,
        writes: [write],
        epoch,
        owner: rule ? null : (owner ?? null),
        last: rule ? read(style) : undefined,
      });
    touched.add(style);
  };

  const put: Realm['put'] = [];
  const accessors: Realm['accessors'] = [];
  const seen: Record<string, true> = { __proto__: null } as unknown as Record<string, true>;
  const getters: Realm['getters'] = [];
  const realmState: Realm = { fromStart: ALWAYS && fromStart, proto, put, getters, accessors, natives, names: seen };
  const wrapped = (
    name: string,
    part: 'value' | 'set',
    b: Parameters<typeof wrap>[3],
    a: Parameters<typeof wrap>[4]
  ) => {
    const made = wrap(proto, name, part, b, a);
    if (made) put.push({ name, part, ...made });
    return !!made;
  };
  const ok =
    wrapped(
      'cssText',
      'set',
      (self, args) => {
        const text = textOf(args[0]);
        return typeof self === 'object' && self !== null
          ? { owner: guard(self, text !== undefined && mayCallEnv(text)) }
          : undefined;
      },
      (self, args, _result, kept) => {
        if (typeof self !== 'object' || self === null) return;
        const text = textOf(args[0]);
        const rule = ruleOf(self);
        const owner = (kept as Kept | undefined)?.owner;
        // An element's block is the text's where its element is observed, and the set was its one change.
        const known = rule ? true : !!owner && drain(owner) <= 1;
        if (kept && known && text !== undefined && mayCallEnv(text))
          records.set(self, {
            base: text,
            from: 'text',
            pre: '',
            writes: [],
            epoch,
            owner: rule ? null : (owner ?? null),
            last: rule ? read(self) : undefined,
          });
        else records.delete(self);
        if (rule) touched.add(self);
      }
    ) &&
    // `cssFloat` is the one property with a setter of the prototype's own: it sets `float`.
    wrapped(
      'cssFloat',
      'set',
      (self, args) => before(self, textOf(args[0])),
      (self, args, _result, kept) => {
        const value = args[0] === null ? '' : textOf(args[0]);
        after(self, kept as Kept | undefined, value === undefined ? undefined : { name: 'float', value, priority: '' });
      }
    ) &&
    wrapped(
      'setProperty',
      'value',
      (self, args) => before(self, textOf(args[1])),
      (self, args, _result, pre) => {
        const name = textOf(args[0]);
        const value = args[1] === null ? '' : textOf(args[1]);
        const priority = args[2] === undefined ? '' : args[2] === null ? '' : textOf(args[2]);
        const told = name !== undefined && value !== undefined && priority !== undefined;
        after(self, pre as Kept | undefined, told ? { name, value, priority } : undefined);
      }
    ) &&
    wrapped(
      'removeProperty',
      'value',
      self => before(self, undefined),
      (self, args, _result, pre) => {
        const name = textOf(args[0]);
        after(
          self,
          pre as Kept | undefined,
          name === undefined ? undefined : { name, value: '', priority: '', remove: true }
        );
      }
    );
  if (!ok) return;
  // A property written by name: an accessor of the prototype for each name the browser gives a style, which makes
  // the write, or the read, as the browser does (setProperty(), getPropertyValue()), and follows the write.
  const setProperty = natives.get('value:setProperty') as Fn;
  const getPropertyValue = natives.get('value:getPropertyValue') as Fn;
  // The names the browser lists, and the other spellings it takes for them: with dashes, and `Webkit` for `webkit`.
  const names: string[] = [];
  try {
    const style = realm.document.createElement('div').style;
    const takes = (key: string) => {
      if (seen[key] || !call(Object.prototype.hasOwnProperty, style, [key])) return;
      seen[key] = true;
      names.push(key);
    };
    for (const key of Object.getOwnPropertyNames(style)) {
      takes(key);
      takes(dashedName(key));
      if (key.startsWith('webkit')) takes(`W${key.slice(1)}`);
      if (key.startsWith('Webkit')) takes(`w${key.slice(1)}`);
    }
  } catch {
    // No names: nothing of the realm's blocks is taken as known.
  }
  // Whether `self` is an object that is no style (the prototype, an object made of it, a proxy of a style): the
  // browser has no accessor for the name, and reads or writes it as a property of that object.
  const plain = (self: unknown): self is object => {
    if (typeof self !== 'object' || self === null) return false;
    try {
      call(natives.get('get:length'), self);
    } catch {
      return true;
    }
    return false;
  };
  /**
   * Reads (or with `write`, writes) `key` of `self`, which is no style, as the browser does where the prototype
   * has no accessor for it: the accessor is taken off for the time of it. A proxy of a style then answers with
   * its style's property (`new Proxy(el.style, {}).color`), and writes it: a write the agent is not told the
   * block of, nor what a trap of the proxy writes meanwhile, so every record ends (`unseen`).
   */
  const without = (self: object, key: string, write?: { value: unknown }): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    // A prototype the page froze keeps the accessor: the name reads as undefined there, and is not written.
    if (!descriptor || !Reflect.deleteProperty(proto, key)) return undefined;
    unseen();
    try {
      return write ? Reflect.set(self, key, write.value) : (Reflect.get(self, key) as unknown);
    } finally {
      Object.defineProperty(proto, key, descriptor);
    }
  };
  const apply = Reflect.apply;
  for (const key of names) {
    if (key in proto) continue;
    const name = dashedName(key);
    const read = [name];
    // Plain functions, not proxies of the browser's: the browser has no accessor to look like, and a read by
    // name, of a computed style as well, costs the call of getPropertyValue() and little more.
    const { get, set } = Object.getOwnPropertyDescriptor(
      {
        get [key](): unknown {
          try {
            return apply(getPropertyValue, this, read);
          } catch (e) {
            if (plain(this)) return without(this, key);
            throw e;
          }
        },
        set [key](value: unknown) {
          if (agent.busy) {
            apply(setProperty, this, [name, value]);
            return;
          }
          const text = value === null ? '' : textOf(value);
          let kept: Kept | undefined;
          try {
            kept = before(this, text);
          } catch {
            // Ours, or no style: the write goes on.
          }
          try {
            apply(setProperty, this, [name, value]);
          } catch (e) {
            if (!plain(this)) throw e;
            without(this, key, { value });
            return;
          }
          try {
            after(this, kept, text === undefined ? undefined : { name, value: text, priority: '' });
            if (named && typeof this === 'object' && this !== null) named(this);
          } catch {
            // Ours, not the page's: its write went through.
          }
        },
      },
      key
    ) as { get: () => unknown; set: (value: unknown) => void };
    try {
      // Not enumerable: `for (name in style)` lists the names the browser lists, each once.
      Object.defineProperty(proto, key, { get, set, enumerable: false, configurable: true });
      accessors.push({ key, set });
    } catch {
      // The page's realm refused: nothing of its blocks is taken as known.
      return;
    }
  }
  if (!accessors.length) return;
  // The element of each inline style, from the getter that gives it (`sealing`).
  for (const ctor of [realm.HTMLElement, realm.SVGElement, realm.MathMLElement]) {
    const owner: object | undefined = ctor?.prototype;
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'style');
    const native: unknown = descriptor?.get;
    if (!owner || !descriptor?.configurable || typeof native !== 'function') continue;
    // A plain getter, not a proxy of the browser's: `el.style` is read for every write of an inline style, and a
    // proxy of the browser's getter costs far more per read than a plain getter does.
    const proxy = Object.getOwnPropertyDescriptor(
      {
        get style(): unknown {
          const style: unknown = apply(native as Fn, this, []);
          if (typeof style === 'object' && style !== null && !owners.has(style)) owners.set(style, this as Element);
          return style;
        },
      },
      'style'
    )?.get;
    if (!proxy) continue;
    try {
      Object.defineProperty(owner, 'style', { ...descriptor, get: proxy });
      getters.push({ proto: owner, native, proxy });
    } catch {
      // The page's realm refused: the styles of its elements have no record.
    }
  }
  realms.set(proto, realmState);
  if (!ALWAYS) styleRealms.add(realmState);
  if (!scratch)
    try {
      scratch = { style: realm.document.createElement('div').style, realm: realmState };
    } catch {
      // No scratch block: a write set again is kept as another.
    }
}

/** Takes the proxies of the styles off again, where they are still the ones put: without `ALWAYS`, when nobody watches. */
export function unfollowStyles(): void {
  if (ALWAYS) return;
  for (const realm of styleRealms) {
    try {
      for (const { key, set } of realm.accessors)
        if (Object.getOwnPropertyDescriptor(realm.proto, key)?.set === set) Reflect.deleteProperty(realm.proto, key);
      for (const { name, part, native, proxy } of realm.put) {
        const now = Object.getOwnPropertyDescriptor(realm.proto, name);
        if (now && now[part] === proxy) Object.defineProperty(realm.proto, name, { ...now, [part]: native });
      }
      for (const { proto, native, proxy } of realm.getters) {
        const now = Object.getOwnPropertyDescriptor(proto, 'style');
        if (now && now.get === proxy) Object.defineProperty(proto, 'style', { ...now, get: native as () => unknown });
      }
    } catch {
      // The page's realm refused: its proxies stay.
    }
    realms.delete(realm.proto);
  }
  styleRealms.clear();
  scratch = undefined;
  if (sealer) disconnect(sealer);
  sealer = undefined;
  observedStyles = new WeakMap();
}

/** A block to play a record on: what sets its text, sets a property and removes one. */
export interface Player {
  text(text: string): void;
  set(name: string, value: string, priority: string): void;
  remove(name: string): void;
}

/**
 * Plays `record` on a block: its base, then each write, in order. `held`: as the block holds them (rewritten
 * where the emulation rewrote them), not as the page wrote them. `rewrite` is applied to each text played.
 */
export function play(record: BlockRecord, on: Player, held = false, rewrite?: (text: string) => string): void {
  const of = (text: string) => (rewrite ? rewrite(text) : text);
  on.text(of((held ? record.heldBase : undefined) ?? record.base ?? ''));
  for (const write of record.writes)
    if (write.remove) on.remove(write.name);
    else
      on.set(write.name, write.value === '' ? '' : of((held ? write.held : undefined) ?? write.value), write.priority);
}
