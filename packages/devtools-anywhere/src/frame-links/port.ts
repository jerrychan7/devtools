import { FRAME_BYE, isMessage } from './protocol';

/** One end of a link's port: CDP messages as strings, and a bye that ends it. */
export interface PortEnd {
  send(message: string): void;
  onMessage(listener: (message: string) => void): () => void;
  /** Listens to the link's end; called at once when it has ended. */
  onClose(listener: () => void): () => void;
  /** Ends the link, telling the other end. */
  close(): void;
  readonly closed: boolean;
}

/** Opens one end of a link on `port`. */
export function openPort(port: MessagePort): PortEnd {
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
