// Emulation.setDeviceMetricsOverride's params as Chrome takes them, for shell mode, where the
// shell rather than Chrome sets the page's size (connection.ts): the same checks, with Chrome's
// messages, and Chrome's notion of the same override. Measured in Chrome
// (tests/e2e/shell-emulation.test.ts).
import { CdpError } from './cdp-agent';

const MAX_SIZE = 10_000_000;
const MAX_SCALE = 10;
const ORIENTATIONS = ['portraitPrimary', 'portraitSecondary', 'landscapePrimary', 'landscapeSecondary'];
const INVALID_PARAMS = -32602;

const field = (params: unknown, name: string): unknown =>
  typeof params === 'object' && params !== null ? Reflect.get(params, name) : undefined;

/** A field's type as Chrome deserializes it; `!` marks a mandatory one. An object is a nested schema. */
type Schema = { readonly [name: string]: string | Schema };

const PARAMS: Schema = {
  'width!': 'int32',
  'height!': 'int32',
  'deviceScaleFactor!': 'double',
  'mobile!': 'bool',
  scale: 'double',
  screenWidth: 'int32',
  screenHeight: 'int32',
  positionX: 'int32',
  positionY: 'int32',
  dontSetVisibleSize: 'bool',
  screenOrientation: { 'type!': 'string', 'angle!': 'int32' },
  viewport: { 'x!': 'double', 'y!': 'double', 'width!': 'double', 'height!': 'double', 'scale!': 'double' },
  displayFeature: { 'orientation!': 'string', 'offset!': 'int32', 'maskLength!': 'int32' },
  // Any type is taken. Chrome stops answering one it does not know (the session hangs): deliberately
  // not mirrored.
  devicePosture: { 'type!': 'string' },
  scrollbarType: 'string',
};

/**
 * Throws Chrome's error for what it fails to deserialize: the fields in the order given (unknown
 * ones ignored), each object's missing mandatory fields after its given ones, by name.
 */
function deserialize(value: object, schema: Schema, path: string) {
  // Chrome's data text, without its "at position N": the byte offset in Chrome's CBOR encoding of
  // the params, which the page does not have.
  const bad = (name: string, why: string): never => {
    throw new CdpError('Invalid parameters', INVALID_PARAMS, `Failed to deserialize ${path}${name} - ${why}`);
  };
  const types = new Map(Object.entries(schema).map(([key, type]) => [key.replace(/!$/, ''), type]));
  for (const [name, given] of Object.entries(value)) {
    const type = types.get(name);
    if (type === undefined) continue;
    if (typeof type === 'object') {
      if (typeof given !== 'object' || given === null || Array.isArray(given)) bad(name, 'CBOR: map start expected');
      else deserialize(given, type, `${path}${name}.`);
      continue;
    }
    const ok =
      type === 'bool'
        ? typeof given === 'boolean'
        : type === 'string'
          ? typeof given === 'string'
          : typeof given === 'number' &&
            (type === 'double' || (Number.isInteger(given) && given >= -(2 ** 31) && given < 2 ** 31));
    if (!ok) bad(name, `BINDINGS: ${type} value expected`);
  }
  const missing = Object.keys(schema)
    .filter(key => key.endsWith('!') && field(value, key.slice(0, -1)) === undefined)
    .map(key => key.slice(0, -1))
    .sort()[0];
  if (missing !== undefined) bad(missing, 'BINDINGS: mandatory field missing');
}

/** Throws Chrome's error for `params` it would reject. */
export function checkMetrics(params: object) {
  const fail = (message: string): never => {
    throw new CdpError(message, INVALID_PARAMS);
  };
  deserialize(params, PARAMS, 'params.');
  const number = (name: string, fallback: number) => {
    const value = field(params, name);
    return typeof value === 'number' ? value : fallback;
  };
  const width = number('width', 0);
  const height = number('height', 0);
  const screenWidth = number('screenWidth', 0);
  const screenHeight = number('screenHeight', 0);
  if (width < 0 || height < 0 || width > MAX_SIZE || height > MAX_SIZE)
    fail(`Width and height values must be positive, not greater than ${MAX_SIZE}`);
  if (screenWidth < 0 || screenHeight < 0 || screenWidth > MAX_SIZE || screenHeight > MAX_SIZE)
    fail(`Screen width and height values must be positive, not greater than ${MAX_SIZE}`);
  const x = number('positionX', 0);
  const y = number('positionY', 0);
  if (x < 0 || y < 0 || x > screenWidth || y > screenHeight) fail('View position should be on the screen');
  if (number('deviceScaleFactor', 0) < 0) fail('deviceScaleFactor must be non-negative');
  const scale = number('scale', 1);
  if (scale <= 0 || scale > MAX_SCALE) fail(`scale must be positive, not greater than ${MAX_SCALE}`);
  const orientation = field(params, 'screenOrientation');
  if (orientation !== undefined) {
    const angle = field(orientation, 'angle');
    if (typeof angle !== 'number' || angle < 0 || angle >= 360)
      fail('Screen orientation angle must be non-negative, less than 360');
    if (!ORIENTATIONS.includes(String(field(orientation, 'type')))) fail('Invalid screen orientation type value');
  }
  const feature = field(params, 'displayFeature');
  if (feature !== undefined) {
    const offset = Number(field(feature, 'offset'));
    const mask = Number(field(feature, 'maskLength'));
    if (!(offset >= 0 && mask >= 0)) fail('Negative display feature parameters');
    const along = field(feature, 'orientation');
    if (along !== 'vertical' && along !== 'horizontal') fail('Invalid display feature orientation type');
    if (along === 'vertical' && offset + mask > width) fail('Display feature viewport segments outside screen width');
    if (along === 'horizontal' && offset + mask > height)
      fail('Display feature viewport segments outside screen height');
  }
}

/**
 * Whether two overrides are the same to Chrome, which then does nothing: the fields it keeps,
 * omitted ones as their defaults (a view position only when both coordinates are given), in any
 * order. A screen orientation, viewport or display feature given differs from none, and is
 * compared by the fields Chrome knows of it; no device posture is a continuous one.
 */
export function sameMetrics(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  const value = (params: unknown, name: string, fallback: unknown) => field(params, name) ?? fallback;
  const position = (params: unknown) =>
    field(params, 'positionX') !== undefined && field(params, 'positionY') !== undefined
      ? `${String(field(params, 'positionX'))},${String(field(params, 'positionY'))}`
      : undefined;
  const nested = (params: unknown, name: string) => {
    const object = field(params, name) ?? (name === 'devicePosture' ? { type: 'continuous' } : undefined);
    const schema = PARAMS[name];
    if (object === undefined || typeof schema !== 'object') return undefined;
    return JSON.stringify(Object.keys(schema).map(key => field(object, key.replace(/!$/, ''))));
  };
  const flat: [string, unknown][] = [
    ['width', 0],
    ['height', 0],
    ['deviceScaleFactor', 0],
    ['mobile', false],
    ['scale', 1],
    ['screenWidth', 0],
    ['screenHeight', 0],
  ];
  return (
    flat.every(([name, fallback]) => value(a, name, fallback) === value(b, name, fallback)) &&
    position(a) === position(b) &&
    ['screenOrientation', 'viewport', 'displayFeature', 'devicePosture'].every(
      name => nested(a, name) === nested(b, name)
    )
  );
}
