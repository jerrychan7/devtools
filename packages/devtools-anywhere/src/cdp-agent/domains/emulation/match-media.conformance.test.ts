// Emulation of media features as matchMedia reports them, and the change events of the MediaQueryLists
// it makes. Chrome and we emulate, measure and clear in turn on the same page, as
// emulation.conformance.test.ts does. The MediaQueryLists are made in the page after openPage has loaded
// the probe, which hooks matchMedia. Not compared, as accepted differences: event.isTrusted, and the timing
// of events within a frame (they are read after two frames).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

/** The listeners a MediaQueryList gets: `add1` and `add2` are plain ones, `capture` is added with capture set. */
type Listener = 'add1' | 'onchange' | 'capture' | 'add2';

type Scheme = 'dark' | 'light';

/** A change event, as the listener that got it recorded it. */
interface Change {
  /** The name the test gave the MediaQueryList. */
  label: string;
  listener: Listener;
  type: string;
  media: string;
  matches: boolean;
  /** The event's constructor's name: MediaQueryListEvent in Chrome. */
  event: string;
  /** Whether the event's target is the MediaQueryList the listener is on. */
  atTarget: boolean;
}

declare global {
  interface Window {
    /** The change events of the MediaQueryLists the tests make, in the order their listeners ran. */
    __mqChanges: Change[];
    /** Makes a MediaQueryList of `realm` (the page's own by default) for `query`, its events recorded as `label`. */
    __mqWatch(label: string, query: string, order?: Listener[], realm?: Window): void;
    /** The MediaQueryLists the tests watch, held here so that they do not depend on the garbage collector. */
    __mqKept: MediaQueryList[];
    /** What the listener of a MediaQueryList nobody holds got, as it wrote it. */
    __mqNoReference: [string, boolean][];
    /** A WeakRef to a MediaQueryList nobody holds: the garbage collector must take it, or the test proves nothing. */
    __mqControl: WeakRef<MediaQueryList>;
    /** The animation frames the page has run, counted by the loop startFrames starts. */
    __frames: number;
  }
}

/** Installed in each test's page, once openPage has loaded the probe. */
function install(): void {
  const changes: Change[] = [];
  const kept: MediaQueryList[] = [];
  window.__mqChanges = changes;
  window.__mqKept = kept;
  window.__mqNoReference = [];
  window.__mqWatch = (label, query, order = ['add1', 'onchange', 'capture', 'add2'], realm = window) => {
    const mql = realm.matchMedia(query);
    kept.push(mql);
    const record = (listener: Listener) => (e: MediaQueryListEvent) => {
      changes.push({
        label,
        listener,
        type: e.type,
        media: e.media,
        matches: e.matches,
        event: e.constructor.name,
        atTarget: e.target === mql,
      });
    };
    for (const listener of order) {
      if (listener === 'onchange') mql.onchange = record(listener);
      else mql.addEventListener('change', record(listener), listener === 'capture');
    }
  };
}

let env: Env | undefined;

setUpAndTearDown(
  async () => {
    env = await launch();
  },
  () => env?.close()
);

/** A page of the test's own, with the probe loaded and the recorder installed. */
async function open(): Promise<TestPage> {
  assert.ok(env);
  const t = await openPage(env, []);
  await t.page.evaluate(install);
  return t;
}

/** Chrome's side, then ours: `run` emulates, measures and clears on the side it is given. */
async function inTurn<T>(t: TestPage, run: (side: Side) => Promise<T>): Promise<{ chrome: T; ours: T }> {
  const chrome = await run(t.chrome);
  const ours = await run(t.ours);
  return { chrome, ours };
}

/** Two frames and a short settle: the rendering step that reports media changes has run by then. */
const settle = (t: TestPage) =>
  t.page.evaluate(
    () =>
      new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))))
  );

/** Whether each query matches in the page now. */
const matchesNow = (t: TestPage, queries: string[]) =>
  t.page.evaluate(qs => qs.map(q => matchMedia(q).matches), queries);

/**
 * The color scheme the page does not have by default. Some machines' Chrome defaults to dark, others to light:
 * emulating the scheme the page already has changes nothing, so the tests emulate this one.
 */
async function otherScheme(t: TestPage): Promise<Scheme> {
  const [darkNow] = await matchesNow(t, ['(prefers-color-scheme: dark)']);
  return darkNow ? 'light' : 'dark';
}

/** The change events recorded so far, taken out of the page. */
const takeChanges = (t: TestPage) => t.page.evaluate(() => window.__mqChanges.splice(0));

/** Makes a MediaQueryList in the page, with its events recorded (see install). */
const watch = (t: TestPage, label: string, query: string, order?: Listener[]) =>
  t.page.evaluate(
    (label: string, query: string, order?: Listener[]) => window.__mqWatch(label, query, order),
    label,
    query,
    order
  );

/** Each change as `label.listener=matches`, in the order it came. */
const brief = (changes: Change[]) => changes.map(c => `${c.label}.${c.listener}=${c.matches}`);

