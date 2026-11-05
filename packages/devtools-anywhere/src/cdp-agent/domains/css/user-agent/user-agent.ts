import type { Protocol } from 'devtools-protocol';
import { isCssom, isHtml } from '../../../core/realm';
import { type PseudoType, hasPseudoElement } from '../../../core/nodes/nodes';
import { compareSpecificity, specificity, splitTopLevel } from '../../../core/style/selectors';
import { splitPseudoElement } from '../style';

/**
 * Chromium's default style sheet for HTML (html.css, see README.md here), next to the bundle in
 * dist/ (build.ts copies it), loaded the first time a node's matched styles are asked for.
 */
export const USER_AGENT_SHEET = 'chromium-html.css';

const XHTML = 'http://www.w3.org/1999/xhtml';

/**
 * Where the sheet is: next to the bundle, whose script is the top page's current one while the
 * bundle runs. Null when the bundle was not loaded from a URL (an inline script): no user agent
 * rules then.
 */
const current = document.currentScript;
export const userAgentSheetUrl =
  isHtml(current, 'script') && current.src ? new URL(USER_AGENT_SHEET, current.src).href : null;

type UaRule = {
  selectors: { text: string; host: string; pseudo: string | null; spec: Protocol.CSS.Specificity }[];
  style: Protocol.CSS.CSSStyle;
  order: number;
};

/**
 * The rules of the user agent style sheet that match an element, as Chrome reports them: origin
 * `user-agent`, without a style sheet id or source ranges.
 *
 * The page parses the sheet as an author's: rules with Blink's internal selectors
 * (`:-internal-*`) are dropped, and of `@supports blink-feature(…)` the branch for the feature
 * turned off is taken. What is left covers the defaults of ordinary elements (display, margins,
 * fonts of headings, lists, form controls, …).
 */
export class UserAgentStyles {
  private rules: UaRule[] | null = null;
  private loading: Promise<void> | null = null;
  private readonly load: () => Promise<string>;

  constructor(load: () => Promise<string>) {
    this.load = load;
  }

  /** Loads the sheet once; until it is in (or if it fails), no user agent rules are reported. */
  ready(): Promise<void> {
    if (this.rules) return Promise.resolve();
    this.loading ??= this.load().then(
      text => {
        this.rules = parse(text);
      },
      () => {
        // Tried again with the next request.
        this.loading = null;
      }
    );
    return this.loading;
  }

  /** The rules matching `el` (or its `pseudo` pseudo-element), lowest priority first. */
  matchedRules(el: Element, pseudo: PseudoType | null): Protocol.CSS.RuleMatch[] {
    // Its type selectors are of the HTML namespace (@namespace), which el.matches() does not know.
    if (!this.rules || el.namespaceURI !== XHTML) return [];
    // A rule for every ::marker is not one for an element without a marker.
    if (pseudo && !hasPseudoElement(el, pseudo)) return [];
    const matches: { match: Protocol.CSS.RuleMatch; spec: Protocol.CSS.Specificity; order: number }[] = [];
    for (const rule of this.rules) {
      const matched = rule.selectors.flatMap((s, index) => {
        if (s.pseudo !== pseudo) return [];
        try {
          return el.matches(s.host) ? [{ index, spec: s.spec }] : [];
        } catch {
          return []; // Unsupported selector.
        }
      });
      if (!matched.length) continue;
      matches.push({
        match: {
          rule: {
            selectorList: {
              selectors: rule.selectors.map(s => ({ text: s.text, specificity: s.spec })),
              text: rule.selectors.map(s => s.text).join(', '),
            },
            origin: 'user-agent',
            style: rule.style,
            media: [],
            containerQueries: [],
            supports: [],
            layers: [],
            scopes: [],
            ruleTypes: [],
            startingStyles: [],
            navigations: [],
          },
          matchingSelectors: matched.map(m => m.index),
        },
        spec: matched.map(m => m.spec).reduce((m, s) => (compareSpecificity(s, m) > 0 ? s : m)),
        order: rule.order,
      });
    }
    return matches.sort((x, y) => compareSpecificity(x.spec, y.spec) || x.order - y.order).map(m => m.match);
  }
}

/** The style rules of the sheet, in order, with those of @supports and @media that hold. */
function parse(text: string): UaRule[] {
  const sheet = new CSSStyleSheet();
  // Blink's quirky em (1__qem) is an em, as Chrome shows it, for the page's parser.
  sheet.replaceSync(text.replace(/(\d)__qem\b/g, '$1em'));
  const rules: UaRule[] = [];
  const add = (selectorText: string, decl: CSSStyleDeclaration) => {
    const selectors = splitTopLevel(selectorText, ',').map(raw => {
      const text = raw.trim();
      const { host, pseudo } = splitPseudoElement(text);
      return { text, host, pseudo, spec: specificity(text) };
    });
    rules.push({ selectors, style: styleOf(decl), order: rules.length });
  };
  const visit = (list: CSSRuleList, parent: string | null) => {
    for (const rule of Array.from(list)) {
      if (isCssom(rule, 'CSSStyleRule')) {
        add(rule.selectorText, rule.style);
        // Only @supports and @media nested in it, whose declarations are its own.
        visit(rule.cssRules, rule.selectorText);
      } else if (isCssom(rule, 'CSSNestedDeclarations')) {
        if (parent !== null) add(parent, rule.style);
      } else if (isCssom(rule, 'CSSSupportsRule')) {
        if (CSS.supports(rule.conditionText)) visit(rule.cssRules, parent);
      } else if (isCssom(rule, 'CSSMediaRule')) {
        if (matchMedia(rule.conditionText).matches) visit(rule.cssRules, parent);
      }
    }
  };
  visit(sheet.cssRules, null);
  // Like Chrome, rules whose declarations are all Blink's own are listed, empty.
  return rules;
}

/** Its longhands, as Chrome lists a user agent rule's (no shorthands, no source text). */
function styleOf(decl: CSSStyleDeclaration): Protocol.CSS.CSSStyle {
  const cssProperties = Array.from(decl, name => {
    const value = decl.getPropertyValue(name);
    // Like Chrome, the value of an important one says so too.
    return decl.getPropertyPriority(name) ? { name, value: `${value} !important`, important: true } : { name, value };
  });
  return { cssProperties, shorthandEntries: [] };
}
