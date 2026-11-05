import type { Protocol } from 'devtools-protocol';
import { type Frame, type FrameChange, type FrameRegistry, awaitsFirstDocument } from '../../core/frames/frames';
import { NS_STRIDE, nsPrefix } from '../../core/frames/merged-frames';
import { isNode, realmOf } from '../../core/realm';
import { CdpError } from '../../core/session';

/**
 * A context's uniqueId: in a merged frame's agent (core/frames/merged-frames.ts), whose context ids are
 * in its namespace, prefixed with it, so that the page's agent routes uniqueContextId by it too.
 */
function uniqueIdOf(contextId: number): string {
  const ns = Math.floor(contextId / NS_STRIDE);
  return `${ns > 0 ? nsPrefix(ns) : ''}devtools-anywhere-context-${contextId}`;
}

/**
 * The origin Chrome reports for a frame's context: the document's, inherited by about:blank and
 * about:srcdoc; for an opaque one (a sandboxed iframe without allow-same-origin) Chrome writes
 * '://', not 'null'.
 */
const originOf = (frame: Frame) => (frame.window.origin === 'null' ? '://' : frame.window.origin);

/**
 * The execution contexts the client knows of: the default one of each frame's document (no
 * isolated worlds). Like Chrome, Runtime.enable announces all of them, then each frame's
 * document as it comes (executionContextCreated) and goes (executionContextDestroyed, for a
 * frame navigated before the new document's context is created).
 */
export function executionContexts(frames: FrameRegistry, emit: (method: string, params: object) => void) {
  /** The context announced for each frame: the registry has moved on once a frame navigated. */
  const announced = new Map<Frame, number>();
  let stop: (() => void) | null = null;

  function created(frame: Frame) {
    // Chrome creates none for the initial about:blank an iframe leaves for its src.
    if (awaitsFirstDocument(frame)) return;
    const id = frame.executionContextId;
    announced.set(frame, id);
    emit('Runtime.executionContextCreated', {
      context: {
        id,
        // The document's origin, inherited by about:blank and about:srcdoc.
        origin: originOf(frame),
        name: '',
        uniqueId: uniqueIdOf(id),
        auxData: { isDefault: true, type: 'default', frameId: frame.id },
      },
    } satisfies Protocol.Runtime.ExecutionContextCreatedEvent);
  }

  function destroyed(frame: Frame) {
    const id = announced.get(frame);
    if (id === undefined) return;
    announced.delete(frame);
    emit('Runtime.executionContextDestroyed', {
      executionContextId: id,
      executionContextUniqueId: uniqueIdOf(id),
    } satisfies Protocol.Runtime.ExecutionContextDestroyedEvent);
  }

  const onChange = ({ type, frame }: FrameChange) => {
    if (type !== 'attached') destroyed(frame);
    if (type !== 'detached') created(frame);
  };

  return {
    /**
     * Announces every context, newest first like Chrome (whose contexts come out of a map in
     * that order), and follows the frames from now on.
     */
    enable() {
      if (stop) return;
      frames.sync();
      for (const frame of Array.from(frames).sort((a, b) => b.executionContextId - a.executionContextId))
        created(frame);
      stop = frames.onChange(onChange);
    },
    disable() {
      stop?.();
      stop = null;
      announced.clear();
    },
    /**
     * The frame whose context `contextId` or `uniqueContextId` names, the top one when neither
     * is given. Throws Chrome's error for a context that is gone or never was.
     */
    frameOf(contextId?: number, uniqueContextId?: string): Frame {
      // Nothing may have followed the frames (Runtime disabled, a navigation not yet loaded).
      if (contextId !== undefined || uniqueContextId !== undefined) frames.sync();
      if (uniqueContextId !== undefined) {
        const frame = Array.from(frames).find(f => uniqueIdOf(f.executionContextId) === uniqueContextId);
        // V8's word for an unknown uniqueContextId, an InvalidParams unlike an unknown executionContextId.
        if (!frame) throw new CdpError('uniqueContextId not found', -32602);
        return frame;
      }
      if (contextId === undefined) return frames.top;
      const frame = frames.byContext(contextId);
      if (!frame) throw new CdpError('Cannot find context with specified id');
      return frame;
    },
    /**
     * The frame whose realm made `value`, as far as can be told: a node's document, a window
     * itself, else the frame whose `Object.prototype` is in its prototype chain. The top one for
     * primitives, objects without a prototype and objects of no known frame.
     */
    frameOfValue(value: unknown): Frame {
      if (isNode(value)) return frames.ofNode(value);
      if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return frames.top;
      for (const frame of frames) {
        if (value === frame.window) return frame;
        try {
          if (realmOf(frame.document).Object.prototype.isPrototypeOf(value)) return frame;
        } catch {
          // A proxy whose getPrototypeOf trap throws.
        }
      }
      return frames.top;
    },
  };
}