/** The events of `label`'s listeners, in the order `order` names them, each with the matches it got. */
const inOrder = (label: string, order: Listener[], matches: boolean) =>
  order.map(listener => `${label}.${listener}=${matches}`);

/** The four listeners of a MediaQueryList made by `watch`: in the order they were added, capture included. */
const fourOf = (label: string, matches: boolean) => inOrder(label, ['add1', 'onchange', 'capture', 'add2'], matches);

const schemeEmulation = (scheme: Scheme): Protocol.Emulation.SetEmulatedMediaRequest => ({
  features: [{ name: 'prefers-color-scheme', value: scheme }],
});
const DARK: Protocol.Emulation.SetEmulatedMediaRequest = {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
};
const LIGHT: Protocol.Emulation.SetEmulatedMediaRequest = {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
};
const PRINT: Protocol.Emulation.SetEmulatedMediaRequest = { media: 'print' };
const REDUCE: Protocol.Emulation.SetEmulatedMediaRequest = {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
};
/** Emulates nothing: the page's own media again. */
const NONE: Protocol.Emulation.SetEmulatedMediaRequest = {};

/**
 * Emulations, the queries measured under each, and the matches Chrome gives them once emulated. Each is measured
 * first under `against`, an emulation of the same feature with another value: the page may already be what the case
 * emulates (a machine in dark mode has a dark page), and then the case would prove nothing.
 */
const CASES: {
  name: string;
  params: Protocol.Emulation.SetEmulatedMediaRequest;
  against: Protocol.Emulation.SetEmulatedMediaRequest;
  queries: string[];
  matches: boolean[];
}[] = [
  {
    name: 'prefers-color-scheme: dark',
    params: DARK,
    against: LIGHT,
    queries: ['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)', '(min-width: 1px)'],
    matches: [true, false, true],
  },
  {
    name: 'prefers-color-scheme: light',
    params: LIGHT,
    against: DARK,
    queries: ['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)', '(min-width: 1px)'],
    matches: [false, true, true],
  },
  {
    name: 'media: print',
    params: PRINT,
    against: { media: 'screen' },
    queries: ['print', 'not print', 'only screen and (min-width: 1px)', '(min-width: 1px)'],
    matches: [true, false, false, true],
  },
  {
    name: 'color-gamut: p3',
    params: { features: [{ name: 'color-gamut', value: 'p3' }] },
    against: { features: [{ name: 'color-gamut', value: 'srgb' }] },
    queries: ['(color-gamut: srgb)', '(color-gamut: p3)', '(color-gamut: rec2020)', '(min-width: 1px)'],
    matches: [true, true, false, true],
  },
  {
    name: 'prefers-reduced-motion: reduce',
    params: REDUCE,
    against: { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] },
    queries: [
      '(prefers-reduced-motion)',
      '(prefers-reduced-motion: reduce)',
      '(prefers-reduced-motion: no-preference)',
      '(min-width: 1px)',
    ],
    matches: [true, true, false, true],
  },
];

for (const c of CASES) {
  test(`matches under ${c.name}: right after the call, and after two frames`, async () => {
    const t = await open();
    try {
      const { chrome, ours } = await inTurn(t, async side => {
        const base = await matchesNow(t, c.queries);
        await side.send('Emulation.setEmulatedMedia', c.against);
        await settle(t);
        const before = await matchesNow(t, c.queries);
        await side.send('Emulation.setEmulatedMedia', c.params);
        const sync = await matchesNow(t, c.queries);
        await settle(t);
        const later = await matchesNow(t, c.queries);
        await side.send('Emulation.setEmulatedMedia', NONE);
        await settle(t);
        return { base, before, sync, later, cleared: await matchesNow(t, c.queries) };
      });
      // The emulation must change what `against` gave, on both sides: otherwise a no-op would pass.
      assert.notDeepEqual(chrome.before, c.matches, 'Chrome: the page under `against` already matches the case');
      assert.notDeepEqual(ours.before, c.matches, 'ours: the page under `against` already matches the case');
      assert.deepEqual(chrome.later, c.matches);
      assert.deepEqual(chrome.sync, c.matches);
      assert.deepEqual(chrome.cleared, chrome.base);
      assert.deepEqual(ours, chrome);
    } finally {
      await t.page.close();
    }
  });
}

/**
 * Queries whose words the rewrite reads as CSS does (escapes, case, spacing), and queries with a name or a value
 * the emulation does not know, which it leaves to the browser. Chrome's answers are the reference. Each is measured
 * first under `against`, as CASES are.
 */
