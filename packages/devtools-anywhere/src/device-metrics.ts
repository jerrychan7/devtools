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

/** Throws Chrome's error for `params` it would reject. */
export function checkMetrics(params: object) {
  const fail = (message: string): never => {
    throw new CdpError(message, INVALID_PARAMS);
  };
  // What Chrome fails to deserialize, field by field.
  const typed = (name: string, type: 'int32' | 'double' | 'bool', mandatory: boolean) => {
    const value = field(params, name);
    if (value === undefined) {
      if (mandatory) bad(name, 'mandatory field missing');
      return;
    }
    const ok =
      type === 'bool'
        ? typeof value === 'boolean'
        : typeof value === 'number' && (type === 'double' || (Number.isInteger(value) && Math.abs(value) < 2 ** 31));
    if (!ok) bad(name, `${type === 'bool' ? 'bool' : type} value expected`);
  };
  const bad = (name: string, why: string): never => {
    throw new CdpError('Invalid parameters', INVALID_PARAMS, `Failed to deserialize params.${name} - BINDINGS: ${why}`);
  };
  typed('width', 'int32', true);
  typed('height', 'int32', true);
  typed('deviceScaleFactor', 'double', true);
  typed('mobile', 'bool', true);
  typed('scale', 'double', false);
  for (const name of ['screenWidth', 'screenHeight', 'positionX', 'positionY']) typed(name, 'int32', false);
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
 * order. A screen orientation, viewport or display feature given differs from none.
 */
export function sameMetrics(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  const value = (params: unknown, name: string, fallback: unknown) => field(params, name) ?? fallback;
  const position = (params: unknown) =>
    field(params, 'positionX') !== undefined && field(params, 'positionY') !== undefined
      ? `${String(field(params, 'positionX'))},${String(field(params, 'positionY'))}`
      : undefined;
  const nested = (params: unknown, name: string) => {
    const object = field(params, name);
    if (typeof object !== 'object' || object === null) return undefined;
    return JSON.stringify(Object.entries(object).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
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
