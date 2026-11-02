// Runs in a test page (bundled from the sources by bundleHarness, in child-targets.ts): the page's
// agent with stand-in links to cross-origin iframes. Each stand-in iframe agent is a CDP session
// in the same page with the Target domain of its own (so it can have children too) and a
// Runtime.evaluate that answers its name; its link passes messages on asynchronously, as a
// MessagePort would.
import { CdpSession, FRAME_ID, childTargets, createCdpSession } from '../src/cdp-agent';
import { ChildTargets, type ChildLink, type ParentLink } from '../src/cdp-agent/core/child-targets';
import { frames } from '../src/cdp-agent/core/frames';
import { registerTarget } from '../src/cdp-agent/domains/target/target';
import { connectFrontend, endSession } from '../src/connection';
import { connectRemote } from '../src/remote';

/** A stand-in iframe agent. */
interface Agent {
  session: CdpSession;
  targets: ChildTargets;
  link: ChildLink;
  /** The messages it received, parsed. */
  received: Record<string, unknown>[];
}

const parse = (message: string): Record<string, unknown> => ({ ...Object(JSON.parse(message)) });

function newLink(owner: Element, frameId: string, agent: CdpSession, received: Record<string, unknown>[]): ChildLink {
  const listeners = new Set<(message: string) => void>();
  const closes = new Set<() => void>();
  let open = true;
  agent.onMessage(message => {
    if (open) queueMicrotask(() => listeners.forEach(listener => listener(message)));
  });
  return {
    owner,
    frameId,
    send(message) {
      if (open) queueMicrotask(() => void agent.dispatch(message).catch(() => {}));
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    endSession() {
      if (!open) return;
      // Recorded among what the agent received, as a message of its own.
      received.push({ endSession: true });
      queueMicrotask(() => void endSession(agent).then(() => agent.reset()));
    },
    onClose(listener) {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close() {
      if (!open) return;
      open = false;
      closes.forEach(listener => listener());
    },
  };
}

const parentLink = (frameId: string, parentFrameId: string): ParentLink => ({
  frameId,
  parentFrameId,
  parentTargetId: parentFrameId,
  send() {},
  onMessage: () => () => {},
  onEndSession: () => () => {},
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
    const session = new CdpSession();
    const targets = new ChildTargets();
    targets.setParent(
      parentLink(frameId, parent === undefined ? FRAME_ID : (this.agents.get(parent)?.link.frameId ?? ''))
    );
    registerTarget({ session, frames }, targets);
    session.register('Runtime', {
      enable: () => {},
      disable: () => {},
      runIfWaitingForDebugger: () => {},
      evaluate: () => ({ result: { type: 'string', value: name } }),
    });
    const received: Record<string, unknown>[] = [];
    const dispatch = session.dispatch.bind(session);
    session.dispatch = message => {
      if (typeof message === 'string') received.push(parse(message));
      return dispatch(message);
    };
    const link = newLink(owner, frameId, session, received);
    this.agents.set(name, { session, targets, link, received });
    holder.addChild(link);
    return frameId;
  }

  received(name: string): Record<string, unknown>[] {
    return this.agents.get(name)?.received ?? [];
  }

  close(name: string) {
    this.agents.get(name)?.link.close();
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
