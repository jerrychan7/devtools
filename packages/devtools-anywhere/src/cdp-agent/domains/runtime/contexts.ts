import type { Protocol } from 'devtools-protocol';
import { type Frame, type FrameChange, type FrameRegistry, awaitsFirstDocument } from '../../core/frames/frames';
import { NS_STRIDE, nsPrefix } from '../../core/frames/merged-frames';
import { isNode, realmOf } from '../../core/realm';
import { CdpError } from '../../core/session';
import type { IsolatedWorlds, World } from './worlds';

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
 * The execution contexts the client knows of: the default one of each frame's document, and its
 * isolated worlds (./worlds.ts). Like Chrome, Runtime.enable announces all of them, then each
 * frame's document as it comes (executionContextCreated, its worlds after it) and goes
 * (executionContextDestroyed, for a frame navigated before the new document's context is created).
 */
export function executionContexts(
  frames: FrameRegistry,
  worlds: IsolatedWorlds,
  emit: (method: string, params: object) => void
) {
  /** The contexts announced for each frame, default first: the registry has moved on once a frame navigated. */
  const announced = new Map<Frame, number[]>();
  let stop: (() => void) | null = null;

  function announce(frame: Frame, id: number, world?: World) {
    const ids = announced.get(frame) ?? [];
    if (ids.includes(id)) return;
    announced.set(frame, [...ids, id]);
    emit('Runtime.executionContextCreated', {
      context: {
        id,
        // The document's origin, inherited by about:blank and about:srcdoc.
        origin: originOf(frame),
        name: world?.name ?? '',
        uniqueId: uniqueIdOf(id),
        auxData: { isDefault: !world, type: world ? 'isolated' : 'default', frameId: frame.id },
      },
    } satisfies Protocol.Runtime.ExecutionContextCreatedEvent);
  }

  function created(frame: Frame) {
    // Chrome creates none for the initial about:blank an iframe leaves for its src.
    if (awaitsFirstDocument(frame)) return;
    announce(frame, frame.executionContextId);
    for (const world of worlds.of(frame)) announce(frame, world.id, world);
  }

  function destroyed(frame: Frame) {
    const ids = announced.get(frame);
    if (!ids) return;
    announced.delete(frame);
    for (const id of ids)
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
      const all = Array.from(frames)
        .filter(frame => !awaitsFirstDocument(frame))
        .flatMap(frame =>
          [{ frame, id: frame.executionContextId, world: undefined as World | undefined }].concat(
            worlds.of(frame).map(world => ({ frame, id: world.id, world }))
          )
        );
      for (const { frame, id, world } of all.sort((a, b) => b.id - a.id)) announce(frame, id, world);
      const offFrames = frames.onChange(onChange);
      // A world made meanwhile (Page.createIsolatedWorld), once its frame's document is announced.
      const offWorlds = worlds.onCreated(world => {
        if (announced.get(world.frame)?.includes(world.frame.executionContextId))
          announce(world.frame, world.id, world);
      });
      stop = () => {
        offFrames();
        offWorlds();
      };
    },
    disable() {
      stop?.();
      stop = null;
      announced.clear();
    },
    /**
     * The isolated world `contextId` or `uniqueContextId` names, if it names one (else see
     * {@link frameOf}).
     */
    worldOf(contextId?: number, uniqueContextId?: string): World | undefined {
      if (contextId !== undefined) return worlds.byId(contextId);
      if (uniqueContextId === undefined) return undefined;
      return worlds.all().find(world => uniqueIdOf(world.id) === uniqueContextId);
    },
    /**
     * The frame whose context `contextId` or `uniqueContextId` names, the top one when neither
     * is given. Throws Chrome's error for a context that is gone or never was.
     */
    frameOf(contextId?: number, uniqueContextId?: string): Frame {
      // Nothing may have followed the frames (Runtime disabled, a navigation not yet loaded).
      if (contextId !== undefined || uniqueContextId !== undefined) frames.sync();
      if (uniqueContextId !== undefined) {
        const frame =
          Array.from(frames).find(f => uniqueIdOf(f.executionContextId) === uniqueContextId) ??
          this.worldOf(undefined, uniqueContextId)?.frame;
        // V8's word for an unknown uniqueContextId, an InvalidParams unlike an unknown executionContextId.
        if (!frame) throw new CdpError('uniqueContextId not found', -32602);
        return frame;
      }
      if (contextId === undefined) return frames.top;
      const frame = frames.byContext(contextId) ?? worlds.byId(contextId)?.frame;
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
