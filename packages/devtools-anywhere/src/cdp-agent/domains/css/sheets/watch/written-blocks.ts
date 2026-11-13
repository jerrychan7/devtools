/**
 * The texts the page wrote its style sheets and rules in, kept as it writes: the browser gives a text back
 * serialized, and what it cannot serialize is lost with it. A shorthand whose value has a var() or an env() is
 * kept as written for each of its sides, and once a longhand of it is set after it the block reads as longhands
 * with no value: nothing a script reads of the rule gives the shorthand's text then.
 *
 * Kept are the text of a sheet (replace(), replaceSync(), or one the agent set) and of an inserted rule
 * (insertRule(), addRule()), where it may call env() (`writtenText`), and which rules were inserted
 * (`wasInserted`). The rules of a list (a sheet's, a rule's) are found in its text by their place, so a list from
 * which a rule of the text was deleted, or whose change is not told, is broken (`listBroken`): its text gives
 * nothing for its rules.
 *
 * The writes are seen by proxies of the functions that make them, put on the prototypes of a realm
 * (`keepWritten`): the methods that insert and delete rules, replace() and replaceSync(). They are there from the
 * moment the agent loads, in the top window, and for the life of the page. They call only functions taken when
 * they were put, and index strings: no method of the page's prototypes.
 */

/** The lists of rules (by the sheet or the rule that has them) no longer found in their text. */
const broken = new WeakSet<object>();
/** The texts of sheets and of inserted rules. Each an object of its own: a later write of the same text is another. */
const written = new WeakMap<object, { text: string }>();
/** The rules inserted (insertRule(), addRule()), whatever their text: a sheet's own text was not written with them. */
const inserted = new WeakSet<object>();

/** The agent's own calls are not the page's writes: raised around them (cssom-watch.ts, ownEdit). */
export const agent = { busy: 0 };

/** Whether the rules of `parent` (a sheet, or a rule) are no longer found in the text they were written in. */
export const listBroken = (parent: object): boolean => broken.has(parent);

/** Whether `rule` was inserted (insertRule(), addRule()) since this module loaded. */
export const wasInserted = (rule: CSSRule): boolean => inserted.has(rule);

/** The text `target` (a sheet, or an inserted rule) was last written in, where it is kept. */
export const writtenText = (target: object): { text: string } | undefined => written.get(target);

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

/**
 * Puts the proxies on the prototypes of `realm`, once (see the module's note): they stay for the life of the
 * page.
 */
export function keepWritten(realm: Window & typeof globalThis): void {
  try {
    keepRules(realm);
  } catch {
    // A realm with no CSSOM (or one the page took apart): nothing is kept.
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
}
