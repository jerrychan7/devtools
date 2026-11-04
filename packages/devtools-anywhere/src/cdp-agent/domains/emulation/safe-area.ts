import type { Protocol } from 'devtools-protocol';
import type { Rewrite } from './rewrite';

const ENV = /env\(\s*safe-area-(max-)?inset-(top|left|bottom|right)\s*[,)]/gi;

/**
 * The rewrite of declaration blocks for Emulation.setSafeAreaInsetsOverride's insets, or null when
 * none is set: each `env(safe-area-inset-*)` and `env(safe-area-max-inset-*)` (fallback included)
 * whose inset is set becomes its length. Like Chrome, an inset not set keeps its real value.
 */
export function safeAreaRewrite(insets: Protocol.Emulation.SafeAreaInsets): Rewrite | null {
  const values = new Map<string, number>();
  for (const side of ['top', 'left', 'bottom', 'right'] as const) {
    const inset = insets[side];
    const max = insets[`${side}Max`];
    if (inset !== undefined) values.set(side, inset);
    if (max !== undefined) values.set(`${side}Max`, max);
  }
  if (!values.size) return null;
  return text => {
    let out = '';
    let from = 0;
    for (const m of text.matchAll(ENV)) {
      if (m.index < from) continue;
      const value = values.get(`${(m[2] ?? '').toLowerCase()}${m[1] ? 'Max' : ''}`);
      if (value === undefined) continue;
      // The end of env(…), past a fallback with parentheses of its own.
      let end = m.index + m[0].length;
      for (let depth = m[0].endsWith(')') ? 0 : 1; depth && end < text.length; end++) {
        if (text[end] === '(') depth++;
        else if (text[end] === ')') depth--;
      }
      out += `${text.slice(from, m.index)}${value}px`;
      from = end;
    }
    return out + text.slice(from);
  };
}
