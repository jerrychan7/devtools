// Real Chrome with cross-site iframes out of process (OOPIFs), driven over a raw browser-level
// CDP connection, so every message is seen with its sessionId as a client such as the DevTools
// frontend sees it. Used to record what Chrome does for cross-origin iframes, as the reference
// for our agent's child targets. Findings are in oopif-notes.md.
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import { launch, type Env } from '../../../../tests/support/browser.ts';

type Commands = ProtocolMapping.Commands;
/** A command's params; `{}` for the commands that take none. */
type Params<M extends keyof Commands> = Commands[M]['paramsType'] extends []
  ? object
  : Exclude<Commands[M]['paramsType'][0], undefined>;

/** The third site: a name the test browser resolves to 127.0.0.1. */
export const THIRD_HOST = 'oopif.test';

/**
 * Launches Chrome with every site in its own process, so a cross-site iframe becomes an OOPIF
 * and a child target. The pages use three sites on the one server: localhost (the parent),
 * 127.0.0.1 (the child) and oopif.test (the grandchild).
 */
export function launchOopif(): Promise<Env> {
  return launch(['--site-per-process', `--host-resolver-rules=MAP ${THIRD_HOST} 127.0.0.1`]);
}

export const FIXTURES = '/packages/devtools-anywhere/test-support/';

/** The URL of a fixture on another host of the same server: 'localhost', '127.0.0.1' or THIRD_HOST. */
export function fixtureUrl(env: Env, file: string, host = 'localhost'): string {
  const url = new URL(FIXTURES + file, env.baseUrl);
  url.hostname = host;
  return url.href;
}

/** One message from Chrome, with the session it came on ('' for the browser's own). */
export interface Recorded {
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
}

interface Reply {
  id: number;
  result?: unknown;
  error?: { message: string };
}

/** A raw CDP connection to the browser: commands on any session, and a log of all events. */
export class RawCdp {
  readonly log: Recorded[] = [];
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, (reply: Reply) => void>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', e => {
      const msg: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string } = JSON.parse(
        String(e.data)
      );
      if (msg.id !== undefined) {
        this.#pending.get(msg.id)?.(msg as Reply);
        this.#pending.delete(msg.id);
      } else if (msg.method) {
        this.log.push({ sessionId: msg.sessionId ?? '', method: msg.method, params: msg.params ?? {} });
      }
    });
  }

  static async connect(env: Env): Promise<RawCdp> {
    const ws = new WebSocket(env.browser.wsEndpoint());
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new RawCdp(ws);
  }

  send<M extends keyof Commands>(method: M, params?: Params<M>, sessionId = ''): Promise<Commands[M]['returnType']> {
    const id = this.#nextId++;
    this.#ws.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, reply => {
        if (reply.error) reject(new Error(`${method}: ${reply.error.message}`));
        // The reply is what the protocol says this method returns.
        else resolve(reply.result as Commands[M]['returnType']);
      });
    });
  }

  /** Events logged so far that match. */
  events(method: string, sessionId?: string): Recorded[] {
    return this.log.filter(e => e.method === method && (sessionId === undefined || e.sessionId === sessionId));
  }

  /** Waits for the `count`th event that matches, counting those already logged. */
  async waitFor(match: (e: Recorded) => boolean, count = 1, timeout = 5000): Promise<Recorded> {
    const start = Date.now();
    for (;;) {
      const found = this.log.filter(match);
      const hit = found[count - 1];
      if (hit) return hit;
      if (Date.now() - start > timeout) throw new Error(`timed out waiting for event #${count}`);
      await new Promise(r => setTimeout(r, 20));
    }
  }

  /** Waits until no event has arrived for `quiet` ms. */
  async settle(quiet = 300): Promise<void> {
    let seen = -1;
    while (seen !== this.log.length) {
      seen = this.log.length;
      await new Promise(r => setTimeout(r, quiet));
    }
  }

  close(): void {
    this.#ws.close();
  }
}

