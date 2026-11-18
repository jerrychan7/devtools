import { quietly } from '../../core/nodes/adopted';
import { markOwn } from '../../core/nodes/nodes';
import { realmOf } from '../../core/realm';

/** The env() variables Chrome defines with one value each; viewport-segment-* take indices. */
const ENV_VARIABLES = [
  ...['top', 'right', 'bottom', 'left'].flatMap(side => [`safe-area-inset-${side}`, `safe-area-max-inset-${side}`]),
  ...['top', 'right', 'bottom', 'left', 'width', 'height'].map(name => `keyboard-inset-${name}`),
  ...['x', 'y', 'width', 'height'].map(name => `titlebar-area-${name}`),
];

/** A fallback no variable is expected to have, telling an undefined one apart. */
const UNDEFINED_ENV = '-98765.4px';

/** The env() variables the document defines, read through the computed style of a probe element. */
export function environmentVariables(doc: Document | undefined): Record<string, string> {
  if (!doc?.documentElement) return {};
  const probe = doc.createElement('span');
  markOwn(probe);
  probe.style.display = 'none';
  const out: Record<string, string> = {};
  quietly(() => doc.documentElement.appendChild(probe));
  try {
    for (const name of ENV_VARIABLES) {
      probe.style.marginLeft = `env(${name}, ${UNDEFINED_ENV})`;
      const value = realmOf(probe).getComputedStyle(probe).marginLeft;
      if (value && value !== UNDEFINED_ENV) out[name] = value;
    }
  } finally {
    quietly(() => probe.remove());
  }
  return out;
}
