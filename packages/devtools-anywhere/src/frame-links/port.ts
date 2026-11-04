import { FRAME_BYE, FRAME_OPEN_SESSION, isMessage } from './protocol';

/** One end of a port: CDP messages as strings, and a bye that ends it. */
export interface Channel {
  send(message: string): void;
  onMessage(listener: (message: string) => void): () => void;
  /** Listens to the end; called at once when it has ended. */
  onClose(listener: () => void): () => void;
  /** Ends it, telling the other end. */
  close(): void;
  readonly closed: boolean;
}

/** One end of a link's port, which also carries the sessions of the parent's clients. */
export interface PortEnd extends Channel {
  /** Opens a session on a port of its own (protocol.ts, FRAME_OPEN_SESSION); it ends with the link. */
  openSession(): Channel;
  /** Listens to sessions the other end opens. */
  onSession(listener: (session: Channel) => void): () => void;
}

/** Opens one end of `port`; `other` gets what is neither a string nor a bye. */
function openChannel(port: MessagePort, other: (event: MessageEvent) => void = () => {}): Channel {
  const messageListeners = new Set<(message: string) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  const end = () => {
    if (closed) return;
    closed = true;
    port.close();
    messageListeners.clear();
    const listeners = [...closeListeners];
    closeListeners.clear();
    listeners.forEach(listener => listener());
  };
  // The other end is the only one with the port's twin: what comes is from it.
  port.onmessage = event => {
    const data: unknown = event.data;
    if (typeof data === 'string') messageListeners.forEach(listener => listener(data));
    else if (isMessage(data, FRAME_BYE)) end();
    else other(event);
  };
  return {
    send(message) {
      if (!closed) port.postMessage(message);
    },
    onMessage(listener) {
      if (!closed) messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      if (closed) {
        listener();
        return () => {};
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      if (closed) return;
      port.postMessage({ type: FRAME_BYE });
      end();
    },
    get closed() {
      return closed;
    },
  };
}

/** Opens one end of a link on `port`. */
export function openPort(port: MessagePort): PortEnd {
  const sessions = new Set<Channel>();
  const sessionListeners = new Set<(session: Channel) => void>();
  const track = (session: Channel) => {
    sessions.add(session);
    session.onClose(() => sessions.delete(session));
    return session;
  };
  const link = openChannel(port, event => {
    const sessionPort = event.ports[0];
    if (!isMessage(event.data, FRAME_OPEN_SESSION) || !sessionPort) return;
    const session = track(openChannel(sessionPort));
    sessionListeners.forEach(listener => listener(session));
  });
  // The link's sessions end with it, at both ends.
  link.onClose(() => {
    sessionListeners.clear();
    [...sessions].forEach(session => session.close());
  });
  return {
    send: link.send,
    onMessage: link.onMessage,
    onClose: link.onClose,
    close: link.close,
    get closed() {
      return link.closed;
    },
    openSession() {
      const channel = new MessageChannel();
      const session = track(openChannel(channel.port1));
      if (link.closed) session.close();
      else port.postMessage({ type: FRAME_OPEN_SESSION }, [channel.port2]);
      return session;
    },
    onSession(listener) {
      if (!link.closed) sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
  };
}
