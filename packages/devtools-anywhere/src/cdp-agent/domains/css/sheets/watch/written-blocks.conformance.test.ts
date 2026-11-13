// written-blocks.ts in Chrome: what is kept of the page's writes, that a record of a block's writes played again
// gives the block, and that the functions and accessors put on the prototypes do what the browser's own do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { build } from 'esbuild';
import { launch, setUpAndTearDown } from '../../../../../../test-support/conformance.ts';
import type { ownCall, watchCssom } from './cssom-watch.ts';
import type { blockRecord, listBroken, play, wasInserted, writtenText } from './written-blocks.ts';
import type { Env } from '../../../../../../test-support/conformance.ts';

// Bundled for the page: the sources import each other without extensions.
const bundled = await build({
  stdin: {
    contents: `export { watchCssom, ownCall } from './cssom-watch.ts';
      export { blockRecord, listBroken, play, wasInserted, writtenText, sourceTrusted, MAX_WRITES } from './written-blocks.ts';`,
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: '__written',
  platform: 'neutral',
  write: false,
});

interface Written {
  watchCssom: typeof watchCssom;
  ownCall: typeof ownCall;
  blockRecord: typeof blockRecord;
  listBroken: typeof listBroken;
  play: typeof play;
  wasInserted: typeof wasInserted;
  writtenText: typeof writtenText;
  sourceTrusted: (style: object) => boolean;
  MAX_WRITES: number;
}

let env: Env | undefined;

setUpAndTearDown(
  async () => {
    env = await launch();
  },
  () => env?.close()
);

/** A page with the module loaded, as the agent loads it: before the page writes anything. */
async function freshPage(): Promise<Page> {
  if (!env) throw new Error('no browser');
  const page = await env.browser.newPage();
  await page.goto(`${env.baseUrl}/packages/devtools-anywhere/test-support/fixture.html`);
  await page.addScriptTag({ content: bundled.outputFiles[0]?.text ?? '' });
  return page;
}

test('the texts the page writes sheets and rules in are kept, whoever watches, and which lists still read as theirs', async () => {
  const page = await freshPage();
  const kept = await page.evaluate(async () => {
    const w = (globalThis as unknown as { __written: Written }).__written;
    const text = (target: object | undefined) => (target ? (w.writtenText(target)?.text ?? null) : undefined);
    const out: Record<string, unknown> = {};
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.a { padding: env(safe-area-inset-top) 2px; padding-left: 3px } @media all {} .z {}');
    out['replaceSync'] = text(sheet);
    const [a, media] = Array.from(sheet.cssRules) as [CSSStyleRule, CSSMediaRule];
    // An inserted rule: of a sheet, of a grouping rule, of a style rule. Each is noted as inserted, with its text
    // where that may call env(): in any case, or with an escape.
    const top = sheet.cssRules[sheet.insertRule('.b { margin: ENV(safe-area-inset-top) }', 2)];
    const plain = sheet.cssRules[sheet.insertRule('.c { color: red }', 0)];
    const grouped = media.cssRules[media.insertRule('.d { top: e\\6e v(safe-area-inset-top) }')];
    const nested = a.cssRules[a.insertRule('& { left: env(safe-area-inset-left) }')];
    sheet.addRule('.f', 'top: env(safe-area-inset-top)', 1);
    const added = sheet.cssRules[1];
    out['inserted'] = [top, plain, grouped, nested, added].map(rule => [text(rule), !!rule && w.wasInserted(rule)]);
    out['written'] = [w.wasInserted(a), text(a)];
    // A list is its text's while only inserted rules are deleted from it.
    sheet.deleteRule(0);
    media.deleteRule(0);
    out['intact'] = [w.listBroken(sheet), w.listBroken(media), w.listBroken(a)];
    sheet.removeRule(sheet.cssRules.length - 1);
    a.deleteRule(0);
    out['broken'] = [w.listBroken(sheet), w.listBroken(media), w.listBroken(a)];
    // The agent's own insertions are kept as the page's are, and its own deletions break a list as well.
    const own = new CSSStyleSheet();
    w.ownCall(own, 'replaceSync', '.a { top: env(safe-area-inset-top) } .b {}');
    const index = w.ownCall<number>(own, 'insertRule', '.e { top: env(safe-area-inset-top) }', 0);
    out['own'] = [text(own), text(own.cssRules[index]), !!own.cssRules[index] && w.wasInserted(own.cssRules[index])];
    w.ownCall(own, 'deleteRule', 0);
    const ownIntact = w.listBroken(own);
    w.ownCall(own, 'deleteRule', 0);
    out['ownBroken'] = [ownIntact, w.listBroken(own)];
    // A text with no env() forgets the one kept; a sheet written whole is its text's again.
    sheet.replaceSync('.a { color: red }');
    out['forgotten'] = [text(sheet), w.listBroken(sheet)];
    // Until replace() resolves, the sheet's text is not known.
    const replacing = sheet.replace('.a { top: env(safe-area-inset-top) } @keyframes k { from { top: 0 } }');
    out['replacing'] = [text(sheet), w.listBroken(sheet)];
    await replacing;
    out['replace'] = [text(sheet), w.listBroken(sheet)];
    const frames = sheet.cssRules[1] as CSSKeyframesRule;
    frames.appendRule('to { top: 1px }');
    out['keyframes'] = w.listBroken(frames);
    return out;
  });
  assert.deepEqual(kept, {
    replaceSync: '.a { padding: env(safe-area-inset-top) 2px; padding-left: 3px } @media all {} .z {}',
    inserted: [
      ['.b { margin: ENV(safe-area-inset-top) }', true],
      [null, true],
      ['.d { top: e\\6e v(safe-area-inset-top) }', true],
      ['& { left: env(safe-area-inset-left) }', true],
      ['.f { top: env(safe-area-inset-top) }', true],
    ],
    written: [false, null],
    intact: [false, false, false],
    broken: [true, false, false],
    own: ['.a { top: env(safe-area-inset-top) } .b {}', '.e { top: env(safe-area-inset-top) }', true],
    ownBroken: [false, true],
    forgotten: [null, false],
    replacing: [null, true],
    replace: ['.a { top: env(safe-area-inset-top) } @keyframes k { from { top: 0 } }', false],
    keyframes: true,
  });
  await page.close();
});

test('a record of the writes of a block starts where the block is known, and ends with a write that is not told', async () => {
  const page = await freshPage();
  const records = await page.evaluate(() => {
    const w = (globalThis as unknown as { __written: Written }).__written;
    const ENV = 'env(safe-area-inset-top)';
    const shown = (style: CSSStyleDeclaration) => {
      const record = w.blockRecord(style);
      return record
        ? [
            record.base,
            ...record.writes.map(x => (x.remove ? `-${x.name}` : `${x.name}=${x.value}${x.priority && '!'}`)),
          ]
        : null;
    };
    const el = () => document.body.appendChild(document.createElement('div'));
    const out: Record<string, unknown> = {};
    const run = (name: string, write: (style: CSSStyleDeclaration, el: HTMLElement) => void) => {
      const e = el();
      write(e.style, e);
      out[name] = shown(e.style);
      e.remove();
    };
    // An element's block: from a text, or from a write that may call env() on a block its text holds.
    run('text', s => (s.cssText = `padding: ${ENV} 2px; padding-left: 0`));
    run('plainText', s => (s.cssText = 'color: red'));
    run('plain', s => (s.color = 'red'));
    run('name', s => {
      s.color = 'red';
      s.padding = `${ENV} 2px`;
      s.paddingLeft = '0';
      (s as unknown as Record<string, string>)['margin-top'] = '1px';
      s.setProperty('top', '0', 'important');
      s.removeProperty('color');
    });
    run('putForwards', (_s, e) => ((e as unknown as { style: string }).style = `top: ${ENV}`));
    // Set again at once: the first write is as if not made, but where the browser rejects the second.
    run('again', s => {
      s.padding = `${ENV} 2px`;
      s.padding = `${ENV} 3px`;
      s.padding = '2PX';
      s.padding = 'nope';
    });
    run('unknownBlock', (s, e) => {
      e.setAttribute('style', `padding: ${ENV} 2px; padding-left: 0`);
      s.margin = ENV;
    });
    // What is not told ends the record: an object for a value or a name, too many writes, the typed OM.
    run('object', s => {
      s.cssText = `top: ${ENV}`;
      s.left = { toString: () => ENV } as unknown as string;
    });
    run('objectName', s => {
      s.cssText = `top: ${ENV}`;
      s.setProperty({ toString: () => 'left' } as unknown as string, '0');
    });
    run('many', s => {
      s.cssText = `top: ${ENV}`;
      for (let i = 0; i < w.MAX_WRITES / 2 + 1; i++) {
        s.color = 'red';
        s.opacity = '1';
      }
    });
    run('typed', (s, e) => {
      s.cssText = `top: ${ENV}`;
      e.attributeStyleMap.set('left', '0');
    });
    run('cleared', s => {
      s.cssText = `top: ${ENV}`;
      s.cssText = '';
    });
    // A rule's block: from its first write, by the text it read as, or by its sheet's (a base of null) where
    // that text does not hold it all. The text of its sheet is trusted until then.
    const style = document.head.appendChild(document.createElement('style'));
    style.textContent = `.a { color: red } .b { padding: ${ENV} 2px; padding-left: 0 } .c {} .d {}`;
    const [a, b, c, d] = Array.from((style.sheet as CSSStyleSheet).cssRules) as CSSStyleRule[];
    const trusted = [a, b, c, d].map(rule => !!rule && w.sourceTrusted(rule.style));
    if (a) a.style.top = '0';
    if (b) b.style.setProperty('color', 'red');
    if (c) c.styleMap.set('top', '0');
    out['rules'] = [a, b, c].map(rule => rule && shown(rule.style));
    out['trusted'] = [trusted, [a, b, c, d].map(rule => !!rule && w.sourceTrusted(rule.style))];
    style.remove();
    return out;
  });
  const ENV = 'env(safe-area-inset-top)';
  assert.deepEqual(records, {
    text: [`padding: ${ENV} 2px; padding-left: 0`],
    plainText: null,
    plain: null,
    name: ['color: red;', `padding=${ENV} 2px`, 'padding-left=0', 'margin-top=1px', 'top=0!', '-color'],
    putForwards: [`top: ${ENV}`],
    again: ['', 'padding=2PX', 'padding=nope'],
    unknownBlock: null,
    object: null,
    objectName: null,
    many: null,
    typed: null,
    cleared: null,
    rules: [['color: red;', 'top=0'], [null, 'color=red'], null],
    trusted: [
      [true, true, true, true],
      [false, false, false, true],
    ],
  });
  await page.close();
});

test('the writes of a record, played again, give the block: its text and the order of its properties', async () => {
  const page = await freshPage();
  const wrong = await page.evaluate(() => {
    const w = (globalThis as unknown as { __written: Written }).__written;
    const names = [
      'padding',
      'padding-top',
      'padding-left',
      'padding-inline-start',
      'padding-inline',
      'padding-block-end',
      'margin',
      'margin-left',
      'inset',
      'top',
      'color',
      '--x',
      'border',
      'border-top-width',
    ];
    const values = [
      'env(safe-area-inset-top)',
      'env(safe-area-inset-left) 2px',
      'max(env(safe-area-inset-top), 8px) 16px',
      'var(--x)',
      'var(--x) env(safe-area-inset-top)',
      '1px',
      '2px 3px',
      'red',
      '',
      'nope(',
      'env(safe-area-inset-top) !important',
    ];
    const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    // A fixed sequence of pseudo-random numbers: the same blocks each run.
    let seed = 12345;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const reading = (style: CSSStyleDeclaration) => `${style.cssText}\n${Array.from(style).join(' ')}`;
    const wrong: string[] = [];
    let recorded = 0;
    for (let block = 0; block < 400; block++) {
      const el = document.body.appendChild(document.createElement('div'));
      const style = el.style as CSSStyleDeclaration & Record<string, string>;
      const steps: string[] = [];
      for (let step = 0, n = 2 + random(10); step < n; step++) {
        const name = names[random(names.length)] ?? '';
        const value = values[random(values.length)] ?? '';
        const how = random(8);
        if (how === 0) style.cssText = `${name}: ${value}; padding-left: 0`;
        else if (how === 1) style.removeProperty(name);
        else if (how === 2) style.setProperty(name, value, 'important');
        else if (how === 3) style.setProperty(name, value);
        else if (how === 4 && !name.startsWith('--')) style[name] = value;
        else if (!name.startsWith('--')) style[camel(name)] = value;
        steps.push(`${how} ${name}: ${value}`);
      }
      const record = w.blockRecord(style);
      if (record) {
        recorded++;
        const again = document.createElement('div').style;
        w.play(record, {
          text: text => (again.cssText = text),
          set: (name, value, priority) => again.setProperty(name, value, priority),
          remove: name => again.removeProperty(name),
        });
        if (reading(again) !== reading(style))
          wrong.push(`${steps.join(' | ')} => ${reading(style)} / ${reading(again)}`);
      }
      el.remove();
    }
    return { wrong, recorded };
  });
  assert.deepEqual(wrong.wrong, []);
  assert.ok(wrong.recorded > 100, `${wrong.recorded} blocks have a record`);
  await page.close();
});

test('the functions that follow the writes behave as the browser has them', async () => {
  const page = await freshPage();
  const same = await page.evaluate(async () => {
    // The functions of a frame nobody watched are the browser's own.
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const native = frame.contentWindow as unknown as typeof globalThis;
    const shown = async (realm: typeof globalThis) => {
      const sheet = new realm.CSSStyleSheet();
      sheet.replaceSync('.a { top: 0 } @media all {} @keyframes k { from { top: 0 } }');
      const [a, media, frames] = Array.from(sheet.cssRules) as [CSSStyleRule, CSSMediaRule, CSSKeyframesRule];
      const caught = (run: () => unknown) => {
        try {
          return String(run());
        } catch (e) {
          return `${(e as Error).name}: ${(e as Error).message}`;
        }
      };
      const style = realm.CSSStyleDeclaration.prototype;
      const functions = [
        realm.CSSStyleSheet.prototype.insertRule,
        realm.CSSStyleSheet.prototype.deleteRule,
        realm.CSSStyleSheet.prototype.addRule,
        realm.CSSStyleSheet.prototype.removeRule,
        realm.CSSStyleSheet.prototype.replaceSync,
        realm.CSSStyleSheet.prototype.replace,
        realm.CSSGroupingRule.prototype.insertRule,
        realm.CSSGroupingRule.prototype.deleteRule,
        realm.CSSStyleRule.prototype.insertRule,
        realm.CSSStyleRule.prototype.deleteRule,
        realm.CSSKeyframesRule.prototype.appendRule,
        realm.CSSKeyframesRule.prototype.deleteRule,
        realm.StylePropertyMap.prototype.set,
        realm.StylePropertyMap.prototype.append,
        realm.StylePropertyMap.prototype.delete,
        realm.StylePropertyMap.prototype.clear,
        style.setProperty,
        style.removeProperty,
        Object.getOwnPropertyDescriptor(style, 'cssText')?.set,
        Object.getOwnPropertyDescriptor(realm.CSSStyleRule.prototype, 'styleMap')?.get,
        Object.getOwnPropertyDescriptor(realm.HTMLElement.prototype, 'attributeStyleMap')?.get,
      ] as ((...args: unknown[]) => unknown)[];
      const el = realm.document.body.appendChild(realm.document.createElement('div'));
      const results = [
        caught(() => sheet.insertRule('.b {}', 1)),
        caught(() => sheet.insertRule('.b {}')),
        caught(() => sheet.insertRule('!')),
        caught(() => sheet.insertRule('.b {}', 9)),
        caught(() => (sheet.insertRule as () => number)()),
        caught(() => media.insertRule('.c {}')),
        caught(() => media.insertRule('}')),
        caught(() => a.insertRule('& {}', 0)),
        caught(() => a.insertRule('.x {}', 5)),
        caught(() => sheet.addRule('.q', 'top: 0')),
        caught(() => sheet.addRule('.q', 'top: 0', 99)),
        caught(() => sheet.deleteRule(0)),
        caught(() => sheet.deleteRule(99)),
        caught(() => sheet.removeRule()),
        caught(() => media.deleteRule(0)),
        caught(() => media.deleteRule(0)),
        caught(() => a.deleteRule(0)),
        caught(() => frames.appendRule('to { top: 1px }')),
        caught(() => frames.deleteRule('from')),
        caught(() => el.style.setProperty('top', '1px', 'nope')),
        caught(() => el.style.setProperty('top', '1px', 'IMPORTANT')),
        caught(() => (el.style.setProperty as (name: string) => void)('top')),
        caught(() => el.style.removeProperty('top')),
        caught(() => el.style.removeProperty('nope')),
        caught(() => (el.style.cssText = 'top: 2px')),
        caught(() => realm.CSSStyleDeclaration.prototype.setProperty.call({}, 'top', '0')),
        caught(() => realm.getComputedStyle(el).setProperty('top', '0')),
        caught(() => (realm.getComputedStyle(el).cssText = 'top: 0')),
        caught(() => el.attributeStyleMap.set('left', '1px')),
        caught(() => el.attributeStyleMap.set('left', 'nope')),
        caught(() => a.styleMap.set('left', '1px')),
        caught(() => el.attributeStyleMap === el.attributeStyleMap),
        caught(() => realm.CSSStyleSheet.prototype.replaceSync.call({}, '')),
        el.style.cssText,
        Array.from(sheet.cssRules, rule => rule.cssText).join(' '),
        caught(() => sheet.replaceSync('.z {}')),
        String((await sheet.replace('.y {}')) === sheet),
        Array.from(sheet.cssRules, rule => rule.cssText).join(' '),
      ];
      el.remove();
      return {
        shape: functions.map(f => [
          f.name,
          f.length,
          typeof f,
          'prototype' in f,
          caught(() => Reflect.construct(f, [])),
        ]),
        results,
      };
    };
    const out = { ours: await shown(globalThis), browser: await shown(native) };
    frame.remove();
    return out;
  });
  assert.deepEqual(same.ours, same.browser);
  assert.deepEqual(same.browser.shape[0]?.slice(0, 4), ['insertRule', 1, 'function', false]);
  await page.close();
});

test('a property read or written by name does what the browser does for the name', async () => {
  const page = await freshPage();
  const r = await page.evaluate(async () => {
    // A frame nobody watched, in standards mode as the page is: a quirks-mode document takes other values.
    const frame = document.createElement('iframe');
    frame.srcdoc = '<!doctype html><body>';
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve));
    document.body.append(frame);
    await loaded;
    const native = frame.contentWindow as unknown as typeof globalThis;
    // Every name the browser lists for a style, with dashes too, and `Webkit` for `webkit`; and some it has not.
    const listed = Object.getOwnPropertyNames(native.document.createElement('div').style);
    const dashed = (name: string) => name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`).replace(/^webkit-/, '-webkit-');
    const names = [
      ...new Set([
        ...listed,
        ...listed.map(dashed),
        ...listed.filter(name => name.startsWith('webkit')).map(name => `W${name.slice(1)}`),
        'Padding',
        'padding-Top',
        'PADDING',
        'padding_top',
        'webkit',
        'webkitX',
        'Webkittransform',
        'cssFloat',
        'float',
        'cssText',
        'length',
        'parentRule',
        '--x',
        'notAProperty',
        '0',
      ]),
    ];
    const values: unknown[] = [
      'inherit',
      '1px',
      'red',
      '',
      null,
      undefined,
      0,
      1,
      0.5,
      -1,
      1e21,
      NaN,
      true,
      'env(safe-area-inset-top) 2px',
      'var(--x)',
      '1px !important',
      '1px; color: red',
      ' 3px ',
      { toString: () => '2px' },
      Symbol('s'),
    ];
    const START = 'color: blue; padding: 9px; opacity: 0.25; z-index: 7; line-height: 3; float: left';
    const outcome = (realm: typeof globalThis, name: string, value: unknown) => {
      const style = realm.document.createElement('div').style as CSSStyleDeclaration & Record<string, unknown>;
      style.cssText = START;
      let error = '';
      try {
        style[name] = value;
      } catch (e) {
        error = (e as Error).name;
      }
      const read = typeof style[name] === 'function' ? 'function' : String(style[name]);
      return `${error}|${style.cssText}|${read}|${name in style}`;
    };
    const differences: string[] = [];
    for (const name of names)
      values.forEach((value, i) => {
        const ours = outcome(globalThis, name, value);
        const browser = outcome(native, name, value);
        if (ours !== browser) differences.push(`${name} = #${i}: ${ours} / ${browser}`);
      });
    // What a page can tell: the names are the prototype's, not each style's own.
    const seen = (realm: typeof globalThis) => {
      const el = realm.document.createElement('div');
      const style = el.style as CSSStyleDeclaration & Record<string, unknown>;
      style.cssText = 'padding: 3px';
      const proto = realm.CSSStyleDeclaration.prototype;
      const made = Object.create(proto) as Record<string, unknown>;
      made['color'] = 'red';
      let keys = 0;
      for (const key in style) if (key) keys++;
      let computed = '';
      try {
        (realm.getComputedStyle(realm.document.body) as unknown as Record<string, unknown>)['color'] = 'red';
      } catch (e) {
        computed = `${(e as Error).name}: ${(e as Error).message}`;
      }
      const set = Object.getOwnPropertyDescriptor(proto, 'padding')?.set;
      return {
        own: Object.hasOwn(style, 'padding'),
        descriptor: !!Object.getOwnPropertyDescriptor(style, 'padding'),
        onPrototype: 'padding' in proto,
        prototypeNames: Object.getOwnPropertyNames(proto).length > 100,
        setter: set ? [set.name, set.length, String(set).replace(/\s+/g, ' ')] : null,
        keys: Object.keys(style).length > 100,
        copied: Object.keys({ ...style }).length > 100,
        forIn: keys > 100,
        made: [Object.hasOwn(made, 'color'), made['color'], made['padding'] ?? null],
        prototypeRead: (proto as unknown as Record<string, unknown>)['padding'] ?? null,
        assigned: Object.assign(realm.document.createElement('div').style, { color: 'red', paddingTop: '2px' }).cssText,
        json: JSON.stringify(style).includes('"paddingTop":"3px"'),
        computed,
      };
    };
    const out = { differences, count: names.length, ours: seen(globalThis), browser: seen(native) };
    frame.remove();
    return out;
  });
  assert.ok(r.count > 1400, `${r.count} names`);
  assert.deepEqual(r.differences, []);
  // The differences a page can see (docs/limitations.md): the rest is the same.
  const { own, descriptor, onPrototype, prototypeNames, setter, copied, computed, ...same } = r.ours;
  const browser = r.browser;
  assert.deepEqual(same, {
    keys: browser.keys,
    forIn: browser.forIn,
    made: browser.made,
    prototypeRead: browser.prototypeRead,
    assigned: browser.assigned,
    json: browser.json,
  });
  assert.deepEqual(
    [browser.own, browser.descriptor, browser.onPrototype, browser.prototypeNames, browser.setter, browser.copied],
    [true, true, false, false, null, true]
  );
  assert.deepEqual([own, descriptor, onPrototype, prototypeNames, copied], [false, false, true, true, false]);
  assert.deepEqual(setter, ['setProperty', 2, 'function () { [native code] }']);
  assert.match(browser.computed, /^NoModificationAllowedError: Failed to set a named property 'color'/);
  assert.match(computed, /^NoModificationAllowedError: Failed to execute 'setProperty'/);
});