const SPELLINGS: {
  name: string;
  params: Protocol.Emulation.SetEmulatedMediaRequest;
  against: Protocol.Emulation.SetEmulatedMediaRequest;
  queries: string[];
  matches: boolean[];
}[] = [
  {
    name: 'prefers-color-scheme: dark',
    params: DARK,
    against: LIGHT,
    queries: [
      '(prefers-color-scheme: d\\61rk)',
      '(prefers\\2d color-scheme: dark)',
      '(PREFERS-COLOR-SCHEME: DARK)',
      '(prefers-color-scheme:dark)',
      '(prefers-color-scheme: sepia)',
      '(prefers-color-scheme: dark), (foo: bar)',
      '(prefers-color-scheme: dark) and (foo: bar)',
      'not (prefers-color-scheme: sepia)',
      '(foo)',
      '(foo: bar)',
      '(prefers-reduced-data)',
      '(prefers-reduced-data: reduce)',
    ],
    matches: [true, true, true, true, false, true, false, false, false, false, false, false],
  },
  {
    name: 'media: print',
    params: PRINT,
    against: { media: 'screen' },
    queries: [
      'PRINT',
      'SCREEN',
      'only print',
      'not screen',
      'print and (min-width: 1px)',
      'screen and (min-width: 1px)',
      'print, screen',
      'print and (foo: bar)',
      'only screen and (prefers-color-scheme: dark)',
    ],
    matches: [true, false, true, true, true, false, true, false, false],
  },
  {
    name: 'prefers-reduced-motion: reduce',
    params: REDUCE,
    against: { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] },
    queries: [
      // `\65 ` is `e`: the space ends the escape, while `\65d` would be another code point.
      '(prefers-reduced-motion: r\\65 duce)',
      '(PREFERS-REDUCED-MOTION)',
      '(prefers-reduced-motion: sepia)',
      '(prefers-reduced-motion: no-preference)',
      'not (prefers-reduced-motion: sepia)',
    ],
    matches: [true, true, false, false, false],
  },
];

for (const c of SPELLINGS) {
  test(`matches under ${c.name}: spellings and unknown names or values read as Chrome reads them`, async () => {
    const t = await open();
    try {
      const { chrome, ours } = await inTurn(t, async side => {
        await side.send('Emulation.setEmulatedMedia', c.against);
        await settle(t);
        const before = await matchesNow(t, c.queries);
        await side.send('Emulation.setEmulatedMedia', c.params);
        const sync = await matchesNow(t, c.queries);
        await settle(t);
        const later = await matchesNow(t, c.queries);
        await side.send('Emulation.setEmulatedMedia', NONE);
        await settle(t);
        return { before, sync, later, cleared: await matchesNow(t, c.queries) };
      });
      // The emulation must change what `against` gave, on both sides: otherwise a no-op would pass.
      assert.notDeepEqual(chrome.before, c.matches, 'Chrome: the page under `against` already matches the case');
      assert.notDeepEqual(ours.before, c.matches, 'ours: the page under `against` already matches the case');
      assert.deepEqual(chrome.later, c.matches);
      assert.deepEqual(chrome.sync, c.matches);
      assert.deepEqual(ours, chrome);
    } finally {
      await t.page.close();
    }
  });
}

/** One step of `sessionsOf`: a call of one of the two sessions (0 or 1), or the end of one. */
type SessionStep = { call: 0 | 1; params: Protocol.Emulation.SetEmulatedMediaRequest } | { end: 0 | 1 };

/**
 * Plays `steps` with two sessions of `side` (Chrome's own CDP sessions, or two of ours), and reads `queries` after
 * each step. Both sessions end at the last step, so that nothing is left emulated.
 */
async function sessionsOf(t: TestPage, side: Side, steps: SessionStep[], queries: string[]): Promise<boolean[][]> {
  let call: (which: 0 | 1, params: Protocol.Emulation.SetEmulatedMediaRequest) => Promise<unknown>;
  let end: (which: 0 | 1) => Promise<unknown>;
  if (side === t.chrome) {
    const cdp = [await t.page.createCDPSession(), await t.page.createCDPSession()] as const;
    call = (which, params) => cdp[which].send('Emulation.setEmulatedMedia', params);
    end = which => cdp[which].detach();
  } else {
    await t.page.evaluate(() => {
      window.__sessions = [window.DevtoolsAnywhere.createCdpSession(), window.DevtoolsAnywhere.createCdpSession()];
    });
    call = (which, params) =>
      t.page.evaluate(
        (which, params) => window.__sessions?.[which]?.call('Emulation.setEmulatedMedia', params),
        which,
        params
      );
    end = which => t.page.evaluate(which => window.__sessions?.[which]?.reset(), which);
  }
  const reads: boolean[][] = [];
  const ended = new Set<0 | 1>();
  for (const step of steps) {
    if ('call' in step) await call(step.call, step.params);
    else {
      ended.add(step.end);
      await end(step.end);
    }
    await settle(t);
    reads.push(await matchesNow(t, queries));
  }
  for (const which of [0, 1] as const) if (!ended.has(which)) await end(which);
  return reads;
}

