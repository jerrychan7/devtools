// Runs in a test page (bundled from the sources by bundleHarness, in child-targets.ts): the page's
// agent with stand-in links to cross-origin iframes. Each stand-in iframe agent is CDP sessions
// in the same page, one for the link and one per session the parent opens, each with the Target
// domain of its own (so it can have children too) and a Runtime that answers the agent's name
// and, enabled, reports an execution context (Runtime.awaitPromise never answers); its link passes messages on asynchronously, as a
// MessagePort would.
import { CdpSession, FRAME_ID, childTargets, createCdpSession } from '../../src/cdp-agent';
import {
  ChildTargets,
  type ChildLink,
  type ChildSession,
  type ParentLink,
} from '../../src/cdp-agent/core/frames/child-targets';
import { frames } from '../../src/cdp-agent/core/frames/frames';
import { registerTarget } from '../../src/cdp-agent/domains/target/target';
import { connectFrontend, endSession } from '../../src/connection';
import { connectRemote } from '../../src/remote';

/** A stand-in iframe agent. */
interface Agent {
  session: CdpSession;
  targets: ChildTargets;
  link: ChildLink;
  /** The messages it received, parsed. */
  received: Record<string, unknown>[];
  /** The agent it is linked to (none for the page's), and that agent's links. */
  parent: string | undefined;
  holder: ChildTargets;
  /** The sessions it made: the link's, then one per session the parent opened. */
  sessions: CdpSession[];
}

const parse = (message: string): Record<string, unknown> => ({ ...Object(JSON.parse(message)) });

