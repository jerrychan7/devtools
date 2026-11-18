// The Accessibility conformance tests' shared part: a page with accessibility.js loaded on our
// side, and a node of it compared with Chrome's. Case files (`*.html` next to the tests) hold
// pages as groups, each starting with a `<!-- group: name -->` line; the elements marked
// `data-ax-case="<their id>"` are compared one by one.
import { readFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from './conformance.ts';
import type { Env, Side, TestPage } from './conformance.ts';

/** Opens a page whose body is `html`, with our session able to load accessibility.js. */
export async function openAxPage(env: Env, html = ''): Promise<TestPage> {
  const t = await openPage(env, []);
  await t.page.evaluate(base => {
    document.title = 'AX';
    window.__session = window.DevtoolsAnywhere.createCdpSession({
      loadAccessibility: () => import(base + '/packages/devtools-anywhere/dist/accessibility.js'),
    });
  }, env.baseUrl);
  await setBody(t, html);
  // Chrome's whole-tree commands need the domain enabled.
  await Promise.all([t.ours.send('Accessibility.enable'), t.chrome.send('Accessibility.enable')]);
  return t;
}

/** Replaces the body; declarative shadow roots in `html` are attached. */
export async function setBody(t: TestPage, html: string): Promise<void> {
  await t.page.evaluate(html => {
    document.body.setHTMLUnsafe(html);
    // The fixture's own focus would differ between the sides' runs.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, html);
}

/** The DOM node id of `#id` on one side, looked for in shadow roots too. */
export async function nodeIdOf(side: Side, id: string): Promise<number> {
  const { root } = await side.send('DOM.getDocument', { depth: 0 });
  // An id the selector cannot take (a leading digit) is looked for as one in a shadow root.
  const found = await side
    .send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${CSS.escape(id)}` })
    .catch(() => ({ nodeId: 0 }));
  if (found.nodeId) return found.nodeId;
  const { root: tree } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
  const search = (node: Protocol.DOM.Node): number | undefined => {
    const attrs = node.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node.nodeId;
    for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
      const nodeId = search(child);
      if (nodeId) return nodeId;
    }
    return undefined;
  };
  return search(tree) ?? 0;
}

/** CSS.escape for the ids the case files use. */
const CSS = { escape: (id: string) => id.replace(/[^\w-]/g, c => `\\${c}`) };

/** Ids and links between nodes differ between the sides; Chrome's internal role numbers are its own. */
export function comparable(node: Protocol.Accessibility.AXNode): unknown {
  return JSON.parse(
    JSON.stringify(node, (key, value: unknown) =>
      ['nodeId', 'parentId', 'childIds', 'backendDOMNodeId', 'chromeRole', 'frameId'].includes(key) ? undefined : value
    )
  ) as unknown;
}

/** The node and its relatives as roles and names: what the page cannot see (inline text boxes) left out. */
export function outline(nodes: Protocol.Accessibility.AXNode[]): string[] {
  return nodes
    .filter(n => n.role?.value !== 'InlineTextBox')
    .map(n => `${String(n.role?.value)}${n.name ? `:${String(n.name.value)}` : ''}`);
}

/** `#id`'s node on each side (role, name and its sources, description, value, properties), comparable. */
export async function partialNode(t: TestPage, id: string): Promise<{ ours: unknown; chrome: unknown }> {
  const [ours, chrome] = await Promise.all(
    [t.ours, t.chrome].map(async side =>
      (
        await side.send('Accessibility.getPartialAXTree', { nodeId: await nodeIdOf(side, id), fetchRelatives: false })
      ).nodes.map(comparable)
    )
  );
  return { ours, chrome };
}

/** Asserts that `#id`'s node is the same on both sides. */
export async function assertSameNode(t: TestPage, id: string): Promise<void> {
  const { ours, chrome } = await partialNode(t, id);
  assert.deepEqual(ours, chrome);
}

export interface CaseGroup {
  name: string;
  html: string;
  /** The ids of the elements to compare, in document order. */
  ids: string[];
}

/** The groups of a case file. */
export function readCases(url: URL): CaseGroup[] {
  const parts = readFileSync(url, 'utf8').split(/^<!-- group: (.+?) -->\n/m);
  const groups: CaseGroup[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const html = parts[i + 1] ?? '';
    const ids = [...html.matchAll(/\sdata-ax-case="([^"]+)"/g)].map(m => m[1] ?? '');
    groups.push({ name: parts[i] ?? '', html, ids });
  }
  return groups;
}

export interface CaseOptions {
  /** Run in the page after a group's body is set, to build what HTML cannot say (shadow roots set by script…). */
  setups?: Record<string, (() => void) | string>;
  /** Cases known to differ from Chrome: the reason, then the ids it applies to, separated by whitespace. */
  todo?: Record<string, string>;
}

/** One describe per group, one test per case, each case's node compared with Chrome's. */
export function describeCases(groups: CaseGroup[], options: CaseOptions = {}): void {
  let env: Env | undefined;
  let t: TestPage;
  setUpAndTearDown(
    async () => {
      env = await launch();
      t = await openAxPage(env);
    },
    () => env?.close()
  );

  const todo = new Map<string, string>();
  for (const [reason, ids] of Object.entries(options.todo ?? {}))
    for (const id of ids.split(/\s+/).filter(Boolean)) todo.set(id, reason);

  for (const group of groups)
    describe(group.name, () => {
      before(async () => {
        await setBody(t, group.html);
        const setup = options.setups?.[group.name];
        if (setup) await t.page.evaluate(setup);
      });
      for (const id of group.ids) test(`#${id}`, { todo: todo.get(id) }, () => assertSameNode(t, id));
    });
}
