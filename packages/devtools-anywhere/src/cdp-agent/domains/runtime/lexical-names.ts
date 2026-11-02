import type { ProbeView } from '../../core/probe-view';
import { isElement, isHtml } from '../../core/realm';
import { topLevelLexicalNames } from '../../core/lexer';
import { refetch } from '../network/network';
import { IDENTIFIER } from './repl';

/**
 * The names the page's classic scripts declared with top-level `let`, `const` and `class`
 * (Runtime.globalLexicalScopeNames). Page scripts cannot list the global lexical scope, so the
 * sources are lexed: inline `<script>`s and the external scripts the page loaded (fetched again,
 * from the HTTP cache), each once. Module scripts are left out: their declarations are not global.
 * Each name is then looked up, which drops the ones not declared (a script that did not compile, a
 * module's name). The console's declarations (see `replBindings`) are added by the caller.
 *
 * One per frame document `doc`, whose global code `evaluate` runs. The probe sees the requests of
 * the top page only (`isTop`): an iframe's scripts are those in its document.
 */
export function globalLexicalNames(
  probe: ProbeView,
  doc: Document,
  evaluate: (code: string) => unknown,
  isTop: boolean
) {
  /**
   * Names per external script URL, and per inline script text. Each pass keeps only the entries it
   * used, so scripts gone from the page and from `probe.requests` do not stay in memory.
   */
  let external = new Map<string, Promise<string[]>>();
  let inline = new Map<string, string[]>();
  let nextExternal = new Map<string, Promise<string[]>>();
  let nextInline = new Map<string, string[]>();

  const lex = (source: string) => {
    try {
      return topLevelLexicalNames(source);
    } catch {
      return [];
    }
  };
  const isModule = (script: HTMLScriptElement) => script.type.trim().toLowerCase() === 'module';
  const isClassic = (script: HTMLScriptElement) =>
    !script.type || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/i.test(script.type.trim());

  /**
   * `cachedOnly`: a script no longer in the document (often JSONP, or a URL with a timestamp) is
   * read only from the HTTP cache, and left out when it cannot be: fetching it again would hit the
   * network and run the server's side effects again.
   */
  function fromUrl(url: string, cachedOnly = false): Promise<string[]> {
    let names = nextExternal.get(url) ?? external.get(url);
    if (!names) {
      const res = cachedOnly
        ? url.startsWith(`${doc.location?.origin ?? ''}/`)
          ? probe.fetch(url, { cache: 'only-if-cached', mode: 'same-origin' }).then(res => {
              if (!res.ok) throw new Error(`${res.status}`);
              return res;
            })
          : Promise.reject(new Error('cross-origin'))
        : refetch(probe, url);
      names = res.then(res => res.text()).then(lex, () => []);
    }
    nextExternal.set(url, names);
    return names;
  }

  function declared(name: string): boolean {
    if (!IDENTIFIER.test(name)) return false;
    try {
      // A ReferenceError: not declared, or declared but in its temporal dead zone.
      evaluate(name);
      return true;
    } catch {
      try {
        // Like V8, a name in its temporal dead zone is listed: only there does `typeof` throw.
        evaluate(`typeof ${name}`);
        return false;
      } catch {
        return true;
      }
    }
  }

  /** The last result, until a script is added, removed or loaded. */
  let cached: Promise<string[]> | undefined;
  /** Stops watching the scripts, while watching. */
  let unwatch: (() => void) | null = null;
  const invalidate = () => {
    cached = undefined;
  };
  const hasScript = (node: Node) => isHtml(node, 'script') || (isElement(node) && !!node.querySelector('script'));
  function watch() {
    if (unwatch) return;
    const offRequest = isTop
      ? probe.onRequest(rec => {
          if (rec.type === 'Script' && rec.state === 'done') invalidate();
        })
      : () => {};
    const observer = new MutationObserver(records => {
      const inScript = (node: Node) => isHtml(node, 'script') || isHtml(node.parentNode, 'script');
      if (records.some(r => inScript(r.target) || [...r.addedNodes, ...r.removedNodes].some(hasScript))) invalidate();
    });
    observer.observe(doc, { childList: true, subtree: true, characterData: true });
    unwatch = () => {
      offRequest();
      observer.disconnect();
    };
  }

  return {
    /** Also the moment to look again: page code may have changed what is declared. */
    invalidate,
    list(): Promise<string[]> {
      watch();
      cached ??= compute();
      return cached;
    },
    /** Stops watching the scripts (the session ended); the next list() looks again. */
    stop() {
      unwatch?.();
      unwatch = null;
      invalidate();
    },
  };

  async function compute(): Promise<string[]> {
    {
      const lists: (string[] | Promise<string[]>)[] = [];
      const modules = new Set<string>();
      for (const script of doc.querySelectorAll<HTMLScriptElement>('script')) {
        if (script.src) {
          if (isModule(script)) modules.add(script.src);
          else if (isClassic(script) && /^https?:/.test(script.src) && !probe.ownUrls.has(script.src))
            lists.push(fromUrl(script.src));
        } else if (isClassic(script)) {
          const text = script.text;
          const names = nextInline.get(text) ?? inline.get(text) ?? lex(text);
          nextInline.set(text, names);
          lists.push(names);
        }
      }
      // Scripts added and removed again, or loaded by other means.
      for (const rec of isTop ? probe.requests : [])
        if (rec.type === 'Script' && rec.state === 'done' && !modules.has(rec.url) && !probe.ownUrls.has(rec.url))
          lists.push(fromUrl(rec.url, true));
      external = nextExternal;
      inline = nextInline;
      nextExternal = new Map();
      nextInline = new Map();
      const names = new Set<string>();
      for (const list of await Promise.all(lists)) for (const name of list) names.add(name);
      return [...names].filter(declared);
    }
  }
}
