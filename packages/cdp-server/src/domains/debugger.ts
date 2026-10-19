import type { Protocol } from 'devtools-protocol';
import { CdpError } from '../core/server';
import { EXECUTION_CONTEXT_ID, type Context } from '../core/context';
import type { RequestRecord } from '../probe/types';
import { refetch } from './network';

/**
 * Lists the page's script files in the Sources panel. Page scripts cannot see the scripts
 * V8 compiled, so this reports the external scripts the page loaded: `<script src>`
 * elements and the scripts Resource Timing recorded (modules, dynamically added scripts).
 * Inline scripts are left out: their position in the document is not known.
 * devtools-anywhere's own scripts (the probe, the bundle) are listed too: they hook globals the
 * page uses and show in stack traces. The frontend ignore-lists them.
 * There are no breakpoints: the breakpoint commands are accepted and resolve to nothing.
 */
export function registerDebugger({ server, probe }: Context) {
  /** Script id per URL, stable for the page's lifetime. */
  const ids = new Map<string, string>();
  const sources = new Map<string, Promise<string>>();
  let enabled = false;
  /** Breakpoint ids are unique: the frontend keys its breakpoints by them. */
  let nextBreakpointId = 0;
  let unsubscribe: (() => void) | null = null;

  const isScript = (rec: RequestRecord) => rec.type === 'Script' && rec.state === 'done';

  function report(url: string, isModule: boolean) {
    if (!/^https?:/.test(url) || ids.has(url)) return;
    const scriptId = String(ids.size + 1);
    ids.set(url, scriptId);
    server.emit('Debugger.scriptParsed', {
      scriptId,
      url,
      startLine: 0,
      startColumn: 0,
      // Unknown until the source is loaded; the frontend reads the real extent from the source.
      endLine: 0,
      endColumn: 0,
      executionContextId: EXECUTION_CONTEXT_ID,
      hash: '',
      buildId: '',
      isModule,
      scriptLanguage: 'JavaScript',
    } satisfies Protocol.Debugger.ScriptParsedEvent);
  }

  function urlOf(scriptId: string) {
    for (const [url, id] of ids) if (id === scriptId) return url;
    throw new CdpError(`No script for id: ${scriptId}`);
  }

  server.register('Debugger', {
    enable(): Protocol.Debugger.EnableResponse {
      if (!enabled) {
        enabled = true;
        // Every script is reported again: the frontend forgets them on disable.
        ids.clear();
        for (const script of document.querySelectorAll<HTMLScriptElement>('script[src]'))
          report(script.src, script.type === 'module');
        for (const rec of probe.requests) if (isScript(rec)) report(rec.url, false);
        unsubscribe = probe.onRequest(rec => {
          if (isScript(rec)) report(rec.url, false);
        });
      }
      return { debuggerId: 'devtools-anywhere' };
    },
    disable() {
      enabled = false;
      unsubscribe?.();
      unsubscribe = null;
      // The frontend keeps the sources it loaded; holding them here too only costs page memory.
      sources.clear();
    },

    /** Re-fetches the script, from the HTTP cache when possible. */
    async getScriptSource(
      params: Protocol.Debugger.GetScriptSourceRequest
    ): Promise<Protocol.Debugger.GetScriptSourceResponse> {
      const url = urlOf(params.scriptId);
      let source = sources.get(url);
      if (!source) {
        source = refetch(probe, url).then(res => res.text());
        sources.set(url, source);
        source.catch(() => sources.delete(url));
      }
      return { scriptSource: await source };
    },

    getPossibleBreakpoints: (): Protocol.Debugger.GetPossibleBreakpointsResponse => ({ locations: [] }),
    setBreakpointByUrl: (): Protocol.Debugger.SetBreakpointByUrlResponse => ({
      breakpointId: String(++nextBreakpointId),
      locations: [],
    }),
    removeBreakpoint: () => {},
    setAsyncCallStackDepth: () => {},
    setBlackboxPatterns: () => {},
    setBlackboxExecutionContexts: () => {},
    setPauseOnExceptions: () => {},
    setBreakpointsActive: () => {},
    setSkipAllPauses: () => {},
  });
}
