import type { Protocol } from 'devtools-protocol';
import type { Context } from '../core/context';
import { CdpError } from '../core/server';

type EventListener = Protocol.DOMDebugger.EventListener;

export function registerDomDebugger(ctx: Context) {
  const { server, objects, nodes, probe } = ctx;

  /** Listeners of one target: addEventListener ones (recorded by the probe) and on* handlers. */
  function listenersOf(target: EventTarget, group: string | undefined): EventListener[] {
    const base = (type: string, handler: unknown) => {
      const listener: EventListener = {
        type,
        useCapture: false,
        passive: false,
        once: false,
        // The source location of a handler is not available to page scripts.
        scriptId: '',
        lineNumber: 0,
        columnNumber: 0,
      };
      // Like Chrome, handlers are only returned if the target belongs to an object group.
      if (group !== undefined) {
        // For a listener object, the handler is its handleEvent method.
        const fn = handler && typeof handler === 'object' ? (handler as EventListenerObject).handleEvent : handler;
        listener.handler = objects.wrap(fn, { group });
        listener.originalHandler = objects.wrap(handler, { group });
      }
      if (target instanceof Node) listener.backendNodeId = nodes.backendIdOf(target);
      return listener;
    };
    const result = (probe.listeners.get(target) ?? []).map(r => ({
      ...base(r.type, r.listener),
      useCapture: r.capture,
      passive: r.passive,
      once: r.once,
    }));
    for (const key in target) {
      if (!key.startsWith('on')) continue;
      let handler: unknown;
      try {
        handler = Reflect.get(target, key);
      } catch {
        continue;
      }
      if (typeof handler === 'function') result.push(base(key.slice(2), handler));
    }
    return result;
  }

  server.register('DOMDebugger', {
    getEventListeners(
      params: Protocol.DOMDebugger.GetEventListenersRequest
    ): Protocol.DOMDebugger.GetEventListenersResponse {
      const target = objects.get(params.objectId);
      if (!(target instanceof EventTarget)) throw new CdpError('Object is not an EventTarget');
      const depth = params.depth ?? 1;
      const group = objects.groupOf(params.objectId);
      const listeners = listenersOf(target, group);
      // With a depth, descendants' listeners are included too (tagged with their node).
      if (target instanceof Node && depth !== 1 && depth !== 0) {
        const visit = (node: Node, level: number) => {
          if (depth !== -1 && level > depth) return;
          for (const child of Array.from(node.childNodes)) {
            listeners.push(...listenersOf(child, group));
            visit(child, level + 1);
          }
        };
        visit(target, 1);
      }
      return { listeners };
    },
    setBreakOnCSPViolation: () => {},
  });
}
