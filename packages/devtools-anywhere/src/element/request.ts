// Requests from the frontend (embedder.ts), checked: it is built separately, and any window can post.
import { DOCK_SIDES, type DockSide, type EmbedderRequest } from '../embedder';

/** A finite number from a stored value, else undefined. */
export const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export const isDockSide = (value: unknown): value is DockSide => DOCK_SIDES.some(side => side === value);

/**
 * Checks the fields of each type of request from the frontend, which is built separately: a type
 * added to EmbedderRequest (embedder.ts) does not compile here until it is checked.
 */
const REQUEST_CHECKS: { [T in EmbedderRequest['type']]: (request: object) => boolean } = {
  dock: request => 'side' in request && isDockSide(request.side),
  close: () => true,
  'keep-open': request => 'keep' in request && typeof request.keep === 'boolean',
  theme: request => ['toolbar', 'divider', 'icon'].every(key => typeof Reflect.get(request, key) === 'string'),
  'page-bounds': request => ['x', 'y', 'width', 'height'].every(key => finite(Reflect.get(request, key)) !== undefined),
  split: request => ['x', 'y', 'width', 'height'].every(key => finite(Reflect.get(request, key)) !== undefined),
  toolbox: request => 'url' in request && typeof request.url === 'string',
};
const isRequestType = (type: unknown): type is EmbedderRequest['type'] =>
  typeof type === 'string' && Object.hasOwn(REQUEST_CHECKS, type);
export const isEmbedderRequest = (value: unknown): value is EmbedderRequest =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  isRequestType(value.type) &&
  REQUEST_CHECKS[value.type](value);
