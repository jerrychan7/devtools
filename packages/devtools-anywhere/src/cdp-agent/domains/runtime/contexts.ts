import type { Protocol } from 'devtools-protocol';
import { type Frame, type FrameChange, type FrameRegistry, awaitsFirstDocument } from '../../core/frames';
import { CdpError } from '../../core/session';

const uniqueIdOf = (contextId: number) => `devtools-anywhere-context-${contextId}`;

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
        origin: frame.window.origin,
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
      if (uniqueContextId !== undefined) {
        const frame = Array.from(frames).find(f => uniqueIdOf(f.executionContextId) === uniqueContextId);
        if (!frame) throw new CdpError('Cannot find context with specified id');
        return frame;
      }
      if (contextId === undefined) return frames.top;
      const frame = frames.byContext(contextId);
      if (!frame) throw new CdpError('Cannot find context with specified id');
      return frame;
    },
  };
}