/** Messages from `agent` to `listeners`, and to `agent` by `send`, asynchronously, while `open()`. */
function channelTo(agent: CdpSession, open: () => boolean) {
  const listeners = new Set<(message: string) => void>();
  agent.onMessage(message => {
    if (open()) queueMicrotask(() => listeners.forEach(listener => listener(message)));
  });
  return {
    send(message: string) {
      if (open()) queueMicrotask(() => void agent.dispatch(message).catch(() => {}));
    },
    onMessage(listener: (message: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * A stand-in link to the agent whose sessions `make` makes: one for the link, one per session
 * opened. Each session's end is recorded among what the agent received, as a message of its own.
 */
function newLink(
  owner: Element,
  frameId: string,
  make: () => CdpSession,
  received: Record<string, unknown>[]
): { link: ChildLink; own: CdpSession } {
  const closes = new Set<() => void>();
  const sessions = new Set<() => void>();
  let open = true;
  const own = make();
  const { send, onMessage } = channelTo(own, () => open);
  const link: ChildLink = {
    owner,
    frameId,
    send,
    onMessage,
    openSession() {
      const agent = make();
      const ends = new Set<() => void>();
      let live = open;
      const end = () => {
        if (!live) return;
        live = false;
        sessions.delete(end);
        received.push({ endSession: true });
        queueMicrotask(() => void endSession(agent).then(() => agent.reset()));
        ends.forEach(listener => listener());
      };
      if (live) sessions.add(end);
      const session: ChildSession = {
        ...channelTo(agent, () => live),
        onClose(listener) {
          ends.add(listener);
          return () => ends.delete(listener);
        },
        close: end,
      };
      return session;
    },
    onClose(listener) {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close() {
      if (!open) return;
      open = false;
      [...sessions].forEach(end => end());
      closes.forEach(listener => listener());
    },
  };
  return { link, own };
}

const parentLink = (frameId: string, parentFrameId: string): ParentLink => ({
  frameId,
  parentFrameId,
  parentTargetId: parentFrameId,
  send() {},
  onMessage: () => () => {},
  onSession: () => () => {},
  onClose: () => () => {},
  close() {},
});

export class Harness {
  /** What the page's agent sent its client, parsed. */
  readonly out: Record<string, unknown>[] = [];
  readonly agents = new Map<string, Agent>();
  readonly session: CdpSession;
  /** More sessions of the page's agent, as more clients. */
  readonly others: CdpSession[] = [];

  constructor() {
    this.session = createCdpSession();
    this.session.onMessage(message => this.out.push(parse(message)));
  }

  /** Sends the page's agent a client message. */
  send(message: object) {
    void this.session.dispatch(JSON.stringify(message)).catch(() => {});
  }

  /**
   * Adds a stand-in iframe agent called `name`, held by a new `<iframe>` of the page, linked to
   * the page's agent or to agent `parent`'s. Returns its frame id.
   */
  add(name: string, parent?: string): string {
    const owner = document.createElement('iframe');
    owner.name = name;
    document.body.append(owner);
    const holder = parent === undefined ? childTargets : this.agents.get(parent)?.targets;
    if (!holder) throw new Error(`no agent ${parent}`);
    const frameId = holder.frameIdOf(owner);
    this.#link(name, owner, frameId, parent, holder);
    return frameId;
  }

  /** A stand-in agent for the document in `owner`, linked to `holder`. */
  #link(name: string, owner: Element, frameId: string, parent: string | undefined, holder: ChildTargets) {
    const targets = new ChildTargets();
    targets.setParent(
      parentLink(frameId, parent === undefined ? FRAME_ID : (this.agents.get(parent)?.link.frameId ?? ''))
    );
    const received: Record<string, unknown>[] = [];
    const sessions: CdpSession[] = [];
    const make = () => {
      const session = new CdpSession();
      sessions.push(session);
      registerTarget({ session, frames }, targets);
      let contexts = 0;
      session.register('Runtime', {
        enable: () => {
          session.emit('Runtime.executionContextCreated', { context: { id: ++contexts, name } });
        },
        disable: () => {},
        runIfWaitingForDebugger: () => {},
        evaluate: () => ({ result: { type: 'string', value: name } }),
        // Never answered: a command in flight when the document goes away.
        awaitPromise: () => new Promise<never>(() => {}),
      });
      const dispatch = session.dispatch.bind(session);
      session.dispatch = message => {
        if (typeof message === 'string') received.push(parse(message));
        return dispatch(message);
      };
      return session;
    };
    const { link, own: session } = newLink(owner, frameId, make, received);
    this.agents.set(name, { session, targets, link, received, parent, holder, sessions });
    holder.addChild(link);
  }

  /**
   * The iframe of agent `name` loads another document, whose agent (a new stand-in, the same
   * name) links again, unless `relink` is false.
   */
  navigate(name: string, relink = true) {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`no agent ${name}`);
    agent.link.close();
    if (relink) this.#link(name, agent.link.owner, agent.link.frameId, agent.parent, agent.holder);
  }

  received(name: string): Record<string, unknown>[] {
    return this.agents.get(name)?.received ?? [];
  }

  /** Has agent `name` send `message` as it is on the last session the parent opened, as a rogue agent could. */
  forge(name: string, message: object) {
    const session = this.agents.get(name)?.sessions.at(-1);
    if (!session) throw new Error(`no agent ${name}`);
    session.post(JSON.stringify(message));
  }

  /** Removes the iframe of agent `name`. */
  close(name: string) {
    const agent = this.agents.get(name);
    if (!agent) return;
    agent.link.owner.remove();
    agent.link.close();
    // As the handshake's watch of the element does, between two documents too.
    agent.holder.end(agent.link.owner);
  }

  /** Ends the client's session, as when it disconnects. */
  async end(session = this.session) {
    await endSession(session);
    session.reset();
  }

  /** Another client's session with the page's agent; its messages in `out` too, under `other`. */
  another(): number {
    const session = createCdpSession();
    const index = this.others.push(session) - 1;
    session.onMessage(message => this.out.push({ ...parse(message), other: index }));
    return index;
  }

  /**
   * Connects the page's agent to a stand-in frontend in an `<iframe>` of the page, as embedding
   * does; returns a function that sends the agent a message from the frontend, whose messages
   * go to `out`.
   */
  embed(): (message: object) => void {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const win = frame.contentWindow;
    if (!win) throw new Error('no frontend window');
    win.addEventListener('message', event => {
      if (typeof event.data === 'string') this.out.push({ ...parse(event.data), embedded: true });
    });
    connectFrontend(createCdpSession(), frame, location.origin);
    // From the frontend's window: the agent only takes messages whose source is that window.
    const post: (message: string, origin: string) => void = Reflect.get(
      win,
      'eval'
    )('(message, origin) => parent.postMessage(message, origin)');
    return message => post(JSON.stringify(message), location.origin);
  }

  /** Connects the page to a remote debugging server, as `connectRemote` does. */
  remote(serverUrl: string): () => void {
    return connectRemote(createCdpSession, serverUrl);
  }
}