/** What the DevTools frontend enables on every frame target (a subset that matters here). */
export const FRONTEND_ENABLES = ['Page.enable', 'Runtime.enable', 'DOM.enable', 'Network.enable'] as const;

/**
 * A page target attached with flatten, as the frontend's root target. Each session it learns
 * of through auto-attach is set up as the frontend sets up a child target: the domains enabled,
 * auto-attach on it too (for grandchildren), then resumed.
 */
export class OopifPage {
  readonly cdp: RawCdp;
  readonly targetId: string;
  readonly sessionId: string;
  /** Child sessions, in the order they were attached. */
  readonly children: { sessionId: string; parent: string; targetId: string }[] = [];

  private constructor(cdp: RawCdp, targetId: string, sessionId: string) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  static async open(env: Env, url: string, { autoAttach = true } = {}): Promise<OopifPage> {
    const cdp = await RawCdp.connect(env);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new OopifPage(cdp, targetId, sessionId);
    await page.setUp(sessionId, autoAttach);
    await cdp.send('Page.navigate', { url }, sessionId);
    await cdp.waitFor(e => e.method === 'Page.loadEventFired' && e.sessionId === sessionId);
    return page;
  }

  async setUp(sessionId: string, autoAttach: boolean): Promise<void> {
    for (const method of FRONTEND_ENABLES) await this.cdp.send(method, {}, sessionId);
    if (!autoAttach) return;
    // Children are set up as they come, before they are resumed, as the frontend does.
    const onAttach = async (e: Recorded) => {
      const childSession = String(e.params['sessionId']);
      const info = e.params['targetInfo'] as { targetId: string };
      this.children.push({ sessionId: childSession, parent: e.sessionId, targetId: info.targetId });
      await this.setUp(childSession, true);
      if (e.params['waitingForDebugger']) await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, childSession);
    };
    let handled = this.cdp.log.length;
    const poll = setInterval(() => {
      for (; handled < this.cdp.log.length; handled++) {
        const e = this.cdp.log[handled];
        if (e?.method === 'Target.attachedToTarget' && e.sessionId === sessionId) void onAttach(e).catch(() => {});
      }
    }, 5);
    this.#polls.push(poll);
    await this.cdp.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId
    );
  }

  #polls: ReturnType<typeof setInterval>[] = [];

  /**
   * The latest child session whose target's URL contains `part`. A child target is attached
   * with an empty URL, which targetInfoChanged fills in once it commits.
   */
  async child(part: string, timeout = 5000): Promise<string> {
    const start = Date.now();
    for (;;) {
      const info = this.cdp.log.findLast(
        e =>
          (e.method === 'Target.attachedToTarget' || e.method === 'Target.targetInfoChanged') &&
          String((e.params['targetInfo'] as { url: string }).url).includes(part)
      );
      const targetId = (info?.params['targetInfo'] as { targetId: string } | undefined)?.targetId;
      const found = this.children.findLast(c => c.targetId === targetId);
      if (found) return found.sessionId;
      if (Date.now() - start > timeout) throw new Error(`no child target for ${part}`);
      await new Promise(r => setTimeout(r, 20));
    }
  }

  close(): void {
    for (const poll of this.#polls) clearInterval(poll);
    this.cdp.close();
  }
}

/** One event in a recorded sequence, with ids and URLs made stable so runs compare equal. */
export interface Step {
  session: string;
  method: string;
  params: unknown;
}

/** The events that show how targets and frames come and go. */
export const LIFECYCLE_EVENTS: RegExp =
  /^(Target\.|Page\.frame(Attached|Detached|Navigated|StartedNavigating)$|Page\.navigatedWithinDocument$|Runtime\.executionContext(Created|Destroyed|sCleared)$|DOM\.documentUpdated$)/;

/** Keys that differ on every run and say nothing about the sequence. */
const DROPPED = new Set([
  'timestamp',
  'wallTime',
  'uniqueId',
  'executionContextUniqueId',
  'browserContextId',
  'securityOriginDetails',
  'adFrameStatus',
  'gatedAPIFeatures',
  'secureContextType',
  'crossOriginIsolatedContextType',
  'domainAndRegistry',
  'mimeType',
  'stackTrace',
]);

