import type { Protocol } from 'devtools-protocol';
import { CdpError, type CdpSession } from '../../core/session';

/** What a `long-animation-frame` entry tells of one script it ran (lib.dom lacks the type). */
interface ScriptTiming {
  invokerType: string;
  invoker: string;
  duration: number;
  startTime: number;
  forcedStyleAndLayoutDuration: number;
  sourceURL: string;
}

function isScriptTiming(value: unknown): value is ScriptTiming {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'invoker') === 'string' &&
    typeof Reflect.get(value, 'duration') === 'number'
  );
}

/** Handlers Chrome holds to the recurring threshold: called over and over, each run must be short. */
const RECURRING = new Set([
  'requestAnimationFrame',
  'setInterval',
  'scroll',
  'wheel',
  'mousemove',
  'pointermove',
  'touchmove',
  'resize',
]);

/**
 * The name Chrome gives a script's handler: `'setTimeout' handler took 249ms`. A
 * `TimerHandler:setTimeout` callback is its timer's, an event listener (`BODY.onclick`) its
 * event's; scripts that ran on their own (a parsed `<script>`, a promise reaction) are not handlers.
 */
function handlerName({ invokerType, invoker }: ScriptTiming): string | undefined {
  if (invokerType === 'event-listener') return /\.on([^.]+)$/.exec(invoker)?.[1];
  if (invokerType !== 'user-callback') return undefined;
  if (invoker.startsWith('TimerHandler:')) return invoker.slice('TimerHandler:'.length);
  if (invoker === 'FrameRequestCallback') return 'requestAnimationFrame';
  if (invoker === 'IdleRequestCallback') return 'requestIdleCallback';
  return undefined;
}

/**
 * `Log.startViolationsReport`: Chrome's `[Violation]` console messages for slow handlers and forced
 * reflows, from the scripts `long-animation-frame` entries attribute their time to. Like Chrome, a
 * handler over its threshold is `'<name>' handler took <n>ms`, a reflow `Forced reflow while
 * executing JavaScript took <n>ms`; unlike it, with the script's URL but no line (an entry gives a
 * character offset into a source the page may not be able to read again).
 */
export function registerViolations(session: CdpSession, win: Window) {
  let observer: PerformanceObserver | null = null;
  session.onReset(() => {
    observer?.disconnect();
    observer = null;
  });

  function report(text: string, script: ScriptTiming, end: number) {
    session.emit('Log.entryAdded', {
      entry: {
        source: 'violation',
        level: 'verbose',
        text,
        timestamp: win.performance.timeOrigin + end,
        ...(script.sourceURL ? { url: script.sourceURL } : {}),
      },
    } satisfies Protocol.Log.EntryAddedEvent);
  }

  session.register('Log', {
    startViolationsReport({ config }: Protocol.Log.StartViolationsReportRequest) {
      if (!PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
        throw new CdpError('Not supported in the page: the browser does not time long animation frames');
      }
      const threshold = (name: Protocol.Log.ViolationSetting['name']) =>
        config.find(setting => setting.name === name)?.threshold ?? -1;
      // A one-off handler Chrome holds to the handler threshold, else to the long task one.
      const handler = threshold('handler') > 0 ? threshold('handler') : threshold('longTask');
      const recurring = threshold('recurringHandler');
      const layout = threshold('longLayout');
      observer?.disconnect();
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const scripts: unknown = Reflect.get(entry, 'scripts');
          if (!Array.isArray(scripts)) continue;
          for (const script of scripts) {
            if (!isScriptTiming(script)) continue;
            const end = script.startTime + script.duration;
            const name = handlerName(script);
            const limit = name && RECURRING.has(name) ? recurring : handler;
            if (name && limit > 0 && script.duration >= limit) {
              report(`'${name}' handler took ${Math.round(script.duration)}ms`, script, end);
            }
            const reflow = script.forcedStyleAndLayoutDuration;
            if (layout > 0 && reflow >= layout) {
              report(`Forced reflow while executing JavaScript took ${Math.round(reflow)}ms`, script, end);
            }
          }
        }
      });
      observer.observe({ type: 'long-animation-frame' });
    },

    stopViolationsReport() {
      observer?.disconnect();
      observer = null;
    },
  });
}
