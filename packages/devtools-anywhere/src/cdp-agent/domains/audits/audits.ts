import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import type { Frame } from '../../core/frames';
import { isElement, isNode } from '../../core/realm';

type Issue = Protocol.Audits.InspectorIssue;
type FormError = Protocol.Audits.GenericIssueErrorType;

/** Doctypes that put a document in limited-quirks mode (HTML's "limited-quirks mode" doctypes). */
const LIMITED_QUIRKS = [/^-\/\/W3C\/\/DTD XHTML 1\.0 (Frameset|Transitional)\/\//i];
const LIMITED_QUIRKS_WITH_SYSTEM_ID = [/^-\/\/W3C\/\/DTD HTML 4\.01 (Frameset|Transitional)\/\//i];

function isLimitedQuirks(doc: Document): boolean {
  const type = doc.doctype;
  if (!type || doc.compatMode !== 'CSS1Compat') return false;
  return (
    LIMITED_QUIRKS.some(re => re.test(type.publicId)) ||
    (!!type.systemId && LIMITED_QUIRKS_WITH_SYSTEM_ID.some(re => re.test(type.publicId)))
  );
}

/** Form controls whose id and name Chrome's autofill reads. */
const isControl = (el: Element) =>
  (el.localName === 'input' &&
    !['hidden', 'submit', 'button', 'reset', 'image'].includes(el.getAttribute('type')?.toLowerCase() ?? '')) ||
  el.localName === 'select' ||
  el.localName === 'textarea';

/**
 * Audits: the Issues panel's issues a page can find on its own, worded as Chrome's. Content
 * Security Policy violations (`securitypolicyviolation`), deprecations (`ReportingObserver`),
 * quirks mode documents and form issues (from the DOM, as Chrome's autofill finds them). Cookie,
 * CORS and mixed content issues are the browser's alone.
 */
export function registerAudits({ session, nodes, frames }: Context) {
  const top = frames.top;
  const win = top.window;
  /** Every issue found, so a client enabling the domain later gets them, as in Chrome. */
  const found: Issue[] = [];
  const keys = new Set<string>();
  let enabled = false;
  let mutations: MutationObserver | null = null;
  let scan = 0;

  function add(key: string, issue: Issue) {
    if (keys.has(key)) return;
    keys.add(key);
    found.push(issue);
    if (enabled) session.emit('Audits.issueAdded', { issue } satisfies Protocol.Audits.IssueAddedEvent);
  }

  // Like Chrome, issues are found from the start, not only while a client listens.
  win.document.addEventListener('securitypolicyviolation', event => {
    const inline = event.blockedURI === 'inline' || event.blockedURI === 'eval';
    const element = isNode(event.target) && isElement(event.target) ? event.target : null;
    const issue: Protocol.Audits.ContentSecurityPolicyIssueDetails = {
      ...(inline ? {} : { blockedURL: event.blockedURI }),
      violatedDirective: event.effectiveDirective,
      isReportOnly: event.disposition === 'report',
      contentSecurityPolicyViolationType:
        event.blockedURI === 'eval' ? 'kEvalViolation' : inline ? 'kInlineViolation' : 'kURLViolation',
      sourceCodeLocation: event.sourceFile
        ? { url: event.sourceFile, lineNumber: event.lineNumber - 1, columnNumber: event.columnNumber - 1 }
        : { url: win.location.href, lineNumber: -1, columnNumber: -1 },
      ...(element && inline ? { violatingNodeId: nodes.backendIdOf(element) } : {}),
    };
    add(`csp ${found.length}`, {
      code: 'ContentSecurityPolicyIssue',
      details: { contentSecurityPolicyIssueDetails: issue },
    });
  });

  if (typeof ReportingObserver === 'function') {
    new ReportingObserver(
      reports => {
        for (const { body } of reports) {
          if (!body) continue;
          const id: unknown = Reflect.get(body, 'id');
          if (typeof id !== 'string') continue;
          const url: unknown = Reflect.get(body, 'sourceFile');
          const line: unknown = Reflect.get(body, 'lineNumber');
          const column: unknown = Reflect.get(body, 'columnNumber');
          add(`deprecation ${found.length}`, {
            code: 'DeprecationIssue',
            details: {
              deprecationIssueDetails: {
                affectedFrame: { frameId: top.id },
                sourceCodeLocation: {
                  url: typeof url === 'string' ? url : win.location.href,
                  lineNumber: typeof line === 'number' ? line - 1 : 0,
                  columnNumber: typeof column === 'number' ? column - 1 : 0,
                },
                type: id,
              },
            },
          });
        }
      },
      { types: ['deprecation'], buffered: true }
    ).observe();
  }

  function quirks(frame: Frame) {
    const doc = frame.document;
    const limited = isLimitedQuirks(doc);
    if (doc.compatMode !== 'BackCompat' && !limited) return;
    const documentNodeId = nodes.backendIdOf(doc);
    add(`quirks ${documentNodeId}`, {
      code: 'QuirksModeIssue',
      details: {
        quirksModeIssueDetails: {
          isLimitedQuirksMode: limited,
          documentNodeId,
          url: doc.URL,
          frameId: frame.id,
          loaderId: frame.loaderId,
        },
      },
    });
  }

  function form(errorType: FormError, el: Element, attribute: string) {
    const violatingNodeId = nodes.backendIdOf(el);
    add(`${errorType} ${violatingNodeId}`, {
      code: 'GenericIssue',
      details: { genericIssueDetails: { errorType, violatingNodeId, violatingNodeAttribute: attribute } },
    });
  }

  function forms(doc: Document) {
    const controls = [...doc.querySelectorAll('input, select, textarea')].filter(isControl);
    const ids = new Map<string, Element[]>();
    for (const el of controls) {
      if (el.id) ids.set(el.id, [...(ids.get(el.id) ?? []), el]);
      else if (!el.getAttribute('name')) form('FormEmptyIdAndNameAttributesForInputError', el, '');
      if (el.getAttribute('autocomplete') === '') form('FormAutocompleteAttributeEmptyError', el, 'autocomplete');
    }
    for (const same of ids.values()) {
      if (same.length > 1) for (const el of same) form('FormDuplicateIdForInputError', el, 'id');
    }
    for (const label of doc.querySelectorAll('label')) {
      const target = label.getAttribute('for');
      if (target === null) {
        if (!label.control) form('FormLabelHasNeitherForNorNestedInputError', label, '');
      } else if (!doc.getElementById(target)) {
        const byName = controls.some(el => el.getAttribute('name') === target);
        form(byName ? 'FormLabelForNameError' : 'FormLabelForMatchesNonExistingIdError', label, 'for');
      }
    }
  }

  function check() {
    scan = 0;
    for (const frame of frames) {
      quirks(frame);
      forms(frame.document);
    }
  }

  session.onReset(() => {
    enabled = false;
    mutations?.disconnect();
    mutations = null;
  });

  session.register('Audits', {
    enable() {
      if (enabled) return;
      for (const issue of found) session.emit('Audits.issueAdded', { issue });
      enabled = true;
      check();
      // Re-checks after the DOM changes, in one go for a burst of changes.
      mutations = new MutationObserver(() => {
        scan ||= win.setTimeout(check, 50);
      });
      mutations.observe(win.document, { subtree: true, childList: true, attributes: true });
    },

    disable() {
      enabled = false;
      mutations?.disconnect();
      mutations = null;
      win.clearTimeout(scan);
      scan = 0;
    },
  });
}