/**
 * Rewrites a log for reading and comparing: sessions are named root, s1, s2… in the order they
 * were attached, ids (targets, frames, loaders) id1, id2… in the order they first appear (a frame's
 * id is also its target's when the frame is a target's main frame), and URLs lose their port.
 */
export function compact(page: OopifPage, log: Recorded[], match: RegExp = LIFECYCLE_EVENTS): Step[] {
  const sessions = new Map<string, string>([[page.sessionId, 'root']]);
  page.children.forEach((c, i) => sessions.set(c.sessionId, `s${i + 1}`));
  const ids = new Map<string, string>([[page.targetId, 'page']]);
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (sessions.has(value)) return sessions.get(value);
      if (/^[0-9A-F]{32}$/.test(value)) {
        if (!ids.has(value)) ids.set(value, `id${ids.size}`);
        return ids.get(value);
      }
      return value.replace(/^(https?:\/\/[^/:]+):\d+(\/packages\/devtools-anywhere\/test-support)?/, '$1');
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !DROPPED.has(key))
          .map(([key, v]) => [key, rewrite(v)])
      );
    }
    return value;
  };
  return log
    .filter(e => match.test(e.method))
    .map(e => ({
      session: e.sessionId ? (sessions.get(e.sessionId) ?? e.sessionId) : 'browser',
      method: e.method,
      params: rewrite(e.params),
    }));
}

/** Runs `expression` in a session's page and waits for it. */
export function evaluate(page: OopifPage, sessionId: string, expression: string): Promise<unknown> {
  return page.cdp.send('Runtime.evaluate', { expression, awaitPromise: true }, sessionId);
}

/**
 * Opens oopif-parent.html (parent, cross-site child, cross-site grandchild) with the targets set
 * up as the frontend does, waits for things to settle, runs `act` and returns Chrome's events from
 * then on: the reference sequence for that action.
 */
export async function chromeSequence(
  env: Env,
  act: (page: OopifPage) => Promise<void>,
  match: RegExp = LIFECYCLE_EVENTS
): Promise<{ setup: Step[]; steps: Step[] }> {
  const page = await OopifPage.open(env, fixtureUrl(env, 'oopif-parent.html'));
  try {
    await page.child(THIRD_HOST);
    await page.cdp.settle();
    const from = page.cdp.log.length;
    await act(page);
    await page.cdp.settle();
    const all = compact(page, page.cdp.log, match);
    const setup = compact(page, page.cdp.log.slice(0, from), match);
    return { setup, steps: all.slice(setup.length) };
  } finally {
    page.close();
  }
}

/** Actions on the child iframe, for chromeSequence. */
export const SCENARIOS = {
  /** The child reloads itself. */
  reload: async (page: OopifPage) => {
    await evaluate(page, await page.child('oopif-child'), 'location.reload()');
  },
  /** The child goes to another page of its own origin (one without a grandchild). */
  sameOrigin: async (page: OopifPage) => {
    await evaluate(page, await page.child('oopif-child'), "location.href = 'oopif-child.html?leaf'");
  },
  /** The parent points the iframe at a third site. */
  otherSite: (env: Env) => async (page: OopifPage) => {
    const url = fixtureUrl(env, 'oopif-child.html?leaf', THIRD_HOST);
    await evaluate(page, page.sessionId, `document.getElementById('child').src = ${JSON.stringify(url)}`);
  },
  /** The parent points the iframe at a page of its own origin: the frame is no longer a target. */
  parentOrigin: (env: Env) => async (page: OopifPage) => {
    const url = fixtureUrl(env, 'frame-child.html');
    await evaluate(page, page.sessionId, `document.getElementById('child').src = ${JSON.stringify(url)}`);
  },
  /** The parent removes the iframe. */
  remove: async (page: OopifPage) => {
    await evaluate(page, page.sessionId, "document.getElementById('child').remove()");
  },
};