test('two sessions: matchMedia gives the features and the media type each session set, as Chrome does', async () => {
  const t = await open();
  try {
    // The scheme the page does not have: each feature changes its query, whatever the machine's default is.
    const emulated = await otherScheme(t);
    const queries = [`(prefers-color-scheme: ${emulated})`, 'print', 'screen'];
    const steps: SessionStep[] = [
      { call: 0, params: schemeEmulation(emulated) },
      // Sets the media type; the features of the other session stay.
      { call: 1, params: { media: 'print' } },
      // Ends: its feature goes, and so does the media type, whichever session set it.
      { end: 0 },
      { call: 1, params: schemeEmulation(emulated) },
      { end: 1 },
    ];
    const chrome = await sessionsOf(t, t.chrome, steps, queries);
    const ours = await sessionsOf(t, t.ours, steps, queries);
    assert.deepEqual(chrome, [
      [true, false, true],
      [true, true, false],
      [false, false, true],
      [true, false, true],
      [false, false, true],
    ]);
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('change events: once for each listener, and only for the queries whose matches changed', async () => {
  const t = await open();
  try {
    const scheme = await otherScheme(t);
    const WATCHED: [label: string, query: string][] = [
      ['dark', '(prefers-color-scheme: dark)'],
      ['light', '(prefers-color-scheme: light)'],
      ['print', 'print'],
      ['motion', '(prefers-reduced-motion)'],
      ['width', '(min-width: 1px)'],
    ];
    for (const [label, query] of WATCHED) await watch(t, label, query);
    const { chrome, ours } = await inTurn(t, async side => {
      const steps: Change[][] = [];
      for (const params of [schemeEmulation(scheme), NONE, PRINT, NONE, REDUCE, NONE]) {
        await side.send('Emulation.setEmulatedMedia', params);
        await settle(t);
        steps.push(await takeChanges(t));
      }
      return steps;
    });
    assert.deepEqual(chrome.map(brief), [
      [...fourOf('dark', scheme === 'dark'), ...fourOf('light', scheme === 'light')],
      [...fourOf('dark', scheme !== 'dark'), ...fourOf('light', scheme !== 'light')],
      fourOf('print', true),
      fourOf('print', false),
      fourOf('motion', true),
      fourOf('motion', false),
    ]);
    // Each event is a MediaQueryListEvent at its own MediaQueryList, carrying the query as it was made.
    for (const change of chrome.flat()) {
      assert.equal(change.type, 'change');
      assert.equal(change.event, 'MediaQueryListEvent');
      assert.ok(change.atTarget);
      assert.equal(change.media, WATCHED.find(([label]) => label === change.label)?.[1]);
    }
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test("change events: a MediaQueryList's listeners run in the order they were added, capture included", async () => {
  const t = await open();
  try {
    const scheme = await otherScheme(t);
    await watch(t, 'a', '(prefers-color-scheme: dark)', ['add1', 'onchange', 'capture', 'add2']);
    await watch(t, 'b', '(prefers-color-scheme: dark)', ['capture', 'add2', 'onchange', 'add1']);
    const { chrome, ours } = await inTurn(t, async side => {
      await side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme));
      await settle(t);
      const fired = await takeChanges(t);
      await side.send('Emulation.setEmulatedMedia', NONE);
      await settle(t);
      await takeChanges(t);
      return fired;
    });
    const dark = scheme === 'dark';
    assert.deepEqual(brief(chrome), [
      ...inOrder('a', ['add1', 'onchange', 'capture', 'add2'], dark),
      ...inOrder('b', ['capture', 'add2', 'onchange', 'add1'], dark),
    ]);
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('change events: setting the same emulation again fires nothing', async () => {
  const t = await open();
  try {
    const scheme = await otherScheme(t);
    await watch(t, 'dark', '(prefers-color-scheme: dark)');
    await watch(t, 'light', '(prefers-color-scheme: light)');
    const { chrome, ours } = await inTurn(t, async side => {
      await side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme));
      await settle(t);
      const first = await takeChanges(t);
      await side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme));
      await settle(t);
      const again = await takeChanges(t);
      await side.send('Emulation.setEmulatedMedia', NONE);
      await settle(t);
      await takeChanges(t);
      return { first: brief(first), again: brief(again) };
    });
    assert.deepEqual(chrome.first, [...fourOf('dark', scheme === 'dark'), ...fourOf('light', scheme === 'light')]);
    assert.deepEqual(chrome.again, []);
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('change events: clearing with no features and no media restores the matches and fires back', async () => {
  const t = await open();
  try {
    const scheme = await otherScheme(t);
    const QUERIES = ['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)'];
    await watch(t, 'dark', '(prefers-color-scheme: dark)');
    await watch(t, 'light', '(prefers-color-scheme: light)');
    const { chrome, ours } = await inTurn(t, async side => {
      const before = await matchesNow(t, QUERIES);
      await side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme));
      await settle(t);
      const emulated = await matchesNow(t, QUERIES);
      await takeChanges(t);
      await side.send('Emulation.setEmulatedMedia', { features: [], media: '' });
      await settle(t);
      return {
        before,
        emulated,
        restored: await matchesNow(t, QUERIES),
        fired: brief(await takeChanges(t)),
      };
    });
    assert.deepEqual(chrome.emulated, [scheme === 'dark', scheme === 'light']);
    assert.deepEqual(chrome.restored, chrome.before);
    assert.deepEqual(chrome.fired, [...fourOf('dark', scheme !== 'dark'), ...fourOf('light', scheme !== 'light')]);
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('change events: a MediaQueryList nobody holds, with a listener, still fires', async () => {
  const t = await open();
  try {
    const scheme = await otherScheme(t);
    await t.page.evaluate(() => {
      window.__mqControl = new WeakRef(matchMedia('(min-width: 2px)'));
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        window.__mqNoReference.push([e.media, e.matches]);
      });
    });
    const cdp = await t.page.createCDPSession();
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
    assert.equal(
      await t.page.evaluate(() => window.__mqControl.deref() === undefined),
      true,
      'the garbage collector did not take a MediaQueryList nobody holds'
    );
    const { chrome, ours } = await inTurn(t, async side => {
      await side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme));
      await settle(t);
      const fired = await t.page.evaluate(() => window.__mqNoReference.splice(0));
      await side.send('Emulation.setEmulatedMedia', NONE);
      await settle(t);
      return { fired, restored: await t.page.evaluate(() => window.__mqNoReference.splice(0)) };
    });
    assert.deepEqual(chrome, {
      fired: [['(prefers-color-scheme: dark)', scheme === 'dark']],
      restored: [['(prefers-color-scheme: dark)', scheme !== 'dark']],
    });
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('a width change is still reported while another feature is emulated', async () => {
  const t = await open();
  try {
    const scheme = await otherScheme(t);
    await watch(t, 'wide', '(min-width: 900px)');
    await watch(t, 'scheme-wide', `(prefers-color-scheme: ${scheme}) and (min-width: 900px)`);
    await watch(t, 'scheme', `(prefers-color-scheme: ${scheme})`);
    const { chrome, ours } = await inTurn(t, async side => {
      const steps: string[][] = [];
      const step = async (act: () => Promise<unknown>) => {
        await act();
        await settle(t);
        steps.push(brief(await takeChanges(t)));
      };
      await step(() => side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme)));
      await step(() => t.page.setViewport({ width: 1000, height: 600 }));
      await step(() => t.page.setViewport({ width: 800, height: 600 }));
      await step(() => side.send('Emulation.setEmulatedMedia', NONE));
      return steps;
    });
    assert.deepEqual(chrome, [
      fourOf('scheme', true),
      [...fourOf('wide', true), ...fourOf('scheme-wide', true)],
      [...fourOf('wide', false), ...fourOf('scheme-wide', false)],
      fourOf('scheme', false),
    ]);
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

/** Counts the page's animation frames: a frame that comes between two calls shows as a change of the count. */
const startFrames = (t: TestPage) =>
  t.page.evaluate(() => {
    window.__frames = 0;
    const loop = () => {
      window.__frames++;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
const frameCount = (t: TestPage) => t.page.evaluate(() => window.__frames);

/**
 * Makes `changes` back to back, so that they all reach the page before its next frame. `prepare` puts the page in
 * the state they start from, and runs before every try: a try in which a frame came between the changes is made
 * again, so that they always land in one frame. The caller settles and reads the record afterwards.
 */
async function inOneFrame(
  t: TestPage,
  prepare: () => Promise<void>,
  changes: (() => Promise<unknown>)[]
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await prepare();
    const before = await frameCount(t);
    await Promise.all(changes.map(change => change()));
    if ((await frameCount(t)) === before) return;
    assert.ok(attempt < 20, 'the changes kept landing in different frames');
  }
}

test('a width change in the frame its emulation is set: one change event', async () => {
  const t = await open();
  try {
    await startFrames(t);
    const scheme = await otherScheme(t);
    await watch(t, 'wide', `(prefers-color-scheme: ${scheme}) and (min-width: 900px)`);
    const { chrome, ours } = await inTurn(t, async side => {
      // Emulated, the query holds at 1000px and not at 800px: both changes come in one frame, so one event.
      const prepare = async () => {
        await side.send('Emulation.setEmulatedMedia', NONE);
        await t.page.setViewport({ width: 800, height: 600 });
        await settle(t);
        await takeChanges(t);
      };
      await inOneFrame(t, prepare, [
        () => side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme)),
        () => t.page.setViewport({ width: 1000, height: 600 }),
      ]);
      await settle(t);
      const fired = brief(await takeChanges(t));
      await prepare();
      return fired;
    });
    assert.deepEqual(chrome, fourOf('wide', true));
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('an emulation undone in the frame it is set, by a width change or by clearing it: no change event', async () => {
  const t = await open();
  try {
    await startFrames(t);
    const scheme = await otherScheme(t);
    await watch(t, 'wide', `(prefers-color-scheme: ${scheme}) and (min-width: 900px)`);
    const { chrome, ours } = await inTurn(t, async side => {
      // At 1000px the emulated query holds: each case starts from there.
      const prepare = async () => {
        await side.send('Emulation.setEmulatedMedia', NONE);
        await t.page.setViewport({ width: 1000, height: 600 });
        await settle(t);
        await takeChanges(t);
      };
      await inOneFrame(t, prepare, [
        () => side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme)),
        () => t.page.setViewport({ width: 800, height: 600 }),
      ]);
      await settle(t);
      const byWidth = brief(await takeChanges(t));
      await prepare();
      await inOneFrame(t, prepare, [
        () => side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme)),
        () => side.send('Emulation.setEmulatedMedia', NONE),
      ]);
      await settle(t);
      const byClearing = brief(await takeChanges(t));
      await prepare();
      return { byWidth, byClearing };
    });
    assert.deepEqual(chrome, { byWidth: [], byClearing: [] });
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('a width change and an emulation cleared in one frame: one change event', async () => {
  const t = await open();
  try {
    await startFrames(t);
    const scheme = await otherScheme(t);
    await watch(t, 'wide', `(prefers-color-scheme: ${scheme}) and (min-width: 900px)`);
    const { chrome, ours } = await inTurn(t, async side => {
      // Emulated at 1000px, the query holds; then, in one frame, narrower and with no emulation.
      const prepare = async () => {
        await side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme));
        await t.page.setViewport({ width: 1000, height: 600 });
        await settle(t);
        await takeChanges(t);
      };
      await inOneFrame(t, prepare, [
        () => t.page.setViewport({ width: 800, height: 600 }),
        () => side.send('Emulation.setEmulatedMedia', NONE),
      ]);
      await settle(t);
      const fired = brief(await takeChanges(t));
      await side.send('Emulation.setEmulatedMedia', NONE);
      await t.page.setViewport({ width: 800, height: 600 });
      await settle(t);
      await takeChanges(t);
      return fired;
    });
    assert.deepEqual(chrome, fourOf('wide', false));
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('a list the emulation does not touch reports its own change once, in a frame an emulation is set', async () => {
  const t = await open();
  try {
    await startFrames(t);
    const scheme = await otherScheme(t);
    await watch(t, 'plain', '(min-width: 900px)');
    await watch(t, 'emulated', `(prefers-color-scheme: ${scheme}) and (min-width: 900px)`);
    const { chrome, ours } = await inTurn(t, async side => {
      const prepare = async () => {
        await side.send('Emulation.setEmulatedMedia', NONE);
        await t.page.setViewport({ width: 800, height: 600 });
        await settle(t);
        await takeChanges(t);
      };
      await inOneFrame(t, prepare, [
        () => side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme)),
        () => t.page.setViewport({ width: 1000, height: 600 }),
      ]);
      await settle(t);
      const fired = brief(await takeChanges(t));
      await prepare();
      return fired;
    });
    // Each list's four listeners get its change once, whatever the order of the lists within the frame.
    const once = [...fourOf('plain', true), ...fourOf('emulated', true)].sort();
    assert.deepEqual([...chrome].sort(), once);
    assert.deepEqual([...ours].sort(), [...chrome].sort());
  } finally {
    await t.page.close();
  }
});

test('the print media type: matches and change events', async () => {
  const t = await open();
  try {
    const QUERIES = ['print', 'screen', 'not print', 'all'];
    await watch(t, 'print', 'print');
    await watch(t, 'screen', 'screen');
    await watch(t, 'not-print', 'not print');
    await watch(t, 'all', 'all');
    const { chrome, ours } = await inTurn(t, async side => {
      await side.send('Emulation.setEmulatedMedia', PRINT);
      await settle(t);
      const emulated = await matchesNow(t, QUERIES);
      const fired = brief(await takeChanges(t));
      await side.send('Emulation.setEmulatedMedia', NONE);
      await settle(t);
      return {
        emulated,
        fired,
        restored: await matchesNow(t, QUERIES),
        back: brief(await takeChanges(t)),
      };
    });
    assert.deepEqual(chrome.emulated, [true, false, false, true]);
    assert.deepEqual(chrome.fired, [
      ...fourOf('print', true),
      ...fourOf('screen', false),
      ...fourOf('not-print', false),
    ]);
    assert.deepEqual(chrome.restored, [false, true, true, true]);
    assert.deepEqual(chrome.back, [...fourOf('print', false), ...fourOf('screen', true), ...fourOf('not-print', true)]);
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('a same-origin iframe: its matchMedia and its change events follow the emulation', async () => {
  const t = await open();
  try {
    const scheme = await otherScheme(t);
    const QUERIES = ['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)'];
    await t.page.evaluate(scheme => {
      const frame = document.createElement('iframe');
      frame.id = 'same';
      document.body.append(frame);
      if (!frame.contentWindow) throw new Error('the iframe has no window');
      window.__mqWatch('frame-scheme', `(prefers-color-scheme: ${scheme})`, undefined, frame.contentWindow);
    }, scheme);
    const inFrame = (queries: string[]) =>
      t.page.evaluate(qs => {
        const win = document.querySelector<HTMLIFrameElement>('iframe#same')?.contentWindow;
        if (!win) throw new Error('the iframe has no window');
        return qs.map(q => win.matchMedia(q).matches);
      }, queries);
    const { chrome, ours } = await inTurn(t, async side => {
      const before = await inFrame(QUERIES);
      await side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme));
      const sync = await inFrame(QUERIES);
      await settle(t);
      const later = await inFrame(QUERIES);
      const fired = brief(await takeChanges(t));
      await side.send('Emulation.setEmulatedMedia', NONE);
      await settle(t);
      return { before, sync, later, fired, cleared: await inFrame(QUERIES), back: brief(await takeChanges(t)) };
    });
    assert.deepEqual(chrome.later, [scheme === 'dark', scheme === 'light']);
    assert.deepEqual(chrome.sync, [scheme === 'dark', scheme === 'light']);
    assert.deepEqual(chrome.cleared, chrome.before);
    assert.deepEqual(chrome.fired, fourOf('frame-scheme', true));
    assert.deepEqual(chrome.back, fourOf('frame-scheme', false));
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('a same-origin iframe made while the emulation is on matches it from the start', async () => {
  const t = await open();
  try {
    const scheme = await otherScheme(t);
    const { chrome, ours } = await inTurn(t, async side => {
      await side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme));
      const inNew = await t.page.evaluate(async () => {
        const frame = document.createElement('iframe');
        frame.srcdoc = '<!doctype html><p>made under the emulation</p>';
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
        document.body.append(frame);
        await loaded;
        const win = frame.contentWindow;
        const values = win
          ? ['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)'].map(q => win.matchMedia(q).matches)
          : [];
        frame.remove();
        return values;
      });
      await side.send('Emulation.setEmulatedMedia', NONE);
      await settle(t);
      return inNew;
    });
    assert.deepEqual(chrome, [scheme === 'dark', scheme === 'light']);
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

/**
 * What a script sees of matchMedia and of MediaQueryList: the same in a page without the probe, where
 * matchMedia is native.
 */
function looks() {
  const threw = (call: () => unknown) => {
    try {
      call();
      return { name: 'none', message: '' };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      return { name: error.name, message: error.message };
    }
  };
  const asFunction = matchMedia as unknown as (query?: unknown) => MediaQueryList;
  const asNothing = matchMedia as unknown as () => unknown;
  const getter = Object.getOwnPropertyDescriptor(MediaQueryList.prototype, 'matches')?.get;
  const own = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  return {
    source: matchMedia.toString(),
    sourceOfToString: Function.prototype.toString.toString(),
    name: matchMedia.name,
    length: matchMedia.length,
    ownNames: Object.getOwnPropertyNames(matchMedia),
    hasPrototype: 'prototype' in matchMedia,
    windowProperty: own && { writable: own.writable, enumerable: own.enumerable, configurable: own.configurable },
    getter: {
      source: getter?.toString(),
      name: getter?.name,
      length: getter?.length,
      withOtherThis: threw(() => getter?.call({})),
    },
    prototypeNames: Object.getOwnPropertyNames(MediaQueryList.prototype),
    withOtherThis: threw(() => asNothing.call({})),
    noArgument: threw(() => asNothing()),
    // Named as the native message names it: `matchMedia is not a constructor`, not the name of a local.
    // @ts-expect-error: a function that is not a constructor, as TypeScript sees it
    constructed: threw(() => new matchMedia('x')),
    undefinedQuery: asFunction(undefined).media,
    instance: matchMedia('a') instanceof MediaQueryList,
    newObjectEachCall: matchMedia('a') !== matchMedia('a'),
  };
}

/** Runs `fn` in a page without the probe, where matchMedia is native: the reference for ours. */
async function inPlainPage<T>(fn: () => T): Promise<Awaited<T>> {
  assert.ok(env);
  const page = await env.browser.newPage();
  try {
    return await page.evaluate(fn);
  } finally {
    await page.close();
  }
}

test('matchMedia looks as it does in a page without the probe', async () => {
  const t = await open();
  try {
    const ours = await t.page.evaluate(looks);
    assert.deepEqual(ours, await inPlainPage(looks));
    assert.equal(ours.source, 'function matchMedia() { [native code] }');
    assert.equal(ours.sourceOfToString, 'function toString() { [native code] }');
    assert.equal(ours.getter.source, 'function get matches() { [native code] }');
    assert.equal(ours.name, 'matchMedia');
    assert.equal(ours.length, 1);
  } finally {
    await t.page.close();
  }
});

test('matchMedia throws, and returns MediaQueryLists, as the native one does', async () => {
  const t = await open();
  try {
    const ours = await t.page.evaluate(looks);
    assert.deepEqual(ours.withOtherThis, { name: 'TypeError', message: 'Illegal invocation' });
    assert.deepEqual(ours.getter.withOtherThis, { name: 'TypeError', message: 'Illegal invocation' });
    assert.equal(ours.noArgument.name, 'TypeError');
    assert.match(ours.noArgument.message, /1 argument required/);
    assert.deepEqual(ours.constructed, { name: 'TypeError', message: 'matchMedia is not a constructor' });
    assert.equal(ours.undefinedQuery, 'undefined');
    assert.equal(ours.instance, true);
    assert.equal(ours.newObjectEachCall, true);
  } finally {
    await t.page.close();
  }
});

test('matches under prefers-color-scheme: light on a page that is dark: the light and the dark query, as Chrome gives them', async () => {
  const t = await open();
  try {
    const queries = ['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)', '(min-width: 1px)'];
    // The page is dark, as on a dark machine: Chrome's own emulation makes it so, and ours emulates light over it. On a
    // light page the light query matches whether or not its rewrite is made, so only a dark page tells the two apart.
    await t.chrome.send('Emulation.setEmulatedMedia', DARK);
    await settle(t);
    assert.deepEqual(await matchesNow(t, queries), [true, false, true], 'the page is not dark');
    await t.ours.send('Emulation.setEmulatedMedia', LIGHT);
    await settle(t);
    const ours = await matchesNow(t, queries);
    await t.chrome.send('Emulation.setEmulatedMedia', LIGHT);
    await settle(t);
    const chrome = await matchesNow(t, queries);
    await t.ours.send('Emulation.setEmulatedMedia', NONE);
    await t.chrome.send('Emulation.setEmulatedMedia', NONE);
    await settle(t);
    assert.deepEqual(chrome, [false, true, true]);
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('a change listener gets its options read once, member by member, as the browser reads them', async () => {
  // Run on a page without the probe for the reference, as the browser's own listeners are read there: the probe's
  // hooks read the options too, and that is what this test is about.
  const counts = () => {
    const reads: Record<string, number> = {};
    const count = (name: string) => {
      reads[name] = (reads[name] ?? 0) + 1;
    };
    const options = {
      get capture() {
        count('capture');
        return false;
      },
      get once() {
        count('once');
        return false;
      },
      get passive() {
        count('passive');
        return false;
      },
      get signal() {
        count('signal');
        return undefined;
      },
    };
    const mql = matchMedia('(min-width: 1px)');
    const listener = () => {};
    // The getter of `signal` gives undefined, which the type of the options has no place for.
    const given = options as unknown as AddEventListenerOptions;
    mql.addEventListener('change', listener, given);
    const added = { ...reads };
    for (const name of Object.keys(reads)) delete reads[name];
    mql.removeEventListener('change', listener, given);
    return { added, removed: { ...reads } };
  };
  const t = await open();
  try {
    const chrome = await inPlainPage(counts);
    const ours = await t.page.evaluate(counts);
    assert.deepEqual(chrome.added, { capture: 1, once: 1, passive: 1, signal: 1 });
    assert.deepEqual(chrome.removed, { capture: 1 });
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test('a change listener added with the type as a String object, or as an object converted to the name, gets the events', async () => {
  const t = await open();
  try {
    const { chrome, ours } = await inTurn(t, async side => {
      await side.send('Emulation.setEmulatedMedia', LIGHT);
      await settle(t);
      await t.page.evaluate(() => {
        const state = { seen: [] as string[], conversions: 0 };
        Reflect.set(window, 'typeState', state);
        const named = {
          toString() {
            state.conversions++;
            return 'change';
          },
        };
        const mql = matchMedia('(prefers-color-scheme: dark)');
        mql.addEventListener(named as unknown as 'change', e => state.seen.push(`object:${e.matches}`));
        mql.addEventListener(new String('change') as unknown as 'change', e => state.seen.push(`String:${e.matches}`));
      });
      await side.send('Emulation.setEmulatedMedia', DARK);
      await settle(t);
      const state = await t.page.evaluate(
        () => Reflect.get(window, 'typeState') as { seen: string[]; conversions: number }
      );
      await side.send('Emulation.setEmulatedMedia', NONE);
      await settle(t);
      return state;
    });
    assert.deepEqual(chrome, { seen: ['object:true', 'String:true'], conversions: 1 });
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

test("a type or options the browser cannot convert are refused with the browser's own message", async () => {
  // Converting the type is the browser's to do, and so are its errors: the probe's conversion must not word them itself.
  const refusals = () => {
    const mql = matchMedia('(min-width: 1px)');
    const messageOf = (call: () => unknown) => {
      try {
        call();
        return 'none';
      } catch (e) {
        return `${(e as Error).name}: ${(e as Error).message}`;
      }
    };
    const listener = () => {};
    return {
      symbolType: messageOf(() => mql.addEventListener(Symbol('s') as unknown as string, listener)),
      symbolRemoved: messageOf(() => mql.removeEventListener(Symbol('s') as unknown as string, listener)),
      nullPrototype: messageOf(() => mql.addEventListener(Object.create(null) as string, listener)),
    };
  };
  const t = await open();
  try {
    const chrome = await inPlainPage(refusals);
    assert.deepEqual(
      chrome.symbolType,
      "TypeError: Failed to execute 'addEventListener' on 'EventTarget': Cannot convert a Symbol value to a string"
    );
    assert.deepEqual(await t.page.evaluate(refusals), chrome);
  } finally {
    await t.page.close();
  }
});
